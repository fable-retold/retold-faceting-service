/**
 * Facet-Materializer (internal-contracts §66.2, owner: builder B, port 19142).
 *
 * Unit (no ClickHouse; the in-memory store of test/support/Facet-Store-Fake.js and an in-memory source):
 *   PendingSet add / re-hint / take / ack (a re-hint during the read keeps the entry; LastSeen / Hints
 *   rule), release, Dirty generations, overflow → Dirty; WriterClock monotone above seed, never backwards
 *   across a restart seed; FlushBuffer (due, rows, one cycle across targets, the key overlay); the
 *   WriterLoop's diff (insert, update, soft delete → tombstone, hard delete → tombstone, undelete, tenant
 *   move, owner move, quarantine, Lossy flags, a row moved twice inside one flush window leaves no ghost);
 *   one flush = one mirror INSERT carrying rows + tombstones, the K / M / R order, tokens
 *   '<E>:<FlushID>:<Target>:<Phase><i>'; flush failure → hints released, a new cycle with a higher
 *   version and a fresh read; ack only after every target succeeded; the superset invariant under a
 *   failure between the inserts; Resync (Dirty) with a hard-deleted tail; Range tasks; rebuilds (first
 *   enable RENAME, the dual-write window, abort); the crash hook; Freshness (state machine, Exact / LagMS /
 *   AppliedSeq, the §61.3 admission table cell by cell, the breaker, NoChangeSource); the Materializer
 *   (event → pending mapping of §58.2, filter resolution, AppliedSeq only after the ack, start → backfill
 *   → Live, quiesce, stop writes CleanShutdown = 1 only when drained, crash() writes nothing, an unclean
 *   restart → Unverified, wipe recovery).
 *   MaterializeSource-InProcess on a SQLite ProjectTrack harness: soft-deleted rows seen, no behavior ever
 *   runs, explicit projection and cap, keyset ranges, sweep, checksums over live rows, idsByFilter.
 *
 * ClickHouse-gated (RFS_TEST_CLICKHOUSE=1): a SQLite ProjectTrack harness with the real store: CRUD writes
 * reach the mirror (assertMirrorEqualsSource after quiesce); a restart with CleanShutdown = 0 → Unverified.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libFakeStore = require('./support/Facet-Store-Fake.js');
const libRetoldFacetingMaterializer = require('../source/persistence/Retold-Faceting-Materializer.js');
const libRetoldFacetingWriterLoop = require('../source/persistence/Retold-Faceting-WriterLoop.js');
const libRetoldFacetingWriterClock = require('../source/persistence/Retold-Faceting-WriterClock.js');
const libRetoldFacetingPendingSet = require('../source/persistence/Retold-Faceting-PendingSet.js');
const libRetoldFacetingFlushBuffer = require('../source/persistence/Retold-Faceting-FlushBuffer.js');
const libRetoldFacetingMaterializeSourceInProcess = require('../source/persistence/MaterializeSource-InProcess.js');
const libRetoldFacetingFreshness = require('../source/persistence/Retold-Faceting-Freshness.js');
const libRetoldFacetingRebuilder = require('../source/persistence/Retold-Faceting-Rebuilder.js');
const libRetoldFacetingReconciler = require('../source/persistence/Retold-Faceting-Reconciler.js');
const libRetoldFacetingMirrorSpec = require('../source/persistence/Retold-Faceting-MirrorSpec.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const PORT = 19142;

const libProviders = require('./support/Facet-Harness-Providers.js');
const POSTGRES = libProviders.available('PostgreSQL');
const PROVIDERS =
	[
		{ Provider: 'SQLite', Ready: true, Reason: null },
		{ Provider: 'PostgreSQL', Ready: POSTGRES.Available, Reason: POSTGRES.Reason }
	];

const EPOCH = 'e:0000abcd';

const STORE = 'ClickHouse';

// A Personal entity (tenant + owner), every value kind the type map handles.
const WIDGET_SPEC = Object.freeze(
	{
		Entity: 'Widget',
		Store: STORE,
		Identity: 'IDWidget',
		Kind: 'Personal',
		TenantColumn: 'IDCustomer',
		OwnerColumn: 'OwnerIDUser',
		RequiredColumns: [],
		DeleteColumn: 'Deleted',
		SortKey: [ 'IDCustomer', 'OwnerIDUser', 'IDWidget' ],
		Columns:
			[
				{ Column: 'IDWidget', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
				{ Column: 'IDCustomer', DataType: 'Numeric', Mirror: 'Int64', Role: 'Tenant' },
				{ Column: 'OwnerIDUser', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'Owner' },
				{ Column: 'Deleted', DataType: 'Boolean', Mirror: 'Nullable(UInt8)', Role: 'Delete' },
				{ Column: 'UpdateDate', DataType: 'DateTime', Mirror: 'Nullable(DateTime64(3, \'UTC\'))', Role: 'Watermark' },
				{ Column: 'IDGroup', DataType: 'ForeignKey', Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDGroup' },
				{ Column: 'Status', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' },
				{ Column: 'Amount', DataType: 'Decimal', Mirror: 'Nullable(Float64)', Role: 'Column' }
			],
		ColumnNames: [ 'Amount', 'Deleted', 'IDCustomer', 'IDGroup', 'IDWidget', 'OwnerIDUser', 'Status', 'UpdateDate' ],
		KeymapColumns: [ 'IDWidget', 'IDCustomer', 'OwnerIDUser', 'IDGroup', 'UpdateDate' ],
		TrackedKeyColumns: [ 'IDCustomer', 'OwnerIDUser', 'IDGroup' ],
		SourceColumns: [ 'IDWidget', 'IDCustomer', 'OwnerIDUser', 'Deleted', 'UpdateDate', 'IDGroup', 'Status', 'Amount' ],
		Watermark: 'UpdateDate',
		UnsetValues: [ 0, '', null ],
		SpecHash: 'ms:0badc0de'
	});

/**
 * A source row of the Widget entity.
 *
 * @param {number} pID
 * @param {Record<string, any>} [pOverrides]
 * @return {Record<string, any>}
 */
const widget = (pID, pOverrides) =>
{
	return Object.assign({ IDWidget: pID, IDCustomer: 1, OwnerIDUser: 42, Deleted: 0, UpdateDate: '2026-01-01 00:00:00', IDGroup: 5, Status: 'Open', Amount: 1.5 }, pOverrides || {});
};

/**
 * An in-memory MaterializeSource (the loop's trusted reader) over a Map of rows.
 */
class FakeSource
{
	constructor()
	{
		this.Rows = new Map();
		this.Reads = 0;
		this.FailNext = null;
		this.BeforeRead = null;
	}

	put(pRow)
	{
		this.Rows.set(pRow.IDWidget, Object.assign({}, pRow));
	}

	remove(pID)
	{
		this.Rows.delete(pID);
	}

	_fail(fCallback)
	{
		if (this.FailNext)
		{
			let tmpError = this.FailNext;
			this.FailNext = null;
			setImmediate(() => { fCallback(tmpError); });
			return true;
		}
		return false;
	}

	readRows(pEntity, pIDs, pOptions, fCallback)
	{
		this.Reads++;
		if (this._fail(fCallback))
		{
			return;
		}
		if (this.BeforeRead)
		{
			this.BeforeRead();
		}
		let tmpRows = pIDs.filter((pID) => { return this.Rows.has(pID); }).map((pID) => { return Object.assign({}, this.Rows.get(pID)); });
		setImmediate(() => { fCallback(null, tmpRows); });
	}

	readRange(pEntity, pAfterID, pCap, pOptions, fCallback)
	{
		this.Reads++;
		if (this._fail(fCallback))
		{
			return;
		}
		let tmpToID = (pOptions && (pOptions.ToID !== null) && (pOptions.ToID !== undefined)) ? pOptions.ToID : null;
		let tmpRows = Array.from(this.Rows.keys()).sort((pA, pB) => { return pA - pB; })
			.filter((pID) => { return ((pAfterID === null) || (pID > pAfterID)) && ((tmpToID === null) || (pID <= tmpToID)); })
			.slice(0, pCap)
			.map((pID) => { return Object.assign({}, this.Rows.get(pID)); });
		setImmediate(() => { fCallback(null, tmpRows); });
	}

	_live(pRow)
	{
		return (pRow.Deleted === 0) && (pRow.IDCustomer !== 0) && (pRow.IDCustomer !== null);
	}

	readIDs(pEntity, pAfterID, pToID, fCallback)
	{
		let tmpIDs = Array.from(this.Rows.keys()).sort((pA, pB) => { return pA - pB; })
			.filter((pID) => { return ((pAfterID === null) || (pID > pAfterID)) && ((pToID === null) || (pID <= pToID)); })
			.map((pID) => { return { ID: pID, Live: this._live(this.Rows.get(pID)) }; });
		setImmediate(() => { fCallback(null, tmpIDs); });
	}

	checksums(pEntity, pLeafRange, fCallback)
	{
		let tmpBuckets = {};
		this.Rows.forEach(
			(pRow, pID) =>
			{
				if (!this._live(pRow))
				{
					return;
				}
				let tmpBucket = String(Math.floor(pID / pLeafRange));
				tmpBuckets[tmpBucket] = tmpBuckets[tmpBucket] || { Count: 0, IDSum: 0 };
				tmpBuckets[tmpBucket].Count++;
				tmpBuckets[tmpBucket].IDSum += pID;
			});
		setImmediate(() => { fCallback(null, tmpBuckets); });
	}

	sweep(pEntity, pOptions, fCallback)
	{
		let tmpFrom = pOptions.From || { At: null, ID: null };
		let tmpRows = Array.from(this.Rows.values()).filter((pRow) => { return pRow.UpdateDate !== null; })
			.map((pRow) => { return { ID: pRow.IDWidget, At: pRow.UpdateDate }; })
			.sort((pA, pB) => { return (pA.At < pB.At) ? -1 : ((pA.At > pB.At) ? 1 : (pA.ID - pB.ID)); })
			.filter((pRow) => { return (tmpFrom.At === null) || (pRow.At > tmpFrom.At) || ((pRow.At === tmpFrom.At) && (pRow.ID > (tmpFrom.ID || 0))); })
			.slice(0, pOptions.Cap);
		let tmpNext = (tmpRows.length >= pOptions.Cap) ? { At: tmpRows[tmpRows.length - 1].At, ID: tmpRows[tmpRows.length - 1].ID } : null;
		setImmediate(() => { fCallback(null, { Rows: tmpRows, Next: tmpNext }); });
	}

	idsByFilter(pEntity, pEntries, pOptions, fCallback)
	{
		// Test filters: [ { Column, Operator: '=', Value } … ] ANDed.
		let tmpIDs = Array.from(this.Rows.values()).filter((pRow) => { return pEntries.every((pEntry) => { return pRow[pEntry.Column] === pEntry.Value; }); }).map((pRow) => { return pRow.IDWidget; });
		setImmediate(() => { fCallback(null, tmpIDs); });
	}

	dialect()
	{
		return 'SQLite';
	}
}

/**
 * Resolved options for the unit tests: the flush interval long (flushes are explicit) unless given.
 *
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const unitOptions = (pExtra) =>
{
	return libOptions.resolve(libOptions.deepMerge(
		{
			Stores: { ClickHouse: { URL: 'http://fake.invalid:1', Database: 'rfs_fake' } },
			Materialize: { Widget: { Store: [ STORE ] } },
			// StreamDelayMS 0: a cycle per hint, buffered until an explicit flush (these tests drive the cycle /
			// flush mechanics; the batched default has its own test).
			Materializer: { FlushIntervalMS: 60000, IdleTickMS: 5, RebuildPageSize: 4, BatchIDs: 2000, MaxBackoffMS: 20, StreamDelayMS: 0, PromptRangeKinds: [ 'Resync', 'Scrub', 'Fill', 'RebuildPage' ] },
			Reconcile: { AutoStart: false, LeafRange: 10 }
		}, pExtra || {}));
};

/**
 * A loop over the fake store and the fake source (live tables created up front unless NoLive).
 *
 * @param {{ Options?: Record<string, any>, NoLive?: boolean, Spec?: Record<string, any> }} [pSetup]
 * @param {(pKit: Record<string, any>) => void} fCallback
 */
const newLoopKit = (pSetup, fCallback) =>
{
	let tmpSetup = pSetup || {};
	let tmpOptions = tmpSetup.Options || unitOptions();
	let tmpFable = libBuilders.newFable();
	tmpFable.RetoldFacetingChangeIntake = { NodeEpoch: EPOCH, covers: () => { return true; } };
	let tmpKit = (
		{
			Fable: tmpFable,
			Options: tmpOptions,
			Spec: tmpSetup.Spec || WIDGET_SPEC,
			Store: new libFakeStore({ Database: 'rfs_fake' }),
			Source: new FakeSource(),
			Clock: new libRetoldFacetingWriterClock(tmpFable, tmpOptions, STORE),
			PendingSet: new libRetoldFacetingPendingSet(tmpFable, tmpOptions, 'ClickHouse:Widget'),
			FlushBuffer: new libRetoldFacetingFlushBuffer(tmpFable, tmpOptions, 'ClickHouse:Widget'),
			Loop: new libRetoldFacetingWriterLoop(tmpFable, tmpOptions, 'ClickHouse:Widget'),
			Flushed: [],
			Swapped: []
		});
	tmpKit.hint = (pIDs, pSeqN) =>
	{
		pIDs.forEach((pID) => { tmpKit.PendingSet.add(pID, (typeof(pSeqN) === 'number') ? pSeqN : null, tmpKit.Loop.monotonicNow()); });
		tmpKit.Loop.kick();
	};
	// Wait until the loop has nothing runnable left (cycles done), then flush and wait for the ack.
	tmpKit.settle = (fDone) =>
	{
		let fWait = () =>
		{
			if (tmpKit.Loop.working())
			{
				return setTimeout(fWait, 2);
			}
			tmpKit.Loop.flush((pError) => { return fDone(pError); });
		};
		setTimeout(fWait, 2);
	};
	tmpKit.mirror = (pTarget) => { return tmpKit.Store.mirror('Widget', pTarget).sort((pA, pB) => { return pA.IDWidget - pB.IDWidget; }); };
	tmpKit.keymap = (pTarget) => { return tmpKit.Store.keymap('Widget', pTarget).sort((pA, pB) => { return pA.IDWidget - pB.IDWidget; }); };
	tmpKit.Store.ensureSchema({ Widget: tmpKit.Spec },
		() =>
		{
			let fAttach = () =>
			{
				tmpKit.Loop.attach(
					{
						StoreName: STORE,
						Entity: 'Widget',
						Store: tmpKit.Store,
						Spec: tmpKit.Spec,
						Clock: tmpKit.Clock,
						PendingSet: tmpKit.PendingSet,
						FlushBuffer: tmpKit.FlushBuffer,
						Source: tmpKit.Source,
						Freshness: null,
						Targets: tmpSetup.NoLive ? [] : [ 'Live' ],
						onFlushed: (pLoop, pInfo, fDone) => { tmpKit.Flushed.push(pInfo); return fDone(); },
						onSwapped: (pLoop, pInfo) => { tmpKit.Swapped.push(pInfo); },
						onWipe: () => { tmpKit.Wiped = (tmpKit.Wiped || 0) + 1; }
					});
				return fCallback(tmpKit);
			};
			if (tmpSetup.NoLive)
			{
				return fAttach();
			}
			tmpKit.Store.createLive('Widget', tmpKit.Spec, fAttach);
		});
};

/**
 * The (tenant, owner) keys of the live rows of an ID.
 *
 * @param {Array<Record<string, any>>} pRows
 * @param {number} pID
 * @return {Array<string>}
 */
const keysOf = (pRows, pID) =>
{
	return pRows.filter((pRow) => { return pRow.IDWidget === pID; }).map((pRow) => { return `${pRow.IDCustomer}/${pRow.OwnerIDUser}`; }).sort();
};

suite
(
	'Facet-Materializer',
	() =>
	{
		suite
		(
			'PendingSet (§58.3)',
			() =>
			{
				let newSet = (pOverflow) =>
				{
					return new libRetoldFacetingPendingSet(libBuilders.newFable(), libOptions.resolve({ Materializer: { OverflowIDs: pOverflow || 100000 } }), 'S:E');
				};

				test('M5 review: in-flight entries are queued apart — take() hands out only available entries (oldest first, O(taken)); released and kept entries rejoin in FirstSeen order; oldestAvailableFirstSeen',
					() =>
					{
						let tmpSet = newSet();
						for (let i = 1; i <= 6; i++)
						{
							tmpSet.add(i, i, 100 + i);
						}
						let tmpFirst = tmpSet.take(3);
						Expect(tmpFirst.map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 1, 2, 3 ]);
						Expect(tmpSet.available()).to.equal(3);
						Expect(tmpSet.oldestAvailableFirstSeen()).to.equal(104);
						// the next take never revisits the in-flight head
						Expect(tmpSet.take(10).map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 4, 5, 6 ]);
						Expect(tmpSet.available()).to.equal(0);
						Expect(tmpSet.oldestAvailableFirstSeen()).to.equal(null);
						// 2 re-hinted in flight (kept by the ack), 1 released, 3 acked away
						tmpSet.add(2, 20, 200);
						tmpSet.release([ tmpFirst[0] ]);
						tmpSet.ack(tmpFirst.slice(1), 150);
						Expect(tmpSet.has(3)).to.equal(false);
						Expect(tmpSet.available()).to.equal(2);
						// 1 kept its FirstSeen (101); 2's restarts from its re-hint (200)
						Expect(tmpSet.take(10).map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 1, 2 ]);
						Expect(tmpSet.info()).to.deep.include({ Pending: 0, InFlight: 5 });
					});

				test('add / re-hint / take / ack: the LastSeen and Hints rule keeps a change that arrived during the read',
					() =>
					{
						let tmpSet = newSet();
						tmpSet.add(1, 10, 100);
						tmpSet.add(2, 11, 101);
						tmpSet.add(3, null, 102);
						tmpSet.add(1, 9, 103);
						Expect(tmpSet.size()).to.equal(3);
						let tmpInfo = tmpSet.info();
						Expect(tmpInfo).to.deep.include({ Pending: 3, InFlight: 0, OldestFirstSeen: 100, MinSeqN: 9, Overflow: false, Dirty: null });

						let tmpTaken = tmpSet.take(2);
						Expect(tmpTaken.map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 1, 2 ]);
						Expect(tmpTaken[0].Snapshot).to.deep.equal({ LastSeen: 103, Hints: 2, MinSeqN: 9 });
						Expect(tmpSet.inFlight()).to.equal(2);
						Expect(tmpSet.available()).to.equal(1);
						// take never hands out an in-flight entry
						Expect(tmpSet.take(5).map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 3 ]);

						// a re-hint of ID 2 while its read is in flight
						tmpSet.add(2, 20, 150);
						tmpSet.ack(tmpTaken, 120);
						Expect(tmpSet.has(1)).to.equal(false);
						Expect(tmpSet.has(2)).to.equal(true);
						Expect(tmpSet.inFlight()).to.equal(1);
						let tmpAfter = tmpSet.info();
						// lag and AppliedSeq restart from the re-hint
						Expect(tmpSet._Entries.get(2).FirstSeen).to.equal(150);
						Expect(tmpSet._Entries.get(2).MinSeqN).to.equal(20);
						Expect(tmpAfter.MinSeqN).to.equal(20);
					});

				test('ack keeps an entry whose LastSeen is after the read start even with equal Hints; release returns a batch unchanged',
					() =>
					{
						let tmpSet = newSet();
						tmpSet.add(7, 1, 100);
						let tmpTaken = tmpSet.take(10);
						// read started before the hint was last seen (a clock tie-break case)
						Expect(tmpSet.ack(tmpTaken, 99)).to.equal(0);
						Expect(tmpSet.has(7)).to.equal(true);
						Expect(tmpSet.inFlight()).to.equal(0);
						let tmpAgain = tmpSet.take(10);
						tmpSet.release(tmpAgain);
						Expect(tmpSet.inFlight()).to.equal(0);
						Expect(tmpSet._Entries.get(7)).to.deep.include({ FirstSeen: 100, LastSeen: 100, Hints: 1, MinSeqN: 1 });
						let tmpThird = tmpSet.take(10);
						Expect(tmpSet.ack(tmpThird, 100)).to.equal(1);
						Expect(tmpSet.size()).to.equal(0);
					});

				test('take is oldest-FirstSeen first, also after an ack moved a re-hinted entry forward',
					() =>
					{
						let tmpSet = newSet();
						tmpSet.add(1, null, 10);
						tmpSet.add(2, null, 20);
						let tmpTaken = tmpSet.take(1);
						tmpSet.add(1, null, 40);
						tmpSet.add(3, null, 30);
						tmpSet.ack(tmpTaken, 15);
						// 1 now has FirstSeen 40: after 2 (20) and 3 (30)
						Expect(tmpSet.take(10).map((pEntry) => { return pEntry.ID; })).to.deep.equal([ 2, 3, 1 ]);
					});

				test('Dirty generations: an existing mark keeps Since and the lowest Seq; clearDirty only for the current generation',
					() =>
					{
						let tmpSet = newSet();
						let tmpFirst = tmpSet.markDirty(8, [ 1 ], 100);
						let tmpSecond = tmpSet.markDirty(5, [ 2 ], 200);
						Expect(tmpSecond).to.be.above(tmpFirst);
						Expect(tmpSet.dirty()).to.deep.include({ Since: 100, MinSeqN: 5, Generation: tmpSecond });
						Expect(tmpSet.dirty().Tenants).to.deep.equal([ 1, 2 ]);
						Expect(tmpSet.clearDirty(tmpFirst)).to.equal(false);
						Expect(tmpSet.dirty()).to.not.equal(null);
						Expect(tmpSet.clearDirty(tmpSecond)).to.equal(true);
						Expect(tmpSet.dirty()).to.equal(null);
						Expect(tmpSet.clearDirty(tmpSecond)).to.equal(false);
					});

				test('overflow: beyond OverflowIDs the pending (not in-flight) entries collapse into a whole-entity Resync',
					() =>
					{
						let tmpSet = newSet(3);
						tmpSet.add(1, 4, 10);
						tmpSet.add(2, 3, 11);
						let tmpTaken = tmpSet.take(1);
						tmpSet.add(3, 6, 12);
						tmpSet.add(4, 7, 13);
						Expect(tmpSet.info().Overflow).to.equal(false);
						tmpSet.add(5, 9, 14);
						let tmpInfo = tmpSet.info();
						Expect(tmpInfo.Overflow).to.equal(true);
						Expect(tmpInfo.Dirty).to.deep.include({ Since: 11, MinSeqN: 3 });
						// the in-flight entry survives (its ack is still due), the new one is accepted
						Expect(tmpSet.has(1)).to.equal(true);
						Expect(tmpSet.has(5)).to.equal(true);
						Expect(tmpSet.has(2)).to.equal(false);
						tmpSet.ack(tmpTaken, 100);
						Expect(tmpSet.size()).to.equal(1);
						Expect(tmpSet.clearDirty(tmpInfo.Dirty.Generation)).to.equal(true);
						Expect(tmpSet.info().Overflow).to.equal(false);
					});
			}
		);

		suite
		(
			'WriterClock (§58.4)',
			() =>
			{
				test('the B services construct (and register nothing until asked)',
					() =>
					{
						let tmpFable = libBuilders.newFable();
						[ libRetoldFacetingMaterializer, libRetoldFacetingWriterLoop, libRetoldFacetingPendingSet, libRetoldFacetingFlushBuffer, libRetoldFacetingMaterializeSourceInProcess, libRetoldFacetingFreshness, libRetoldFacetingWriterClock ].forEach(
							(pClass) =>
							{
								let tmpService = new pClass(tmpFable, {});
								Expect(tmpService.serviceType).to.equal(pClass.serviceType);
							});
						Expect(libRetoldFacetingWriterLoop.WORK_KINDS).to.deep.equal([ 'Stream', 'Resync', 'Scrub', 'Fill', 'RebuildPage' ]);
						Expect(libRetoldFacetingWriterLoop.TEST_HOOKS).to.deep.equal([ 'afterRead', 'afterFlushBeforeAck', 'beforeSwap' ]);
						Expect(libRetoldFacetingMaterializer.HINT_SOURCES).to.include('Filter');
						Expect(libRetoldFacetingMaterializeSourceInProcess.toID(' 12 ')).to.equal(12);
						Expect(libRetoldFacetingMaterializeSourceInProcess.toID('1.5')).to.equal(null);
						Expect(libRetoldFacetingMaterializeSourceInProcess.isZero('0')).to.equal(true);
						Expect(libRetoldFacetingMaterializeSourceInProcess.isZero('false')).to.equal(false);
						Expect(libRetoldFacetingMaterializeSourceInProcess.isZero(null)).to.equal(false);
						Expect(libRetoldFacetingMaterializeSourceInProcess.atText(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).to.equal('2026-01-02 03:04:05.006');
						// nothing runs: no timers, no store, an unattached loop is quiet
						let tmpLoop = new libRetoldFacetingWriterLoop(tmpFable, {});
						Expect(tmpLoop.quiet()).to.equal(true);
						Expect(tmpLoop.working()).to.equal(false);
						Expect(tmpLoop.targets()).to.deep.equal([]);
					});

				test('monotone, above the seeded floor, never backwards across a restart seed',
					() =>
					{
						let tmpFable = libBuilders.newFable();
						let tmpClock = new libRetoldFacetingWriterClock(tmpFable, {}, STORE);
						let tmpLast = 0;
						for (let i = 0; i < 1000; i++)
						{
							let tmpNext = tmpClock.next();
							Expect(tmpNext).to.be.above(tmpLast);
							Expect(Number.isSafeInteger(tmpNext)).to.equal(true);
							tmpLast = tmpNext;
						}
						// a store whose max(_Version) is ahead of this host's clock (skew, a restore)
						let tmpFloor = tmpLast + 5e9;
						tmpClock.seed(tmpFloor);
						Expect(tmpClock.next()).to.equal(tmpFloor + 1);
						// a restart: a new clock seeded from the store's maximum never goes back
						let tmpRestarted = new libRetoldFacetingWriterClock(tmpFable, {}, STORE);
						tmpRestarted.seed(tmpClock.Last);
						Expect(tmpRestarted.next()).to.be.above(tmpClock.Last);
						Expect(tmpRestarted.seed(1)).to.be.above(tmpFloor);
					});
			}
		);

		suite
		(
			'FlushBuffer (§58.6)',
			() =>
			{
				test('due by interval or rows; one cycle across two targets counts once; take empties; the key overlay replays intents and retirements in cycle order',
					() =>
					{
						let tmpBuffer = new libRetoldFacetingFlushBuffer(libBuilders.newFable(), libOptions.resolve({ Materializer: { FlushIntervalMS: 100, FlushRows: 3 } }), 'S:E');
						tmpBuffer.setKeyColumns('IDWidget', [ 'IDCustomer', 'OwnerIDUser' ]);
						Expect(tmpBuffer.due(1000)).to.equal(false);
						let tmpCycle = { Version: 77, ReadStart: 1, Taken: [] };
						tmpBuffer.append('Live', { Rows: [ { IDWidget: 1, IDCustomer: 1, OwnerIDUser: 2, _Version: 77 } ], Tombstones: [], KeyIntents: [ { IDWidget: 1, IDCustomer: 1, OwnerIDUser: 2, _Version: 77 } ], KeyRetires: [] }, tmpCycle, 1000);
						tmpBuffer.append('Shadow:0a1b2c3d', { Rows: [ { IDWidget: 1 } ], Tombstones: [], KeyIntents: [], KeyRetires: [] }, tmpCycle, 1000);
						Expect(tmpBuffer.size()).to.equal(1);
						Expect(tmpBuffer.rows()).to.equal(2);
						Expect(tmpBuffer.due(1050)).to.equal(false);
						Expect(tmpBuffer.dueInMS(1050)).to.equal(50);
						Expect(tmpBuffer.due(1100)).to.equal(true);
						Expect(tmpBuffer.hasTaskCycle()).to.equal(false);

						// overlay: the store says (1,1); the buffer moved it to (1,2) then (2,2)
						let tmpCycle2 = { Version: 78 };
						tmpBuffer.append('Live', { Rows: [], Tombstones: [], KeyIntents: [ { IDWidget: 1, IDCustomer: 2, OwnerIDUser: 2, _Version: 78 } ], KeyRetires: [ { IDWidget: 1, IDCustomer: 1, OwnerIDUser: 2, _Version: 78 } ] }, tmpCycle2, 1001);
						let tmpKeys = tmpBuffer.keys('Live', 1, [ { Key: { IDCustomer: 1, OwnerIDUser: 1 }, Version: 5 } ]);
						Expect(tmpKeys.map((pKey) => { return `${pKey.Key.IDCustomer}/${pKey.Key.OwnerIDUser}`; }).sort()).to.deep.equal([ '1/1', '2/2' ]);
						Expect(tmpBuffer.bufferedIDs('Live')).to.deep.equal([ 1 ]);
						// integer text from a store and numbers agree
						Expect(libRetoldFacetingFlushBuffer.keyText([ 'A', 'B' ], { A: '7', B: null })).to.equal(libRetoldFacetingFlushBuffer.keyText([ 'A', 'B' ], { A: 7 }));

						// FlushRows makes it due at once
						tmpBuffer.append('Live', { Rows: [ { IDWidget: 9 } ], Tombstones: [ { IDWidget: 10 } ], KeyIntents: [], KeyRetires: [] }, { Version: 79, Task: { Kind: 'Scrub' } }, 1002);
						Expect(tmpBuffer.rows()).to.equal(4);
						Expect(tmpBuffer.due(1002)).to.equal(true);
						Expect(tmpBuffer.hasTaskCycle()).to.equal(true);

						tmpBuffer.dropTarget('Shadow:0a1b2c3d');
						Expect(tmpBuffer.rows()).to.equal(3);
						let tmpTaken = tmpBuffer.take();
						Expect(tmpTaken.FlushID).to.equal('77');
						Expect(tmpTaken.Cycles.length).to.equal(3);
						Expect(Object.keys(tmpTaken.Targets)).to.deep.equal([ 'Live' ]);
						Expect(tmpTaken.Targets.Live.KeyIntents.length).to.equal(2);
						Expect(tmpBuffer.size()).to.equal(0);
						Expect(tmpBuffer.rows()).to.equal(0);
						Expect(tmpBuffer.keys('Live', 1, []).length).to.equal(0);
					});
			}
		);

		suite
		(
			'WriterLoop against the fake store (§58.5, §58.6)',
			() =>
			{
				test('M5 review: batched stream cycles — hints wait for company (StreamDelayMS Auto = the flush interval) and the flush follows the cycle at once: 20 writes = one source read, one keymap read, one insert set',
					(fDone) =>
					{
						newLoopKit({ Options: unitOptions({ Materializer: { FlushIntervalMS: 150, StreamDelayMS: 'Auto', PromptRangeKinds: [ 'Resync', 'RebuildPage' ] } }) },
							(K) =>
							{
								for (let i = 1; i <= 20; i++)
								{
									K.Source.put(widget(i));
								}
								let tmpReads = K.Source.Reads;
								let tmpKeyReads = 0;
								let fReadKeys = K.Store.readKeys;
								K.Store.readKeys = function (...pArguments) { tmpKeyReads++; return fReadKeys.apply(this, pArguments); };
								let tmpIndex = 0;
								let tmpTimer = setInterval(
									() =>
									{
										tmpIndex++;
										K.hint([ tmpIndex ]);
										if (tmpIndex >= 20)
										{
											clearInterval(tmpTimer);
										}
									}, 3);
								let fWait = () =>
								{
									if ((tmpIndex < 20) || (K.PendingSet.size() > 0) || (K.FlushBuffer.size() > 0))
									{
										return setTimeout(fWait, 10);
									}
									Expect(K.mirror().length).to.equal(20);
									Expect(K.Loop.stats().StreamCycles, 'stream cycles').to.be.at.most(2);
									Expect(K.Loop.stats().Flushes, 'flushes').to.be.at.most(2);
									Expect(K.Source.Reads - tmpReads, 'source reads').to.be.at.most(2);
									Expect(tmpKeyReads, 'keymap reads').to.be.at.most(2);
									return fDone();
								};
								setTimeout(fWait, 10);
							});
					});

				test('M5 review: under the default PromptRangeKinds a Scrub page waits for the flush interval (no prompt insert per tick); a RebuildPage / Resync page flushes as soon as nothing else runs',
					(fDone) =>
					{
						newLoopKit({ Options: unitOptions({ Materializer: { FlushIntervalMS: 400, PromptRangeKinds: [ 'Resync', 'RebuildPage' ] } }) },
							(K) =>
							{
								K.Source.put(widget(1));
								K.Source.put(widget(2));
								let tmpStart = Date.now();
								K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Live', AfterID: null, ToID: null, Cap: 10 },
									(pError) =>
									{
										Expect(pError).to.not.exist;
										Expect(Date.now() - tmpStart, 'the Scrub page waited for the interval').to.be.at.least(350);
										Expect(K.mirror().length).to.equal(2);
										return fDone();
									});
								setTimeout(() => { Expect(K.Loop.stats().Flushes).to.equal(0); }, 150);
							});
					});

				test('M5 review: setSpec never retargets tables whose layout did not change — a pinned live spec survives a second reload; a shadow keeps the spec it was created with; a swap after a reload pins the live tables to the shadow\'s spec (Current false)',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								let tmpOld = K.Spec;
								let tmpNew = Object.assign({}, tmpOld, { SpecHash: 'ms:0000000b' });
								let tmpNewer = Object.assign({}, tmpOld, { SpecHash: 'ms:0000000c' });
								K.Loop.setSpec(tmpNew, { KeepLiveSpec: true });
								Expect(K.Loop.specFor('Live')).to.equal(tmpOld);
								// A second reload (the same new spec, or an additive one): the live pin stays.
								K.Loop.setSpec(tmpNew, {});
								Expect(K.Loop.specFor('Live'), 'pinned through a second reload').to.equal(tmpOld);
								K.Loop.beginRebuild('0a1b2c3d', false,
									(pBeginError) =>
									{
										Expect(pBeginError).to.not.exist;
										Expect(K.Loop.specFor('Shadow:0a1b2c3d')).to.equal(tmpNew);
										// The model changes again while the rebuild pages: the shadow keeps its spec.
										K.Loop.setSpec(tmpNewer, { KeepLiveSpec: true });
										Expect(K.Loop.specFor('Live')).to.equal(tmpOld);
										Expect(K.Loop.specFor('Shadow:0a1b2c3d')).to.equal(tmpNew);
										K.Loop.finishRebuild('0a1b2c3d',
											(pSwapError) =>
											{
												Expect(pSwapError).to.not.exist;
												Expect(K.Loop.specFor('Live'), 'the live tables now hold the shadow layout').to.equal(tmpNew);
												Expect(K.Swapped[K.Swapped.length - 1]).to.deep.include({ BuildID: '0a1b2c3d', Current: false });
												// A LiveChanged spec (attach, an additive ALTER) drops every pin.
												K.Loop.setSpec(tmpNewer, { LiveChanged: true });
												Expect(K.Loop.specFor('Live')).to.equal(tmpNewer);
												return fDone();
											});
									});
							});
					});

				test('M5 review: Lossy flags follow the rows — a corrected value (or a tombstoned row) clears its column; a seeded (sticky) flag clears after a full rotation that started later',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1, { Amount: 'lots' }));
								K.Source.put(widget(2, { Amount: 'many' }));
								K.hint([ 1, 2 ]);
								K.settle(
									() =>
									{
										Expect(K.Loop.lossy()).to.deep.equal({ Amount: 'Value' });
										K.Source.put(widget(1, { Amount: 2.5 }));
										K.hint([ 1 ]);
										K.settle(
											() =>
											{
												Expect(K.Loop.lossy(), 'one lossy row left').to.deep.equal({ Amount: 'Value' });
												K.Source.remove(2);
												K.hint([ 2 ]);
												K.settle(
													() =>
													{
														Expect(K.Loop.lossy(), 'the last lossy row left the mirror').to.deep.equal({});
														// A flag seeded from the state row (its rows unknown) sticks until a later full rotation.
														K.Loop.seedLossy({ Status: 'Compare' });
														Expect(K.Loop.lossy()).to.deep.equal({ Status: 'Compare' });
														Expect(K.Loop.clearStickyLossy(Date.now() - 60000), 'a rotation that started before the seed').to.equal(false);
														Expect(K.Loop.clearStickyLossy(Date.now() + 1)).to.equal(true);
														Expect(K.Loop.lossy()).to.deep.equal({});
														return fDone();
													});
											});
									});
							});
					});

				test('insert, update, soft delete, undelete, hard delete: the mirror FINAL follows the source; the keymap follows the mirror',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.Source.put(widget(2, { Status: 'Closed' }));
								K.hint([ 1, 2 ]);
								K.settle(
									(pError) =>
									{
										Expect(pError).to.not.exist;
										Expect(K.mirror().map((pRow) => { return [ pRow.IDWidget, pRow.Status, pRow._IsDeleted ]; })).to.deep.equal([ [ 1, 'Open', 0 ], [ 2, 'Closed', 0 ] ]);
										Expect(K.keymap().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2 ]);
										// update
										K.Source.put(widget(1, { Status: 'Done', Amount: 2.25 }));
										// soft delete
										K.Source.put(widget(2, { Deleted: 1 }));
										K.hint([ 1, 2 ]);
										K.settle(
											() =>
											{
												Expect(K.mirror().map((pRow) => { return [ pRow.IDWidget, pRow.Status, pRow.Amount ]; })).to.deep.equal([ [ 1, 'Done', 2.25 ] ]);
												Expect(K.keymap().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1 ]);
												// undelete 2, hard delete 1
												K.Source.put(widget(2, { Deleted: 0, Status: 'Back' }));
												K.Source.remove(1);
												K.hint([ 1, 2 ]);
												K.settle(
													() =>
													{
														Expect(K.mirror().map((pRow) => { return [ pRow.IDWidget, pRow.Status ]; })).to.deep.equal([ [ 2, 'Back' ] ]);
														Expect(K.keymap().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 2 ]);
														// a missing source row with no key: nothing at all
														let tmpBefore = K.Store.Inserts.length;
														K.hint([ 999 ]);
														K.settle(
															() =>
															{
																Expect(K.Store.Inserts.length).to.equal(tmpBefore);
																Expect(K.PendingSet.size()).to.equal(0);
																return fDone();
															});
													});
											});
									});
							});
					});

				test('tenant move and owner move: one row at the new key, the old key tombstoned and retired',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.Source.put(widget(2));
								K.hint([ 1, 2 ]);
								K.settle(
									() =>
									{
										K.Source.put(widget(1, { IDCustomer: 2 }));
										K.Source.put(widget(2, { OwnerIDUser: null }));
										K.hint([ 1, 2 ]);
										K.settle(
											() =>
											{
												let tmpMirror = K.mirror();
												Expect(keysOf(tmpMirror, 1)).to.deep.equal([ '2/42' ]);
												Expect(keysOf(tmpMirror, 2)).to.deep.equal([ '1/null' ]);
												Expect(keysOf(K.keymap(), 1)).to.deep.equal([ '2/42' ]);
												Expect(keysOf(K.keymap(), 2)).to.deep.equal([ '1/null' ]);
												// the raw tables hold exactly one tombstone per old key
												let tmpTombstones = K.Store.tables().Widget.filter((pRow) => { return pRow._IsDeleted === 1; });
												Expect(tmpTombstones.map((pRow) => { return `${pRow.IDWidget}:${pRow.IDCustomer}/${pRow.OwnerIDUser}`; }).sort()).to.deep.equal([ '1:1/42', '2:1/42' ]);
												// a tombstone carries the key columns and NULL elsewhere
												Expect(tmpTombstones[0].Status).to.equal(null);
												Expect(tmpTombstones[0].Amount).to.equal(null);
												return fDone();
											});
									});
							});
					});

				test('quarantine (unset tenant) and Lossy flags (SQLite text in an integer column, non-canonical date text)',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.hint([ 1 ]);
								K.settle(
									() =>
									{
										K.Source.put(widget(1, { IDCustomer: 0 }));
										K.Source.put(widget(2, { IDGroup: '' }));
										K.Source.put(widget(3, { UpdateDate: '2022-01-01T00:00:00' }));
										K.hint([ 1, 2, 3 ]);
										K.settle(
											() =>
											{
												let tmpMirror = K.mirror();
												// the quarantined row left the mirror (tombstoned at its old key)
												Expect(tmpMirror.map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 2, 3 ]);
												Expect(K.Loop.quarantined()).to.equal(1);
												Expect(tmpMirror[0].IDGroup).to.equal(null);
												let tmpLossy = K.Loop.lossy();
												Expect(tmpLossy.IDGroup).to.equal('Value');
												Expect(tmpLossy.UpdateDate).to.equal('Compare');
												// a later Value never downgrades; quarantine clears once the tenant is set again
												K.Source.put(widget(1));
												K.hint([ 1 ]);
												K.settle(
													() =>
													{
														Expect(K.Loop.quarantined()).to.equal(0);
														Expect(K.mirror().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3 ]);
														return fDone();
													});
											});
									});
							});
					});

				test('liveness is SQL `Deleted = 0` exactly (§56.4): NULL and text that is not a zero are not live; integer text zero is',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1, { Deleted: null }));
								K.Source.put(widget(2, { Deleted: 'false' }));
								K.Source.put(widget(3, { Deleted: '0' }));
								K.Source.put(widget(4, { Deleted: 0 }));
								K.hint([ 1, 2, 3, 4 ]);
								K.settle(
									() =>
									{
										Expect(K.mirror().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 3, 4 ]);
										Expect(K.Loop.quarantined()).to.equal(0);
										return fDone();
									});
							});
					});

				test('one flush = keymap intents, ONE mirror INSERT with rows and tombstones, retirements; tokens <E>:<FlushID>:<Target>:<K|M|R><i>',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.Source.put(widget(2));
								K.hint([ 1, 2 ]);
								K.settle(
									() =>
									{
										let tmpFrom = K.Store.Inserts.length;
										// several cycles in one flush window: an update, a soft delete, a tenant move
										K.Source.put(widget(1, { Status: 'Again' }));
										K.hint([ 1 ]);
										setTimeout(
											() =>
											{
												K.Source.put(widget(2, { IDCustomer: 3 }));
												K.Source.put(widget(4));
												K.hint([ 2, 4 ]);
												let tmpVersionBefore = K.Clock.Last;
												K.settle(
													() =>
													{
														let tmpInserts = K.Store.Inserts.slice(tmpFrom);
														Expect(tmpInserts.map((pInsert) => { return pInsert.Table; })).to.deep.equal([ '_rfs_keys_Widget', 'Widget', '_rfs_keys_Widget' ]);
														let tmpFlushID = tmpInserts[0].Token.split(':')[1];
														Expect(Number(tmpFlushID)).to.be.above(0);
														Expect(Number(tmpFlushID)).to.be.at.most(tmpVersionBefore);
														Expect(tmpInserts.map((pInsert) => { return pInsert.Token; })).to.deep.equal([ `Widget:${tmpFlushID}:Live:K0`, `Widget:${tmpFlushID}:Live:M0`, `Widget:${tmpFlushID}:Live:R0` ]);
														// rows 1, 2, 4 + the tombstone of 2's old key in the ONE mirror insert
														Expect(tmpInserts[1].Rows).to.equal(4);
														Expect(K.Flushed[K.Flushed.length - 1]).to.deep.include({ Rows: 3, Tombstones: 1, Cycles: 2 });
														Expect(K.Loop.stats().Flushes).to.equal(2);
														return fDone();
													});
											}, 5);
									});
							});
					});

				test('a row moved twice (and a row created then moved) inside one flush window leaves no ghost: later cycles see the buffered keymap changes',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.hint([ 1 ]);
								K.settle(
									() =>
									{
										// a stream cycle moves 1 and creates 5 (buffered: the flush interval is long)
										K.Source.put(widget(1, { IDCustomer: 2 }));
										K.Source.put(widget(5, { IDCustomer: 7 }));
										K.hint([ 1, 5 ]);
										let fWait = () =>
										{
											if (K.Loop.working() || (K.FlushBuffer.size() < 1))
											{
												return setTimeout(fWait, 2);
											}
											// before that flush, both rows move again and a Scrub re-reads them
											K.Source.put(widget(1, { IDCustomer: 3 }));
											K.Source.put(widget(5, { IDCustomer: 8, OwnerIDUser: 1 }));
											K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Live', AfterID: null, ToID: null, Cap: 100 },
												(pError) =>
												{
													Expect(pError).to.not.exist;
													// one flush carried both cycles
													Expect(K.Flushed[K.Flushed.length - 1].Cycles).to.equal(2);
													let tmpMirror = K.mirror();
													Expect(keysOf(tmpMirror, 1)).to.deep.equal([ '3/42' ]);
													Expect(keysOf(tmpMirror, 5)).to.deep.equal([ '8/1' ]);
													Expect(keysOf(K.keymap(), 1)).to.deep.equal([ '3/42' ]);
													Expect(keysOf(K.keymap(), 5)).to.deep.equal([ '8/1' ]);
													Expect(K.PendingSet.size()).to.equal(0);
													return fDone();
												});
										};
										fWait();
									});
							});
					});

				test('a re-hint while the ID is in a buffered cycle waits for that flush, then gets its own cycle',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.hint([ 1 ]);
								let fWait = () =>
								{
									if (K.Loop.working() || (K.FlushBuffer.size() < 1))
									{
										return setTimeout(fWait, 2);
									}
									K.Source.put(widget(1, { Status: 'Second' }));
									K.hint([ 1 ]);
									Expect(K.PendingSet.available()).to.equal(0);
									K.Loop.flush(
										() =>
										{
											// acked away? no: the re-hint keeps it for another cycle
											Expect(K.PendingSet.has(1)).to.equal(true);
											K.settle(
												() =>
												{
													Expect(K.mirror()[0].Status).to.equal('Second');
													Expect(K.PendingSet.size()).to.equal(0);
													return fDone();
												});
										});
								};
								fWait();
							});
					});

				test('a failed flush releases its hints; the retry is a new cycle with a higher version and a fresh read',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1, { Status: 'First' }));
								K.hint([ 1 ]);
								let tmpReads = K.Source.Reads;
								K.Store.failNext('writeBatch', 'Before');
								K.settle(
									(pError) =>
									{
										Expect(pError).to.exist;
										Expect(K.Loop.stats().FlushErrors).to.equal(1);
										Expect(K.PendingSet.has(1)).to.equal(true);
										Expect(K.PendingSet.inFlight()).to.equal(0);
										Expect(K.mirror().length).to.equal(0);
										let tmpFailedVersion = K.Clock.Last;
										// the source moved on before the retry: the retry reads it afresh
										K.Source.put(widget(1, { Status: 'Second' }));
										setTimeout(
											() =>
											{
												K.settle(
													(pRetryError) =>
													{
														Expect(pRetryError).to.not.exist;
														let tmpMirror = K.mirror();
														Expect(tmpMirror.map((pRow) => { return pRow.Status; })).to.deep.equal([ 'Second' ]);
														Expect(tmpMirror[0]._Version).to.be.above(tmpFailedVersion);
														Expect(K.Source.Reads).to.be.above(tmpReads + 1);
														Expect(K.PendingSet.size()).to.equal(0);
														return fDone();
													});
											}, 30);
									});
							});
					});

				test('the superset invariant: a failure after the keymap intents or after the mirror insert never leaves a ghost; the retry converges',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.hint([ 1 ]);
								K.settle(
									() =>
									{
										let fCheckSuperset = () =>
										{
											let tmpKeymap = new Set(K.keymap().map((pRow) => { return `${pRow.IDWidget}:${pRow.IDCustomer}/${pRow.OwnerIDUser}`; }));
											K.mirror().forEach((pRow) => { Expect(tmpKeymap.has(`${pRow.IDWidget}:${pRow.IDCustomer}/${pRow.OwnerIDUser}`), 'keymap ⊇ mirror').to.equal(true); });
										};
										K.Source.put(widget(1, { IDCustomer: 2 }));
										K.hint([ 1 ]);
										K.Store.failNext('writeBatch', 'AfterKeys');
										K.settle(
											(pError) =>
											{
												Expect(pError).to.exist;
												fCheckSuperset();
												// the move did not reach the mirror yet: the old row is still the live one
												Expect(keysOf(K.mirror(), 1)).to.deep.equal([ '1/42' ]);
												K.Source.put(widget(1, { IDCustomer: 3 }));
												K.Store.failNext('writeBatch', 'AfterMirror');
												setTimeout(
													() =>
													{
														K.settle(
															(pError2) =>
															{
																Expect(pError2).to.exist;
																fCheckSuperset();
																setTimeout(
																	() =>
																	{
																		K.settle(
																			(pError3) =>
																			{
																				Expect(pError3).to.not.exist;
																				fCheckSuperset();
																				Expect(keysOf(K.mirror(), 1)).to.deep.equal([ '3/42' ]);
																				Expect(keysOf(K.keymap(), 1)).to.deep.equal([ '3/42' ]);
																				return fDone();
																			});
																	}, 30);
															});
													}, 30);
											});
									});
							});
					});

				test('Resync: a Dirty mark re-reads the whole entity in pages, tombstones a hard-deleted tail, then clears the mark',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								for (let i = 1; i <= 10; i++)
								{
									K.Source.put(widget(i));
								}
								K.hint([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ]);
								K.settle(
									() =>
									{
										// changes nobody hinted with IDs: an update, a hard delete of the tail, an insert
										K.Source.put(widget(3, { Status: 'Raw' }));
										K.Source.remove(9);
										K.Source.remove(10);
										K.Source.put(widget(7, { Deleted: 1 }));
										let tmpGeneration = K.PendingSet.markDirty(null, [ '*' ], K.Loop.monotonicNow());
										K.Loop.kick();
										let fWait = () =>
										{
											if (K.PendingSet.dirty() || !K.Loop.quiet())
											{
												if (K.FlushBuffer.size() > 0)
												{
													K.Loop.requestFlush();
												}
												return setTimeout(fWait, 3);
											}
											Expect(K.mirror().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3, 4, 5, 6, 8 ]);
											Expect(K.mirror().filter((pRow) => { return pRow.IDWidget === 3; })[0].Status).to.equal('Raw');
											Expect(K.keymap().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3, 4, 5, 6, 8 ]);
											Expect(K.Loop.stats().RangeCycles).to.be.at.least(3);
											Expect(tmpGeneration).to.be.above(0);
											return fDone();
										};
										setTimeout(fWait, 3);
									});
							});
					});

				test('Range tasks: called back after the flush that carried the page acked, with { LastID, Rows, Exhausted }; a ToID bounds the range; a bad task fails',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								for (let i = 1; i <= 7; i++)
								{
									K.Source.put(widget(i));
								}
								K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Live', AfterID: null, ToID: null, Cap: 4 },
									(pError, pResult) =>
									{
										Expect(pError).to.not.exist;
										Expect(pResult).to.deep.equal({ LastID: 4, Rows: 4, Exhausted: false });
										Expect(K.mirror().length).to.equal(4);
										K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Live', AfterID: 4, ToID: 6, Cap: 4 },
											(pError2, pResult2) =>
											{
												Expect(pError2).to.not.exist;
												Expect(pResult2).to.deep.equal({ LastID: 6, Rows: 2, Exhausted: true });
												Expect(K.mirror().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3, 4, 5, 6 ]);
												K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Shadow:0a1b2c3d', AfterID: null, ToID: null, Cap: 4 },
													(pError3) =>
													{
														Expect(pError3).to.exist;
														Expect(pError3.LoopError).to.equal('TargetGone');
														K.Loop.addRangeTask({ Kind: 'Bogus', Target: 'Live', Cap: 1 },
															(pError4) =>
															{
																Expect(pError4.LoopError).to.equal('TaskInvalid');
																return fDone();
															});
													});
											});
									});
							});
					});

				test('no starvation: under a firehose of new stream hints a queued Range task still runs (after a bounded burst of stream cycles)',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								let tmpNext = 1000;
								let tmpFirehose = true;
								let tmpStreamAtRange = null;
								K.Loop.setTestHook('afterRead',
									(pInfo) =>
									{
										if ((pInfo.Kind === 'Scrub') && (tmpStreamAtRange === null))
										{
											tmpStreamAtRange = K.Loop.stats().StreamCycles;
										}
										if (tmpFirehose && (pInfo.Kind === 'Stream'))
										{
											// every stream read brings a brand new hint
											tmpNext++;
											K.Source.put(widget(tmpNext));
											K.PendingSet.add(tmpNext, null, K.Loop.monotonicNow());
										}
									});
								K.Source.put(widget(1));
								K.hint([ 999 ]);
								K.Loop.addRangeTask({ Kind: 'Scrub', Target: 'Live', AfterID: null, ToID: 5, Cap: 10 },
									(pError, pResult) =>
									{
										Expect(pError).to.not.exist;
										Expect(pResult.Rows).to.equal(1);
										return fDone();
									});
								let fWait = () =>
								{
									if (K.Loop.stats().RangeCycles < 1)
									{
										return setTimeout(fWait, 2);
									}
									// the Range cycle ran while stream hints were still arriving, after a bounded burst
									tmpFirehose = false;
									K.Loop.setTestHook('afterRead', null);
									Expect(tmpStreamAtRange).to.be.at.most(12);
									Expect(K.PendingSet.size()).to.be.above(0);
									K.Loop.requestFlush();
								};
								fWait();
							});
					});

				test('first enable: beginRebuild(true) writes stream hints and pages to the shadow only; finishRebuild RENAMEs it live',
					(fDone) =>
					{
						newLoopKit({ NoLive: true },
							(K) =>
							{
								for (let i = 1; i <= 6; i++)
								{
									K.Source.put(widget(i));
								}
								// a hint that arrives before the build has nowhere to go yet
								K.hint([ 2 ]);
								K.Loop.beginRebuild('0a1b2c3d', true,
									(pError) =>
									{
										Expect(pError).to.not.exist;
										Expect(K.Loop.targets()).to.deep.equal([ 'Shadow:0a1b2c3d' ]);
										let fPage = (pAfterID) =>
										{
											K.Loop.addRangeTask({ Kind: 'RebuildPage', Target: 'Shadow:0a1b2c3d', AfterID: pAfterID, ToID: null, Cap: 4 },
												(pPageError, pResult) =>
												{
													Expect(pPageError).to.not.exist;
													if (!pResult.Exhausted)
													{
														// a change during the build (after its page was read)
														K.Source.put(widget(2, { Status: 'Late' }));
														K.hint([ 2 ]);
														return fPage(pResult.LastID);
													}
													K.Loop.finishRebuild('0a1b2c3d',
														(pFinishError) =>
														{
															Expect(pFinishError).to.not.exist;
															Expect(K.Loop.targets()).to.deep.equal([ 'Live' ]);
															Expect(K.Store.Commands.some((pCommand) => { return /^RENAME Widget/.test(pCommand); })).to.equal(true);
															Expect(K.Swapped.map((pSwap) => { return { BuildID: pSwap.BuildID, FirstEnable: pSwap.FirstEnable, Current: pSwap.Current }; })).to.deep.equal([ { BuildID: '0a1b2c3d', FirstEnable: true, Current: true } ]);
															Expect(K.mirror().map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3, 4, 5, 6 ]);
															Expect(K.mirror()[1].Status).to.equal('Late');
															Expect(K.Store.tables()['Widget__shadow_0a1b2c3d']).to.equal(undefined);
															return fDone();
														});
												});
										};
										fPage(null);
									});
							});
					});

				test('rebuild: the dual-write window (a write after its page lands in the shadow at a higher version, a delete after its page is tombstoned there); EXCHANGE; abort drops the shadow',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								for (let i = 1; i <= 8; i++)
								{
									K.Source.put(widget(i));
								}
								K.hint([ 1, 2, 3, 4, 5, 6, 7, 8 ]);
								K.settle(
									() =>
									{
										// the live mirror drifted (an unhinted raw write): the rebuild repairs it
										K.Source.put(widget(6, { Status: 'Drifted' }));
										K.Loop.beginRebuild('1b2c3d4e', false,
											(pError) =>
											{
												Expect(pError).to.not.exist;
												Expect(K.Loop.targets()).to.deep.equal([ 'Live', 'Shadow:1b2c3d4e' ]);
												K.Loop.addRangeTask({ Kind: 'RebuildPage', Target: 'Shadow:1b2c3d4e', AfterID: null, ToID: null, Cap: 4 },
													(pPageError, pPage) =>
													{
														Expect(pPage.LastID).to.equal(4);
														let tmpPageVersion = K.Store.tables()['Widget__shadow_1b2c3d4e'].filter((pRow) => { return pRow.IDWidget === 3; })[0]._Version;
														// after page 1 was read: an update of 3 and a delete of 4 (hinted: dual-written)
														K.Source.put(widget(3, { Status: 'AfterPage' }));
														K.Source.put(widget(4, { Deleted: 1 }));
														K.hint([ 3, 4 ]);
														K.Loop.addRangeTask({ Kind: 'RebuildPage', Target: 'Shadow:1b2c3d4e', AfterID: 4, ToID: null, Cap: 4 },
															(pPageError2, pPage2) =>
															{
																Expect(pPage2.Exhausted).to.equal(false);
																K.Loop.addRangeTask({ Kind: 'RebuildPage', Target: 'Shadow:1b2c3d4e', AfterID: 8, ToID: null, Cap: 4 },
																	(pPageError3, pPage3) =>
																	{
																		Expect(pPage3).to.deep.equal({ LastID: null, Rows: 0, Exhausted: true });
																		let tmpShadow = K.mirror('Shadow:1b2c3d4e');
																		Expect(tmpShadow.map((pRow) => { return pRow.IDWidget; })).to.deep.equal([ 1, 2, 3, 5, 6, 7, 8 ]);
																		let tmpThree = tmpShadow.filter((pRow) => { return pRow.IDWidget === 3; })[0];
																		Expect(tmpThree.Status).to.equal('AfterPage');
																		Expect(tmpThree._Version).to.be.above(tmpPageVersion);
																		Expect(K.mirror().filter((pRow) => { return pRow.IDWidget === 6; })[0].Status).to.equal('Open');
																		K.Loop.finishRebuild('1b2c3d4e',
																			(pFinishError) =>
																			{
																				Expect(pFinishError).to.not.exist;
																				Expect(K.Store.Commands.some((pCommand) => { return /^EXCHANGE Widget 1b2c3d4e/.test(pCommand); })).to.equal(true);
																				Expect(K.mirror().map((pRow) => { return [ pRow.IDWidget, pRow.Status ]; })).to.deep.equal([ [ 1, 'Open' ], [ 2, 'Open' ], [ 3, 'AfterPage' ], [ 5, 'Open' ], [ 6, 'Drifted' ], [ 7, 'Open' ], [ 8, 'Open' ] ]);
																				// an aborted rebuild: targets back, shadow dropped, its task fails
																				K.Loop.beginRebuild('2c3d4e5f', false,
																					() =>
																					{
																						K.Loop.addRangeTask({ Kind: 'RebuildPage', Target: 'Shadow:2c3d4e5f', AfterID: null, ToID: null, Cap: 100 }, () => {});
																						K.Loop.abortRebuild('2c3d4e5f',
																							() =>
																							{
																								Expect(K.Loop.targets()).to.deep.equal([ 'Live' ]);
																								Expect(K.Store.tables()['Widget__shadow_2c3d4e5f']).to.equal(undefined);
																								Expect(K.Loop.rebuild()).to.equal(null);
																								return fDone();
																							});
																					});
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('ack only after EVERY target succeeded: a failure on the shadow keeps the hints pending although the live insert landed',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Loop.beginRebuild('3d4e5f60', false,
									() =>
									{
										K.Source.put(widget(1));
										K.hint([ 1 ]);
										K.Store.failNext('writeBatch', 'Before', null, { Target: 'Shadow:3d4e5f60' });
										K.settle(
											(pError) =>
											{
												Expect(pError).to.exist;
												Expect(K.mirror().length).to.equal(1);
												Expect(K.PendingSet.has(1)).to.equal(true);
												Expect(K.Flushed.length).to.equal(0);
												setTimeout(
													() =>
													{
														K.settle(
															() =>
															{
																Expect(K.PendingSet.size()).to.equal(0);
																Expect(K.mirror('Shadow:3d4e5f60').length).to.equal(1);
																return fDone();
															});
													}, 30);
											});
									});
							});
					});

				test('the crash hook: a crash between the flush and the ack acks nothing; a wipe error reports onWipe',
					(fDone) =>
					{
						newLoopKit({},
							(K) =>
							{
								K.Source.put(widget(1));
								K.Loop.setTestHook('afterFlushBeforeAck', () => { K.Loop.halt('Crashed'); });
								K.hint([ 1 ]);
								K.settle(
									() =>
									{
										// landed, never acked
										Expect(K.mirror().length).to.equal(1);
										Expect(K.PendingSet.has(1)).to.equal(true);
										Expect(K.Flushed.length).to.equal(0);
										Expect(K.Loop.halted()).to.equal(true);
										Expect(() => { K.Loop.setTestHook('nope', null); }).to.throw();
										newLoopKit({},
											(K2) =>
											{
												K2.Store.dropDatabase(
													() =>
													{
														K2.Source.put(widget(1));
														K2.hint([ 1 ]);
														setTimeout(
															() =>
															{
																Expect(K2.Wiped).to.be.at.least(1);
																Expect(K2.Loop.stats().LastErrorCode).to.equal(81);
																K2.Loop.halt();
																return fDone();
															}, 40);
													});
											});
									});
							});
					});
			}
		);

		suite
		(
			'Freshness (§61)',
			() =>
			{
				let newFreshness = (pPending, pCovered, pExtra) =>
				{
					let tmpFable = libBuilders.newFable();
					let tmpCovered = (pCovered !== false);
					tmpFable.RetoldFacetingChangeIntake = { NodeEpoch: EPOCH, covers: (pEntity) => { return tmpCovered && (pEntity !== 'Uncovered'); } };
					let tmpPending = pPending || {};
					tmpFable.RetoldFacetingMaterializer = { pendingInfo: (pStore, pEntity) => { return tmpPending[pEntity] || { Pending: 0, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: null, MinSeqN: null, Dirty: null }; } };
					let tmpFreshness = new libRetoldFacetingFreshness(tmpFable, libOptions.resolve(libOptions.deepMerge({ Freshness: { LagWarnMS: 2000, MaxLagMS: 5000, BreakerFailures: 5, BreakerWindowMS: 30000, BreakerOpenMS: 30000 } }, pExtra || {})));
					tmpFreshness.monotonicNow = () => { return 10000; };
					return tmpFreshness;
				};

				test('observe: ObservedSeq per epoch is the highest n; malformed Seqs are ignored; never throws',
					() =>
					{
						let tmpFreshness = newFreshness();
						tmpFreshness.observe({ Entity: 'Widget', Seq: `${EPOCH}:5` });
						tmpFreshness.observe({ Entity: 'Widget', Seq: `${EPOCH}:3` });
						tmpFreshness.observe({ Entity: 'Widget', Seq: 'e:ffffffff:9' });
						tmpFreshness.observe({ Entity: 'Widget', Seq: 'garbage' });
						tmpFreshness.observe(null);
						tmpFreshness.observe({ Seq: `${EPOCH}:1` });
						Expect(tmpFreshness.observedSeq('Widget')).to.deep.equal({ [EPOCH]: 5, 'e:ffffffff': 9 });
						Expect(tmpFreshness.observedSeq('Other')).to.deep.equal({});
					});

				test('the state machine: register, transitions, Lagging computed (never stored), Degraded by the write breaker and back',
					() =>
					{
						let tmpPending = {};
						let tmpFreshness = newFreshness(tmpPending, true, { Freshness: { BreakerFailures: 2 } });
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Absent');
						tmpFreshness.register(STORE, 'Widget', { State: 'Building', Epoch: 3 });
						Expect(tmpFreshness.state(STORE, 'Widget')).to.deep.include({ State: 'Building', Epoch: 3 });
						Expect(tmpFreshness.setState(STORE, 'Widget', 'Nope')).to.equal(false);
						tmpFreshness.setState(STORE, 'Widget', 'CatchingUp', 'Swapped');
						tmpFreshness.setState(STORE, 'Widget', 'Lagging', 'x');
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Live');
						// a backlog older than LagWarnMS reports Lagging
						tmpPending.Widget = { Pending: 1, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: 7000, MinSeqN: 3, Dirty: null };
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget', Date.now())).to.deep.include({ State: 'Lagging', Exact: false, LagMS: 3000, Pending: true });
						tmpPending.Widget = null;
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget', Date.now())).to.deep.include({ State: 'Live', Exact: true, LagMS: 0, Pending: false });
						// two write failures open the write breaker: Degraded; a flush success resumes
						Expect(tmpFreshness.recordWriteFailure(STORE, 'Widget')).to.equal(false);
						Expect(tmpFreshness.recordWriteFailure(STORE, 'Widget')).to.equal(true);
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Degraded');
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget').LagMS).to.equal(Infinity);
						tmpFreshness.recordWriteSuccess(STORE, 'Widget');
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('CatchingUp');
						// Degraded during a build resumes the build
						tmpFreshness.setState(STORE, 'Widget', 'Building', 'Initial');
						tmpFreshness.recordWriteFailure(STORE, 'Widget');
						tmpFreshness.recordWriteFailure(STORE, 'Widget');
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Degraded');
						tmpFreshness.recordWriteSuccess(STORE, 'Widget');
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Building');
						// Unverified stamps UnverifiedSince; a rebuild started while Unverified is not Exact-admissible
						tmpFreshness.setState(STORE, 'Widget', 'Unverified', 'UncleanShutdown');
						Expect(tmpFreshness.state(STORE, 'Widget').UnverifiedSince).to.be.a('number');
						tmpFreshness.setState(STORE, 'Widget', 'Rebuilding', 'SpecChange');
						Expect(tmpFreshness.state(STORE, 'Widget').Divergence).to.equal(true);
						tmpFreshness.setState(STORE, 'Widget', 'Live', 'Rebuilt');
						Expect(tmpFreshness.state(STORE, 'Widget')).to.deep.include({ Divergence: false, UnverifiedSince: null });
						tmpFreshness.setEpoch(STORE, 'Widget', 9);
						Expect(tmpFreshness.state(STORE, 'Widget').Epoch).to.equal(9);
						Expect(libRetoldFacetingFreshness.STATES[0]).to.equal('Live');
					});

				test('Exact / LagMS / AppliedSeq numbers: pending work, a Dirty mark, Unverified age; AppliedSeq only when applied() runs, never backwards',
					() =>
					{
						let tmpPending = {};
						let tmpFreshness = newFreshness(tmpPending);
						tmpFreshness.register(STORE, 'Widget', 'Live');
						tmpFreshness.observe({ Entity: 'Widget', Seq: `${EPOCH}:10` });
						// nothing applied yet: AppliedSeq is whatever applied() last computed
						Expect(tmpFreshness.appliedSeq(STORE, 'Widget')).to.deep.equal({});
						tmpPending.Widget = { Pending: 1, InFlight: 1, Buffered: 1, Resolving: 0, OldestFirstSeen: 9500, MinSeqN: 8, Dirty: null };
						Expect(tmpFreshness.applied(STORE, 'Widget')).to.deep.equal({ [EPOCH]: 7 });
						let tmpEntity = tmpFreshness.entityFreshness(STORE, 'Widget', 1000000);
						Expect(tmpEntity).to.deep.include({ Exact: false, LagMS: 500, Pending: true, Covered: true });
						// a Dirty mark: lag from its Since, AppliedSeq bounded by its Seq
						tmpPending.Widget = { Pending: 0, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: null, MinSeqN: null, Dirty: { Since: 4000, MinSeqN: 6 } };
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget', 1000000).LagMS).to.equal(6000);
						// never backwards
						Expect(tmpFreshness.applied(STORE, 'Widget')).to.deep.equal({ [EPOCH]: 7 });
						tmpPending.Widget = null;
						Expect(tmpFreshness.applied(STORE, 'Widget')).to.deep.equal({ [EPOCH]: 10 });
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget', 1000000)).to.deep.include({ Exact: true, LagMS: 0 });
						// Unverified: wall-clock age of UnverifiedSince
						tmpFreshness.setState(STORE, 'Widget', 'Unverified', 'UncleanShutdown');
						let tmpSince = tmpFreshness.state(STORE, 'Widget').UnverifiedSince;
						Expect(tmpFreshness.entityFreshness(STORE, 'Widget', tmpSince + 1234)).to.deep.include({ Exact: false, LagMS: 1234 });
					});

				test('freshness(DepSet): Exact = every entity, LagMS = max, the worst State, AsOf, a stable ApplyToken that follows AppliedSeq and Epoch',
					() =>
					{
						let tmpPending = {};
						let tmpFreshness = newFreshness(tmpPending);
						tmpFreshness.register(STORE, 'Widget', 'Live');
						tmpFreshness.register(STORE, 'Group', 'Live');
						let tmpNow = Date.parse('2026-10-09T12:00:00Z');
						let tmpFirst = tmpFreshness.freshness(STORE, { Widget: [ 'Status' ], Group: [ 'Name' ] }, tmpNow);
						Expect(tmpFirst).to.deep.include({ Exact: true, LagMS: 0, State: 'Live', AsOf: '2026-10-09T12:00:00.000Z' });
						Expect(tmpFirst.ApplyToken).to.match(/^at:[0-9a-f]{16}$/);
						Expect(tmpFreshness.freshness(STORE, { Group: [], Widget: [] }, tmpNow).ApplyToken).to.equal(tmpFirst.ApplyToken);
						tmpPending.Group = { Pending: 2, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: 8000, MinSeqN: null, Dirty: null };
						tmpFreshness.setState(STORE, 'Widget', 'CatchingUp', 'x');
						let tmpSecond = tmpFreshness.freshness(STORE, [ 'Widget', 'Group' ], tmpNow);
						Expect(tmpSecond).to.deep.include({ Exact: false, LagMS: 2000, State: 'CatchingUp', AsOf: '2026-10-09T11:59:58.000Z' });
						tmpFreshness.setEpoch(STORE, 'Widget', 2);
						Expect(tmpFreshness.freshness(STORE, [ 'Widget', 'Group' ], tmpNow).ApplyToken).to.not.equal(tmpFirst.ApplyToken);
						Expect(tmpFreshness.freshness(STORE, {}, tmpNow)).to.deep.include({ Exact: false, State: 'Absent' });
						tmpFreshness.setState(STORE, 'Group', 'Building', 'x');
						Expect(tmpFreshness.freshness(STORE, [ 'Widget', 'Group' ], tmpNow)).to.deep.include({ State: 'Building', LagMS: Infinity, AsOf: null });
					});

				test('the admission table (§61.3), cell by cell, with the reasons',
					() =>
					{
						let tmpPending = {};
						let tmpFreshness = newFreshness(tmpPending);
						let tmpNow = Date.now();
						let fAdmit = (pState, pMode, pSetup) =>
						{
							tmpFreshness.setState(STORE, 'Widget', 'Live', 'reset');
							tmpFreshness.setState(STORE, 'Widget', pState, (pSetup && pSetup.Reason) || 'test');
							tmpPending.Widget = (pSetup && pSetup.Pending) ? { Pending: 1, InFlight: 0, Buffered: 0, Resolving: 0, OldestFirstSeen: 10000 - ((pSetup && pSetup.LagMS) || 0), MinSeqN: null, Dirty: null } : null;
							let tmpRequest = { Mode: pMode, MaxLagMS: 5000, MinSeq: (pSetup && pSetup.MinSeq) || null };
							return tmpFreshness.admits(STORE, { Widget: [ 'Status' ] }, tmpRequest, tmpNow);
						};
						// Absent / Building / Degraded: never
						[ 'Absent', 'Building', 'Degraded' ].forEach(
							(pState) =>
							{
								[ 'Exact', 'Bounded', 'Fast' ].forEach(
									(pMode) =>
									{
										let tmpResult = fAdmit(pState, pMode);
										Expect(tmpResult.Admit, `${pState}/${pMode}`).to.equal(false);
										Expect(tmpResult.Reason).to.equal(`State:${pState}:Widget`);
									});
							});
						// CatchingUp: Fast only
						Expect(fAdmit('CatchingUp', 'Exact').Reason).to.equal('State:CatchingUp:Widget');
						Expect(fAdmit('CatchingUp', 'Bounded').Reason).to.equal('State:CatchingUp:Widget');
						Expect(fAdmit('CatchingUp', 'Fast').Admit).to.equal(true);
						// Live (and Lagging): Exact iff Exact, Bounded iff LagMS ≤ MaxLagMS, Fast always
						Expect(fAdmit('Live', 'Exact').Admit).to.equal(true);
						Expect(fAdmit('Live', 'Exact', { Pending: true }).Reason).to.equal('NotExact:Widget');
						Expect(fAdmit('Live', 'Exact', { MinSeq: `${EPOCH}:3` }).Admit).to.equal(true);
						Expect(fAdmit('Live', 'Fast', { MinSeq: `${EPOCH}:3`, Pending: true }).Reason).to.equal('NotExact:Widget');
						Expect(fAdmit('Live', 'Bounded', { Pending: true, LagMS: 4000 }).Admit).to.equal(true);
						Expect(fAdmit('Live', 'Bounded', { Pending: true, LagMS: 6000 }).Reason).to.equal('Lagging:Widget');
						Expect(fAdmit('Live', 'Fast', { Pending: true, LagMS: 60000 }).Admit).to.equal(true);
						// Rebuilding: Exact iff Exact and not divergence-triggered
						Expect(fAdmit('Rebuilding', 'Exact').Admit).to.equal(true);
						Expect(fAdmit('Rebuilding', 'Exact', { Pending: true }).Reason).to.equal('NotExact:Widget');
						Expect(fAdmit('Rebuilding', 'Exact', { Reason: 'Divergence' }).Reason).to.equal('Unverified:Widget');
						Expect(fAdmit('Rebuilding', 'Bounded', { Reason: 'Divergence' }).Admit).to.equal(true);
						Expect(fAdmit('Rebuilding', 'Fast').Admit).to.equal(true);
						// Unverified: never Exact; Bounded by its age; Fast
						Expect(fAdmit('Unverified', 'Exact').Reason).to.equal('Unverified:Widget');
						Expect(fAdmit('Unverified', 'Bounded').Admit).to.equal(true);
						Expect(fAdmit('Unverified', 'Fast').Admit).to.equal(true);
						// NoChangeSource
						let tmpUncovered = newFreshness({}, false);
						tmpUncovered.register(STORE, 'Widget', 'Live');
						Expect(tmpUncovered.admits(STORE, { Widget: [] }, { Mode: 'Exact' }, tmpNow).Reason).to.equal('NoChangeSource:Widget');
						Expect(tmpUncovered.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpNow).Admit).to.equal(true);
						// a DepSet: the first failing entity (sorted) gives the reason; an unknown entity is Absent
						tmpFreshness.setState(STORE, 'Widget', 'Live', 'x');
						tmpPending.Widget = null;
						Expect(tmpFreshness.admits(STORE, { Widget: [], Zeta: [] }, { Mode: 'Fast' }, tmpNow).Reason).to.equal('State:Absent:Zeta');
						let tmpOK = tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Exact' }, tmpNow);
						Expect(tmpOK.Freshness).to.deep.include({ Exact: true, State: 'Live' });
						Expect(libRetoldFacetingFreshness.ADMISSION.Live.Exact).to.equal('IfExact');
					});

				test('the breaker per (engine, entity, kind): opens after 5 failures in the window, half-opens after OpenMS, a failure re-opens, a success closes',
					() =>
					{
						let tmpFreshness = newFreshness();
						tmpFreshness.register(STORE, 'Widget', 'Live');
						let tmpNow = 1000000;
						for (let i = 0; i < 4; i++)
						{
							Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + i, 'Read')).to.equal(false);
						}
						// failures outside the window do not count
						Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + 40000, 'Read')).to.equal(false);
						for (let i = 1; i < 4; i++)
						{
							tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + 40000 + i, 'Read');
						}
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 40010, 'Read')).to.equal(false);
						Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + 40011, 'Read')).to.equal(true);
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 40012, 'Read')).to.equal(true);
						// reads and writes are separate; other entities unaffected
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 40012, 'Write')).to.equal(false);
						Expect(tmpFreshness.breakerOpen(STORE, 'Other', tmpNow + 40012, 'Read')).to.equal(false);
						let tmpAdmit = tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpNow + 40012);
						Expect(tmpAdmit.Reason).to.equal('Breaker:Widget');
						// half-open after OpenMS: let through; a failure re-opens at once
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 70012, 'Read')).to.equal(false);
						Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + 70013, 'Read')).to.equal(true);
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 70014, 'Read')).to.equal(true);
						// half-open again, a success closes
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 100014, 'Read')).to.equal(false);
						tmpFreshness.recordSuccess(STORE, 'Widget', tmpNow + 100015, 'Read');
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpNow + 100016, 'Read')).to.equal(false);
						Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + 100017, 'Read')).to.equal(false);
						let tmpStats = tmpFreshness.stats();
						Expect(tmpStats.Breakers[`${STORE}:Widget:Read`]).to.deep.include({ Open: false, Failures: 1 });
						Expect(tmpStats.Entities[`${STORE}:Widget`]).to.deep.include({ State: 'Live', Exact: true });
					});

				test('M5 review: a divergence-marked rebuild keeps its mark through a Degraded detour (Exact never admitted before the swap); so does a rebuild started from CatchingUp, or from Unverified via Degraded',
					() =>
					{
						let tmpFreshness = newFreshness();
						let fExact = () => { return tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Exact' }, Date.now()); };
						// (a) Rebuilding (Divergence) → 5 write failures (Degraded) → a success: back to Rebuilding, still marked.
						tmpFreshness.register(STORE, 'Widget', 'Live');
						tmpFreshness.setState(STORE, 'Widget', 'Rebuilding', 'Divergence');
						Expect(tmpFreshness.state(STORE, 'Widget').Divergence).to.equal(true);
						for (let i = 0; i < 5; i++)
						{
							tmpFreshness.recordWriteFailure(STORE, 'Widget');
						}
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Degraded');
						tmpFreshness.recordWriteSuccess(STORE, 'Widget');
						Expect(tmpFreshness.state(STORE, 'Widget')).to.deep.include({ State: 'Rebuilding', Divergence: true });
						Expect(fExact().Admit, 'a divergence rebuild after a Degraded detour').to.equal(false);
						// (b) a rebuild started while CatchingUp (its catch-up Sweep may still be paging): non-Exact.
						tmpFreshness.setState(STORE, 'Widget', 'CatchingUp', 'CleanStart');
						tmpFreshness.setState(STORE, 'Widget', 'Rebuilding', 'Admin');
						Expect(tmpFreshness.state(STORE, 'Widget').Divergence).to.equal(true);
						Expect(fExact().Admit, 'a rebuild started from CatchingUp').to.equal(false);
						// (c) Unverified → Degraded → a rebuild (Admin): the Degraded detour does not forget the Unverified.
						tmpFreshness.recordWriteSuccess(STORE, 'Widget');
						tmpFreshness.setState(STORE, 'Widget', 'Unverified', 'UncleanShutdown');
						for (let i = 0; i < 5; i++)
						{
							tmpFreshness.recordWriteFailure(STORE, 'Widget');
						}
						Expect(tmpFreshness.state(STORE, 'Widget').State).to.equal('Degraded');
						tmpFreshness.setState(STORE, 'Widget', 'Rebuilding', 'Admin');
						Expect(tmpFreshness.state(STORE, 'Widget').Divergence).to.equal(true);
						// The swap of a plain rebuild ends it: Live, unmarked, Exact again.
						tmpFreshness.recordWriteSuccess(STORE, 'Widget');
						tmpFreshness.setState(STORE, 'Widget', 'Live', 'Rebuilt:Admin');
						Expect(tmpFreshness.state(STORE, 'Widget').Divergence).to.equal(false);
						Expect(fExact().Admit).to.equal(true);
					});

				test('M5 review: a half-open breaker admits ONE probe request (its Aggs share the claim); other requests stay refused until its outcome; a refusal gives the probe back; capability reads never claim',
					() =>
					{
						let tmpFreshness = newFreshness(null, true, { Freshness: { BreakerOpenMS: 1000 } });
						tmpFreshness.register(STORE, 'Widget', 'Live');
						tmpFreshness.register(STORE, 'Other', 'Live');
						let tmpNow = 5000000;
						for (let i = 0; i < 5; i++)
						{
							tmpFreshness.recordFailure(STORE, 'Widget', tmpNow + i, 'Read');
						}
						let tmpHalf = tmpNow + 2000;
						Expect(tmpFreshness.breakerOpen(STORE, 'Widget', tmpHalf, 'Read'), 'a capability read: half-open is not open').to.equal(false);
						let tmpProbe = tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpHalf, { ClaimProbe: 'request-1' });
						Expect(tmpProbe.Admit).to.equal(true);
						Expect(tmpProbe.Probes).to.deep.equal([ 'Widget' ]);
						// The probe request's other Agg shares the claim; another request is refused meanwhile.
						Expect(tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpHalf + 1, { ClaimProbe: 'request-1' }).Admit).to.equal(true);
						Expect(tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpHalf + 2, { ClaimProbe: 'request-2' }).Reason).to.equal('Breaker:Widget');
						// The probe's success closes the breaker for everyone.
						tmpFreshness.recordSuccess(STORE, 'Widget', tmpHalf + 3, 'Read');
						Expect(tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpHalf + 4, { ClaimProbe: 'request-2' }).Admit).to.equal(true);
						// Open again; a probe claimed by an admission that is then refused (another entity) is given back.
						for (let i = 0; i < 5; i++)
						{
							tmpFreshness.recordFailure(STORE, 'Widget', tmpHalf + 10 + i, 'Read');
						}
						tmpFreshness.setState(STORE, 'Other', 'Absent', 'test');
						let tmpLater = tmpHalf + 3000;
						let tmpRefused = tmpFreshness.admits(STORE, { Other: [], Widget: [] }, { Mode: 'Fast' }, tmpLater, { ClaimProbe: 'request-3' });
						Expect(tmpRefused.Admit).to.equal(false);
						Expect(tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpLater + 1, { ClaimProbe: 'request-4' }).Admit, 'the probe was released').to.equal(true);
						// A failed probe re-opens at once.
						Expect(tmpFreshness.recordFailure(STORE, 'Widget', tmpLater + 2, 'Read')).to.equal(true);
						Expect(tmpFreshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }, tmpLater + 3, { ClaimProbe: 'request-5' }).Reason).to.equal('Breaker:Widget');
					});
			}
		);

		suite
		(
			'Materializer over the fake store (§58.1, §58.2, §58.8, §58.9, §59.3)',
			() =>
			{
				/**
				 * A fable with the real M5 services (Freshness, Materializer, Rebuilder, Reconciler), a stub
				 * intake and MirrorSpec, the fake store and the fake source.
				 */
				let newKit = (pExtra, pStore, pSource) =>
				{
					let tmpOptions = unitOptions(pExtra);
					let tmpFable = libBuilders.newFable();
					let tmpCovered = { Value: true };
					tmpFable.RetoldFacetingChangeIntake = { NodeEpoch: EPOCH, covers: () => { return tmpCovered.Value; } };
					let tmpRealMirrorSpec = new libRetoldFacetingMirrorSpec(tmpFable, tmpOptions);
					let tmpSpecs = { Widget: WIDGET_SPEC };
					tmpFable.RetoldFacetingMirrorSpec =
						{
							compile: () => { return { Specs: { ClickHouse: Object.assign({}, tmpSpecs) }, Disabled: [], Warnings: [] }; },
							spec: (pStore, pEntity) => { return tmpSpecs[pEntity] || null; },
							entities: () => { return Object.keys(tmpSpecs); },
							classifyChange: (pReport, pSpec) => { return tmpRealMirrorSpec.classifyChange(pReport, pSpec); }
						};
					[ [ 'RetoldFacetingFreshness', libRetoldFacetingFreshness ], [ 'RetoldFacetingMaterializer', libRetoldFacetingMaterializer ], [ 'RetoldFacetingRebuilder', libRetoldFacetingRebuilder ], [ 'RetoldFacetingReconciler', libRetoldFacetingReconciler ] ].forEach(
						(pEntry) =>
						{
							tmpFable.addServiceType(pEntry[0], pEntry[1]);
							tmpFable.instantiateServiceProvider(pEntry[0], tmpOptions);
						});
					let tmpSource = pSource || new FakeSource();
					tmpFable.RetoldFacetingMaterializeSourceInProcess = tmpSource;
					let tmpStore = pStore || new libFakeStore({ Database: 'rfs_fake' });
					tmpFable.RetoldFacetingMaterializer.useStore(STORE, tmpStore);
					let tmpKit = { Fable: tmpFable, Options: tmpOptions, Store: tmpStore, Source: tmpSource, Materializer: tmpFable.RetoldFacetingMaterializer, Freshness: tmpFable.RetoldFacetingFreshness, Covered: tmpCovered, Seq: 0, Specs: tmpSpecs };
					tmpKit.event = (pOperation, pIDs, pExtraEvent) =>
					{
						tmpKit.Seq++;
						let tmpEvent = Object.assign({ ChangeID: `ch:${tmpKit.Seq}`, Source: 'Interim', Entity: 'Widget', Operation: pOperation, IDs: pIDs, Tenants: [ 1 ], Seq: `${EPOCH}:${tmpKit.Seq}` }, pExtraEvent || {});
						tmpKit.Freshness.observe(tmpEvent);
						tmpKit.Materializer.onChange(tmpEvent);
						return tmpEvent;
					};
					tmpKit.state = () => { return tmpKit.Freshness.state(STORE, 'Widget').State; };
					tmpKit.mirrorIDs = () => { return tmpStore.mirror('Widget').map((pRow) => { return pRow.IDWidget; }).sort((pA, pB) => { return pA - pB; }); };
					return tmpKit;
				};

				test('start: no state → backfill (Building → RENAME → CatchingUp → Live); writes reach the mirror; quiesce; status / entityInfo / pendingInfo',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 9; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							(pError) =>
							{
								Expect(pError).to.not.exist;
								Expect(K.Materializer.loop(STORE, 'Widget')).to.be.an.instanceof(libRetoldFacetingWriterLoop);
								Expect(K.Materializer.loop(STORE, 'Nope')).to.equal(null);
								K.Materializer.quiesce(STORE, null, 5000,
									(pQuiesceError) =>
									{
										Expect(pQuiesceError).to.not.exist;
										Expect(K.state()).to.equal('Live');
										Expect(K.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4, 5, 6, 7, 8, 9 ]);
										let tmpState = K.Store.stateOf('Widget');
										Expect(tmpState).to.deep.include({ State: 'Live', CleanShutdown: 0, SpecHash: WIDGET_SPEC.SpecHash, Epoch: 1 });
										Expect(tmpState.Detail.Spec.SpecHash).to.equal(WIDGET_SPEC.SpecHash);
										Expect(tmpState.LastRebuild).to.be.a('string');
										// a CRUD-style event stream
										K.Source.put(widget(3, { Status: 'Edited' }));
										K.Source.remove(4);
										K.Source.put(widget(10));
										K.event('Update', [ 3 ]);
										K.event('Delete', [ '4' ]);
										K.event('Create', [ 10 ]);
										Expect(K.Freshness.entityFreshness(STORE, 'Widget').Exact).to.equal(false);
										let tmpPending = K.Materializer.pendingInfo(STORE, 'Widget');
										Expect(tmpPending).to.include.keys([ 'Pending', 'InFlight', 'Buffered', 'Resolving', 'OldestFirstSeen', 'MinSeqN', 'Dirty', 'Overflow' ]);
										Expect(tmpPending.Pending + tmpPending.InFlight).to.equal(3);
										K.Materializer.quiesce(STORE, [ 'Widget' ], 5000,
											(pError2) =>
											{
												Expect(pError2).to.not.exist;
												Expect(K.mirrorIDs()).to.deep.equal([ 1, 2, 3, 5, 6, 7, 8, 9, 10 ]);
												Expect(K.Store.mirror('Widget').filter((pRow) => { return pRow.IDWidget === 3; })[0].Status).to.equal('Edited');
												let tmpFresh = K.Freshness.entityFreshness(STORE, 'Widget');
												Expect(tmpFresh).to.deep.include({ Exact: true, State: 'Live' });
												Expect(tmpFresh.AppliedSeq).to.deep.equal({ [EPOCH]: 3 });
												Expect(K.Store.stateOf('Widget').AppliedSeq).to.deep.equal({ [EPOCH]: 3 });
												let tmpInfo = K.Materializer.entityInfo(STORE, 'Widget');
												Expect(tmpInfo).to.deep.include({ State: 'Live', Epoch: 1, Available: true, Quarantined: 0 });
												Expect(tmpInfo.FillingColumns).to.deep.equal([]);
												Expect(tmpInfo.Spec).to.equal(WIDGET_SPEC);
												let tmpStatus = K.Materializer.status();
												Expect(tmpStatus.Stores.ClickHouse.Available).to.equal(true);
												Expect(tmpStatus.Stores.ClickHouse.Entities.Widget).to.deep.include({ State: 'Live', Pending: 0, Buffered: 0, LagMS: 0 });
												Expect(tmpStatus.Stores.ClickHouse.Entities.Widget.Flushes).to.be.at.least(2);
												K.Materializer.stop(
													() =>
													{
														// stopped: nothing applies hints any more, so nothing may be judged current
														Expect(K.state()).to.equal('Absent');
														Expect(K.Freshness.admits(STORE, { Widget: [] }, { Mode: 'Fast' }).Admit).to.equal(false);
														return fDone();
													});
											});
									});
							});
					});

				test('the event → pending mapping (§58.2): IDs (integer text too), empty IDs → Dirty, a settle re-delivery re-hints, a foreign Seq has no SeqN, an unsafe ID → Dirty, other entities ignored',
					(fDone) =>
					{
						let K = newKit();
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpRecord = K.Materializer._record(STORE, 'Widget');
										let tmpLoop = K.Materializer.loop(STORE, 'Widget');
										tmpLoop.halt('test');
										let tmpSet = tmpRecord.PendingSet;
										K.event('Update', [ 1, '1201' ]);
										Expect(tmpSet.has(1)).to.equal(true);
										Expect(tmpSet.has(1201)).to.equal(true);
										Expect(tmpSet._Entries.get(1201).MinSeqN).to.equal(K.Seq);
										K.event('Update', [ 1 ], { ChangeID: 'ch:9~settle' });
										Expect(tmpSet._Entries.get(1).Hints).to.equal(2);
										K.event('Update', [ 2 ], { Seq: 'e:ffffffff:77' });
										Expect(tmpSet._Entries.get(2).MinSeqN).to.equal(null);
										Expect(tmpSet.dirty()).to.equal(null);
										K.event('EntityDirty', []);
										Expect(tmpSet.dirty()).to.deep.include({ MinSeqN: K.Seq });
										tmpSet.clearDirty(tmpSet.dirty().Generation);
										K.event('Update', [ 'not-an-id', 3 ]);
										Expect(tmpSet.has(3)).to.equal(true);
										Expect(tmpSet.dirty()).to.not.equal(null);
										let tmpSize = tmpSet.size();
										K.event('Update', [ 4 ], { Entity: 'Unmirrored' });
										Expect(tmpSet.size()).to.equal(tmpSize);
										Expect(K.Materializer.isPending(STORE, 'Widget', '1201')).to.equal(true);
										Expect(K.Materializer.enqueue(STORE, 'Widget', [ 50, 51 ], { Source: 'Sweep' })).to.equal(2);
										Expect(K.Materializer.enqueue(STORE, 'Nope', [ 50 ], { Source: 'Sweep' })).to.equal(0);
										K.Materializer.crash();
										return fDone();
									});
							});
					});

				test('filter resolution (§58.8): mirror IDs (the pre-write predicate) ∪ source IDs are enqueued; a refusal or a store error → a whole-entity Resync; Resolving meanwhile',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 4; i++)
						{
							K.Source.put(widget(i, { Status: (i <= 2) ? 'Old' : 'Other' }));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpRecord = K.Materializer._record(STORE, 'Widget');
										K.Materializer.loop(STORE, 'Widget').halt('test');
										let tmpCompiled = [];
										K.Materializer.compileFilter = (pSpec, pEntries, pInput) =>
										{
											tmpCompiled.push({ Entries: pEntries, Input: pInput });
											if (pEntries.length && (pEntries[0].Value === 'Refuse'))
											{
												return { Refused: 'OperatorUnsupported:LIKE' };
											}
											return { SQL: '`Status` = {f_0:String}', Params: { f_0: pEntries[0].Value }, Types: { f_0: 'String' } };
										};
										let tmpQueries = [];
										K.Store.queryHandler = (pSQL, pParams) => { tmpQueries.push({ SQL: pSQL, Params: pParams }); return [ { ID: 1 }, { ID: 2 } ]; };
										// the write changed 2 to 'New' and created 9 'Old'
										K.Source.put(widget(2, { Status: 'New' }));
										K.Source.put(widget(9, { Status: 'Old' }));
										K.Materializer.resolveFilter(STORE, 'Widget', [ { Column: 'Status', Operator: '=', Value: 'Old', Connector: 'AND' } ], [ 1 ], 41,
											(pError, pResult) =>
											{
												Expect(pError).to.not.exist;
												Expect(pResult).to.deep.equal({ Enqueued: 3, Dirty: false });
												Expect([ 1, 2, 9 ].every((pID) => { return tmpRecord.PendingSet.has(pID); })).to.equal(true);
												Expect(tmpRecord.PendingSet._Entries.get(9).MinSeqN).to.equal(41);
												Expect(tmpQueries[0].SQL).to.equal('SELECT DISTINCT `IDWidget` AS `ID` FROM `rfs_fake`.`Widget` FINAL WHERE `_IsDeleted` = 0 AND (`Status` = {f_0:String})');
												Expect(tmpCompiled[0].Input).to.deep.include({ SourceDialect: 'SQLite', SourceStringOrder: 'Binary', Prefix: 'f' });
												// Resolving while in flight
												let tmpCall = K.Materializer.resolveFilter(STORE, 'Widget', [ { Column: 'Status', Operator: '=', Value: 'Refuse' } ], [ 1 ], 42,
													(pError2, pResult2) =>
													{
														Expect(pResult2).to.deep.equal({ Enqueued: 0, Dirty: true });
														Expect(tmpRecord.PendingSet.dirty()).to.deep.include({ MinSeqN: 42 });
														Expect(tmpRecord.Resolving).to.equal(0);
														// an event carrying a Filter goes through the same path
														K.Store.failNext('queryRows', 'Before');
														tmpRecord.PendingSet.clearDirty(tmpRecord.PendingSet.dirty().Generation);
														K.event('EntityDirty', [], { Filter: [ { Column: 'Status', Operator: '=', Value: 'Old' } ] });
														Expect(K.Materializer.pendingInfo(STORE, 'Widget').Resolving).to.equal(1);
														Expect(K.Freshness.entityFreshness(STORE, 'Widget').Exact).to.equal(false);
														setTimeout(
															() =>
															{
																Expect(tmpRecord.Resolving).to.equal(0);
																Expect(tmpRecord.PendingSet.dirty()).to.not.equal(null);
																K.Materializer.crash();
																return fDone();
															}, 30);
													});
												Expect(tmpCall).to.equal(undefined);
											});
									});
							});
					});

				test('AppliedSeq advances only after the ack: an applied hint still buffered keeps AppliedSeq behind',
					(fDone) =>
					{
						let K = newKit({ Materializer: { FlushIntervalMS: 60000 } });
						K.Source.put(widget(1));
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpBefore = K.Freshness.appliedSeq(STORE, 'Widget');
										K.event('Update', [ 1 ]);
										let fWait = () =>
										{
											let tmpInfo = K.Materializer.pendingInfo(STORE, 'Widget');
											if (tmpInfo.Buffered < 1)
											{
												return setTimeout(fWait, 2);
											}
											// read and diffed, not flushed: nothing applied, not Exact
											Expect(K.Freshness.appliedSeq(STORE, 'Widget')).to.deep.equal(tmpBefore);
											Expect(K.Freshness.entityFreshness(STORE, 'Widget').Exact).to.equal(false);
											K.Materializer.flushNow(STORE, 'Widget',
												(pError) =>
												{
													Expect(pError).to.not.exist;
													Expect(K.Freshness.appliedSeq(STORE, 'Widget')).to.deep.equal({ [EPOCH]: K.Seq });
													Expect(K.Freshness.entityFreshness(STORE, 'Widget').Exact).to.equal(true);
													K.Materializer.stop(() => { return fDone(); });
												});
										};
										fWait();
									});
							});
					});

				test('stop writes CleanShutdown = 1 when drained; a restart resumes CatchingUp → Live; crash() writes nothing and the next start is Unverified until verify; a hint arriving after stop began is never clean',
					(fDone) =>
					{
						let tmpStore = new libFakeStore({ Database: 'rfs_fake' });
						let tmpSource = new FakeSource();
						for (let i = 1; i <= 5; i++)
						{
							tmpSource.put(widget(i));
						}
						let K = newKit({}, tmpStore, tmpSource);
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										K.Source.put(widget(2, { Status: 'Pending at stop' }));
										K.event('Update', [ 2 ]);
										K.Materializer.stop(
											() =>
											{
												let tmpState = tmpStore.stateOf('Widget');
												Expect(tmpState.CleanShutdown).to.equal(1);
												Expect(tmpStore.mirror('Widget').filter((pRow) => { return pRow.IDWidget === 2; })[0].Status).to.equal('Pending at stop');
												// a clean restart: CatchingUp (a Sweep runs: the entity has a watermark) → Live
												let K2 = newKit({}, tmpStore, tmpSource);
												K2.Materializer.start(
													() =>
													{
														Expect([ 'CatchingUp', 'Live' ]).to.include(K2.state());
														Expect(tmpStore.stateOf('Widget').CleanShutdown).to.equal(0);
														K2.Materializer.quiesce(STORE, null, 5000,
															(pError) =>
															{
																Expect(pError).to.not.exist;
																Expect(K2.state()).to.equal('Live');
																let tmpStateWrites = tmpStore.stateRows().length;
																let tmpInserts = tmpStore.Inserts.length;
																K2.Source.put(widget(3, { Status: 'Lost' }));
																K2.event('Update', [ 3 ]);
																K2.Materializer.crash();
																// nothing written by the crash
																setTimeout(
																	() =>
																	{
																		Expect(tmpStore.stateRows().length).to.equal(tmpStateWrites);
																		Expect(tmpStore.Inserts.length).to.equal(tmpInserts);
																		Expect(tmpStore.stateOf('Widget').CleanShutdown).to.equal(0);
																		// the next start: Unverified (Exact never served) until verify repaired it
																		let K3 = newKit({}, tmpStore, tmpSource);
																		let tmpSeen = [];
																		let fSetState = K3.Freshness.setState.bind(K3.Freshness);
																		K3.Freshness.setState = (pStore, pEntity, pState, pReason) => { tmpSeen.push(pState); return fSetState(pStore, pEntity, pState, pReason); };
																		K3.Materializer.start(
																			() =>
																			{
																				Expect(tmpSeen.filter((pState) => { return pState !== 'Absent'; })[0]).to.equal('Unverified');
																				Expect(K3.Freshness.admits(STORE, { Widget: [] }, { Mode: 'Exact' }).Admit).to.equal(false);
																				K3.Materializer.quiesce(STORE, null, 8000,
																					(pError3) =>
																					{
																						Expect(pError3).to.not.exist;
																						let fLive = () =>
																						{
																							if (K3.state() !== 'Live')
																							{
																								return setTimeout(fLive, 5);
																							}
																							Expect(tmpStore.mirror('Widget').filter((pRow) => { return pRow.IDWidget === 3; })[0].Status).to.equal('Lost');
																							Expect(tmpStore.stateOf('Widget').UnverifiedSince).to.equal(null);
																							// a hint after stop began: not clean
																							K3.Materializer.stop(
																								() =>
																								{
																									Expect(tmpStore.stateOf('Widget').CleanShutdown).to.equal(1);
																									let K4 = newKit({}, tmpStore, tmpSource);
																									K4.Materializer.start(
																										() =>
																										{
																											K4.Materializer.quiesce(STORE, null, 5000,
																												() =>
																												{
																													K4.Materializer.stop(() => {});
																													K4.event('Update', [ 1 ]);
																													Expect(K4.Materializer._record(STORE, 'Widget').LostHints).to.equal(true);
																													setTimeout(
																														() =>
																														{
																															Expect(tmpStore.stateOf('Widget').CleanShutdown).to.equal(0);
																															return fDone();
																														}, 60);
																												});
																										});
																								});
																						};
																						fLive();
																					});
																			});
																	}, 30);
															});
													});
											});
									});
							});
					});

				test('feature-not-boot: a store that is down → Unavailable, no throw, retried; the hints captured meanwhile are applied once it is up',
					(fDone) =>
					{
						let tmpStore = new libFakeStore({ Database: 'rfs_fake', Up: false });
						let K = newKit({ Stores: { ClickHouse: { RetryConnectMS: 20 } } }, tmpStore);
						K.Source.put(widget(1));
						K.Materializer.start(
							(pError) =>
							{
								Expect(pError).to.not.exist;
								Expect(K.Materializer.status().Stores.ClickHouse).to.deep.include({ Available: false, Reason: 'StoreUnavailable' });
								Expect(K.Materializer.entityInfo(STORE, 'Widget').Available).to.equal(false);
								K.Source.put(widget(2));
								K.event('Create', [ 2 ]);
								Expect(K.Materializer.isPending(STORE, 'Widget', 2)).to.equal(true);
								tmpStore.Up = true;
								K.Materializer.quiesce(STORE, null, 5000,
									(pQuiesceError) =>
									{
										Expect(pQuiesceError).to.not.exist;
										Expect(K.mirrorIDs()).to.deep.equal([ 1, 2 ]);
										K.Materializer.stop(() => { return fDone(); });
									});
							});
					});

				test('Materializer.Enabled false (or no store) → start does nothing',
					(fDone) =>
					{
						let K = newKit({ Materializer: { Enabled: false } });
						Expect(K.Materializer.enabled()).to.equal(false);
						K.Materializer.start(
							() =>
							{
								Expect(K.Materializer.started()).to.equal(false);
								Expect(K.Materializer.status()).to.deep.equal({ Stores: {} });
								K.Materializer.onChange({ Entity: 'Widget', IDs: [ 1 ], Seq: `${EPOCH}:1` });
								let tmpBare = new libRetoldFacetingMaterializer(libBuilders.newFable(), {});
								Expect(tmpBare.enabled()).to.equal(false);
								tmpBare.start(() => { Expect(tmpBare.started()).to.equal(false); return fDone(); });
							});
					});

				test('wipe recovery (§59.3): the database dropped under a running materializer → Absent → backfill → identical to the source',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 6; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpStates = [];
										let fSetState = K.Freshness.setState.bind(K.Freshness);
										K.Freshness.setState = (pStore, pEntity, pState, pReason) => { tmpStates.push(`${pState}:${pReason}`); return fSetState(pStore, pEntity, pState, pReason); };
										K.Store.dropDatabase(
											() =>
											{
												K.Source.put(widget(7));
												K.event('Create', [ 7 ]);
												let fWait = () =>
												{
													if (!tmpStates.some((pState) => { return pState === 'Absent:Wipe'; }))
													{
														return setTimeout(fWait, 5);
													}
													K.Materializer.quiesce(STORE, null, 5000,
														(pError) =>
														{
															Expect(pError).to.not.exist;
															Expect(K.state()).to.equal('Live');
															Expect(K.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4, 5, 6, 7 ]);
															Expect(tmpStates).to.include('Building:Wipe');
															Expect(K.Store.stateOf('Widget').State).to.equal('Live');
															K.Materializer.stop(() => { return fDone(); });
														});
												};
												fWait();
											});
									});
							});
					});

				test('reload (§55.4): an additive change ADDs the columns, they read as filling until a full Fill pass, then the state takes the new SpecHash; a non-additive change rebuilds beside the old live tables (dual-written) and swaps',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 6; i++)
						{
							K.Source.put(widget(i, { Note: `n${i}` }));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										// additive: a new Nullable column
										let tmpAdded = JSON.parse(JSON.stringify(WIDGET_SPEC));
										tmpAdded.Columns.push({ Column: 'Note', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' });
										tmpAdded.ColumnNames = tmpAdded.Columns.map((pColumn) => { return pColumn.Column; }).sort();
										tmpAdded.SourceColumns = tmpAdded.SourceColumns.concat([ 'Note' ]);
										tmpAdded.SpecHash = 'ms:0addc01';
										K.Specs.Widget = tmpAdded;
										let tmpFillingSeen = null;
										let fSetSpec = K.Materializer.loop(STORE, 'Widget').setSpec.bind(K.Materializer.loop(STORE, 'Widget'));
										K.Materializer.loop(STORE, 'Widget').setSpec = (pSpec, pOptions) => { let tmpResult = fSetSpec(pSpec, pOptions); setImmediate(() => { if (tmpFillingSeen === null) { tmpFillingSeen = K.Materializer.entityInfo(STORE, 'Widget').FillingColumns; } }); return tmpResult; };
										K.Materializer.reload(
											() =>
											{
												K.Materializer.quiesce(STORE, null, 5000,
													(pError) =>
													{
														Expect(pError).to.not.exist;
														Expect(tmpFillingSeen).to.deep.equal([ 'Note' ]);
														Expect(K.Store.Commands.some((pCommand) => { return /^ADD COLUMNS Widget Note/.test(pCommand); })).to.equal(true);
														Expect(K.Materializer.entityInfo(STORE, 'Widget').FillingColumns).to.deep.equal([]);
														Expect(K.Store.mirror('Widget').map((pRow) => { return pRow.Note; }).sort()).to.deep.equal([ 'n1', 'n2', 'n3', 'n4', 'n5', 'n6' ]);
														Expect(K.Store.stateOf('Widget').SpecHash).to.equal('ms:0addc01');
														// not additive: Amount retyped
														let tmpRetyped = JSON.parse(JSON.stringify(tmpAdded));
														tmpRetyped.Columns.filter((pColumn) => { return pColumn.Column === 'Amount'; })[0].Mirror = 'Nullable(String)';
														tmpRetyped.Columns.filter((pColumn) => { return pColumn.Column === 'Amount'; })[0].DataType = 'String';
														tmpRetyped.SpecHash = 'ms:0e7e7e7e';
														K.Specs.Widget = tmpRetyped;
														let tmpEpoch = K.Materializer.entityInfo(STORE, 'Widget').Epoch;
														K.Materializer.reload(
															() =>
															{
																// during the rebuild the retyped column reads as not mirrored; the old tables keep the old spec
																Expect(K.Materializer.entityInfo(STORE, 'Widget').FillingColumns).to.include('Amount');
																Expect(K.Materializer.entityInfo(STORE, 'Widget').LiveSpec.SpecHash).to.equal('ms:0addc01');
																K.Source.put(widget(2, { Note: 'during', Amount: 9.5 }));
																K.event('Update', [ 2 ]);
																K.Materializer.quiesce(STORE, null, 5000,
																	(pError2) =>
																	{
																		Expect(pError2).to.not.exist;
																		let tmpInfo = K.Materializer.entityInfo(STORE, 'Widget');
																		Expect(tmpInfo).to.deep.include({ State: 'Live', Epoch: tmpEpoch + 1 });
																		Expect(tmpInfo.FillingColumns).to.deep.equal([]);
																		Expect(K.Store.Commands.some((pCommand) => { return /^EXCHANGE Widget/.test(pCommand); })).to.equal(true);
																		let tmpTwo = K.Store.mirror('Widget').filter((pRow) => { return pRow.IDWidget === 2; })[0];
																		Expect(tmpTwo).to.deep.include({ Note: 'during', Amount: '9.5' });
																		Expect(K.Store.stateOf('Widget')).to.deep.include({ SpecHash: 'ms:0e7e7e7e', State: 'Live' });
																		K.Materializer.stop(() => { return fDone(); });
																	});
															});
													});
											});
									});
							});
					});

				test('a non-additive change found at boot: with the old layout in the state snapshot it rebuilds beside the live tables (Unverified first, never Exact before the swap); without one it drops them and backfills',
					(fDone) =>
					{
						let tmpStore = new libFakeStore({ Database: 'rfs_fake' });
						let tmpSource = new FakeSource();
						for (let i = 1; i <= 5; i++)
						{
							tmpSource.put(widget(i));
						}
						let K = newKit({}, tmpStore, tmpSource);
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										K.Materializer.stop(
											() =>
											{
												let tmpRetyped = JSON.parse(JSON.stringify(WIDGET_SPEC));
												tmpRetyped.Columns.filter((pColumn) => { return pColumn.Column === 'Status'; })[0].Mirror = 'Nullable(Int64)';
												tmpRetyped.SpecHash = 'ms:0b007b00';
												let K2 = newKit({}, tmpStore, tmpSource);
												K2.Specs.Widget = tmpRetyped;
												let tmpSeen = [];
												let fSetState = K2.Freshness.setState.bind(K2.Freshness);
												K2.Freshness.setState = (pStore, pEntity, pState, pReason) => { tmpSeen.push(pState); return fSetState(pStore, pEntity, pState, pReason); };
												K2.Materializer.start(
													() =>
													{
														let tmpStates = tmpSeen.filter((pState) => { return pState !== 'Absent'; });
														Expect(tmpStates[0]).to.equal('Unverified');
														Expect(tmpStates).to.include('Rebuilding');
														Expect(K2.Freshness.admits(STORE, { Widget: [] }, { Mode: 'Exact' }).Admit).to.equal(false);
														Expect(K2.Materializer.entityInfo(STORE, 'Widget').LiveSpec.SpecHash).to.equal(WIDGET_SPEC.SpecHash);
														K2.Materializer.quiesce(STORE, null, 5000,
															(pError) =>
															{
																Expect(pError).to.not.exist;
																Expect(K2.state()).to.equal('Live');
																Expect(tmpStore.Commands.some((pCommand) => { return /^EXCHANGE Widget/.test(pCommand); })).to.equal(true);
																Expect(tmpStore.stateOf('Widget').SpecHash).to.equal('ms:0b007b00');
																Expect(K2.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4, 5 ]);
																K2.Materializer.stop(
																	() =>
																	{
																		// the snapshot is gone (an older state row): drop and build afresh
																		let tmpLatest = tmpStore.stateOf('Widget');
																		tmpStore.writeState('Widget', Object.assign({}, tmpLatest, { Detail: {}, _Version: tmpLatest._Version + 1, Version: tmpLatest._Version + 1 }),
																			() =>
																			{
																				let K3 = newKit({}, tmpStore, tmpSource);
																				K3.Specs.Widget = WIDGET_SPEC;
																				K3.Materializer.start(
																					() =>
																					{
																						Expect([ 'Building', 'CatchingUp', 'Live' ]).to.include(K3.state());
																						K3.Materializer.quiesce(STORE, null, 5000,
																							(pError3) =>
																							{
																								Expect(pError3).to.not.exist;
																								Expect(K3.state()).to.equal('Live');
																								Expect(tmpStore.Commands.some((pCommand) => { return /^DROP TABLE IF EXISTS `rfs_fake`\.`Widget`/.test(pCommand); })).to.equal(true);
																								Expect(tmpStore.stateOf('Widget').SpecHash).to.equal(WIDGET_SPEC.SpecHash);
																								Expect(K3.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4, 5 ]);
																								K3.Materializer.stop(() => { return fDone(); });
																							});
																					});
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('stop when a loop cannot drain (its flushes keep failing) leaves CleanShutdown = 0 after DrainOnStopMS',
					(fDone) =>
					{
						let K = newKit({ Materializer: { DrainOnStopMS: 80 } });
						K.Source.put(widget(1));
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										for (let i = 0; i < 50; i++)
										{
											K.Store.failNext('writeBatch', 'Before');
										}
										K.Source.put(widget(1, { Status: 'Undrainable' }));
										K.event('Update', [ 1 ]);
										let tmpStarted = Date.now();
										K.Materializer.stop(
											() =>
											{
												Expect(Date.now() - tmpStarted).to.be.at.least(60);
												Expect(K.Store.stateOf('Widget').CleanShutdown).to.equal(0);
												return fDone();
											});
									});
							});
					});

				test('M5 review: state writes are coalesced — AppliedSeq-only changes ride one periodic write (not one per flush); a lifecycle change is written at once',
					(fDone) =>
					{
						let K = newKit({ Materializer: { StateWriteIntervalMS: 300 } });
						for (let i = 1; i <= 5; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									(pQuiesceError) =>
									{
										Expect(pQuiesceError || null).to.equal(null);
										let tmpBefore = K.Store.stateRows().length;
										let tmpFlushes = 0;
										let fWrite = () =>
										{
											if (tmpFlushes >= 8)
											{
												return fAfterWrites();
											}
											tmpFlushes++;
											K.Source.put(widget(1, { Status: `S${tmpFlushes}` }));
											K.event('Update', [ 1 ]);
											K.Materializer.flushNow(STORE, 'Widget', () => { setTimeout(fWrite, 5); });
										};
										let fAfterWrites = () =>
										{
											Expect(K.Materializer.loop(STORE, 'Widget').stats().Flushes).to.be.at.least(8);
											Expect(K.Store.stateRows().length - tmpBefore, 'no state write per flush').to.be.at.most(1);
											setTimeout(
												() =>
												{
													// the periodic write carried the latest AppliedSeq
													Expect(K.Store.stateRows().length - tmpBefore).to.be.at.most(2);
													Expect(K.Store.stateOf('Widget').AppliedSeq).to.deep.equal({ [EPOCH]: K.Seq });
													let tmpRows = K.Store.stateRows().length;
													K.Materializer.setState(STORE, 'Widget', 'Unverified', 'test');
													setTimeout(
														() =>
														{
															Expect(K.Store.stateRows().length, 'a lifecycle change is written at once').to.equal(tmpRows + 1);
															Expect(K.Store.stateOf('Widget').State).to.equal('Unverified');
															K.Materializer.crash();
															return fDone();
														}, 20);
												}, 400);
										};
										fWrite();
									});
							});
					});

				test('M5 review: a state read that fails at boot (not a missing table) never drops or rebuilds the live tables: the store is unavailable and the boot is retried',
					(fDone) =>
					{
						let K = newKit({ Stores: { ClickHouse: { RetryConnectMS: 50 } } });
						for (let i = 1; i <= 4; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpEpoch = K.Materializer.entityInfo(STORE, 'Widget').Epoch;
										K.Materializer.stop(
											() =>
											{
												let K2 = newKit({ Stores: { ClickHouse: { RetryConnectMS: 50 } } }, K.Store, K.Source);
												let tmpTimeout = new Error('ClickHouse 503: Code: 159. TIMEOUT_EXCEEDED (injected)');
												tmpTimeout.StoreError = true;
												tmpTimeout.Status = 503;
												tmpTimeout.Code = 159;
												K.Store.failNext('readState', 'Before', tmpTimeout);
												let tmpCommands = K.Store.Commands.length;
												K2.Materializer.start(
													() =>
													{
														K2.Materializer.quiesce(STORE, null, 5000,
															(pError) =>
															{
																Expect(pError || null).to.equal(null);
																Expect(K2.state()).to.equal('Live');
																// resumed, not rebuilt: same Epoch, no DROP / RENAME of the live tables
																Expect(K2.Materializer.entityInfo(STORE, 'Widget').Epoch).to.equal(tmpEpoch);
																Expect(K.Store.Commands.slice(tmpCommands).filter((pCommand) => { return /DROP|RENAME/.test(pCommand); })).to.deep.equal([]);
																Expect(K.Store.Calls.readState).to.be.at.least(2);
																K2.Materializer.crash();
																return fDone();
															});
													});
											});
									});
							});
					});

				test('M5 review: a failed backfill is retried with back-off (never left unbuilt until a restart); leftover shadows of interrupted builds are dropped at boot',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 4; i++)
						{
							K.Source.put(widget(i));
						}
						K.Store.ensureSchema({ Widget: WIDGET_SPEC },
							() =>
							{
								// A shadow an earlier, interrupted build left behind.
								K.Store.beginShadow('Widget', 'deadbeef', WIDGET_SPEC,
									() =>
									{
										Expect(Object.keys(K.Store.tables())).to.include('Widget__shadow_deadbeef');
										K.Store.failNext('beginShadow');
										K.Materializer.start(
											() =>
											{
												K.Materializer.quiesce(STORE, null, 8000,
													(pError) =>
													{
														Expect(pError || null).to.equal(null);
														Expect(K.state()).to.equal('Live');
														Expect(K.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4 ]);
														Expect(K.Store.Calls.beginShadow, 'the failed build was retried').to.be.at.least(3);
														Expect(Object.keys(K.Store.tables()).filter((pTable) => { return /deadbeef/.test(pTable); }), 'the leftover shadow is gone').to.deep.equal([]);
														K.Materializer.crash();
														return fDone();
													});
											});
									});
							});
					});

				test('M5 review: after a clean restart that followed a long downtime a Bisect runs (holding CatchingUp) before the entity is Live',
					(fDone) =>
					{
						let K = newKit();
						for (let i = 1; i <= 4; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										K.Materializer.stop(
											() =>
											{
												// The state row was last written an hour ago (the process was down).
												let tmpRows = K.Store._State.filter((pRow) => { return pRow.Entity === 'Widget'; });
												tmpRows.forEach((pRow) => { pRow.UpdatedAt = Date.now() - 3600000; });
												let K2 = newKit({ Reconcile: { BootBisectAfterMS: 60000 } }, K.Store, K.Source);
												let tmpBisects = [];
												let tmpStates = [];
												K2.Fable.RetoldFacetingReconciler.bisect = (pStore, pEntity, pOptions, fCallback) =>
												{
													tmpStates.push(K2.state());
													tmpBisects.push(pEntity);
													setTimeout(() => { tmpStates.push(K2.state()); fCallback(null, { Enqueued: 0 }); }, 30);
												};
												K2.Materializer.start(
													() =>
													{
														K2.Materializer.quiesce(STORE, null, 5000,
															(pError) =>
															{
																Expect(pError || null).to.equal(null);
																Expect(tmpBisects).to.deep.equal([ 'Widget' ]);
																Expect(tmpStates).to.deep.equal([ 'CatchingUp', 'CatchingUp' ]);
																Expect(K2.state()).to.equal('Live');
																K2.Materializer.crash();
																return fDone();
															});
													});
											});
									});
							});
					});

				test('M5 review: a swap that fails is retried (the shadow is never dropped on a swap error); the rebuild stays non-Exact meanwhile and completes',
					(fDone) =>
					{
						let K = newKit({ Materializer: { MaxBackoffMS: 400 } });
						for (let i = 1; i <= 6; i++)
						{
							K.Source.put(widget(i));
						}
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										let tmpRefusedExact = null;
										let tmpCommandsBefore = K.Store.Commands.length;
										let fSwap = K.Store.swapShadow;
										let tmpSwaps = 0;
										K.Store.swapShadow = function (...pArguments)
										{
											tmpSwaps++;
											if (tmpSwaps === 1)
											{
												let tmpCallback = pArguments[pArguments.length - 1];
												let tmpError = new Error('ClickHouse 500: injected after the mirror half');
												tmpError.StoreError = true;
												tmpError.Status = 500;
												setImmediate(() => { tmpCallback(tmpError); setTimeout(() => { tmpRefusedExact = K.Freshness.admits(STORE, { Widget: [] }, { Mode: 'Exact' }, Date.now()); }, 2); });
												return;
											}
											return fSwap.apply(this, pArguments);
										};
										K.Fable.RetoldFacetingRebuilder.rebuild(STORE, 'Widget', { Reason: 'Admin' },
											(pError, pResult) =>
											{
												Expect(pError || null).to.equal(null);
												Expect(pResult.State).to.equal('Live');
												Expect(tmpSwaps).to.be.at.least(2);
												let tmpCommands = K.Store.Commands.slice(tmpCommandsBefore);
												Expect(tmpCommands.filter((pCommand) => { return /^DROP SHADOW/.test(pCommand); }).length, 'dropped once, after the swap').to.equal(1);
												Expect(tmpCommands.findIndex((pCommand) => { return /^DROP SHADOW/.test(pCommand); })).to.be.above(tmpCommands.findIndex((pCommand) => { return /^EXCHANGE/.test(pCommand); }));
												setTimeout(
													() =>
													{
														Expect(tmpRefusedExact && tmpRefusedExact.Admit, 'non-Exact while the swap is retried').to.equal(false);
														Expect(K.Freshness.state(STORE, 'Widget')).to.deep.include({ State: 'Live', Divergence: false });
														Expect(K.mirrorIDs()).to.deep.equal([ 1, 2, 3, 4, 5, 6 ]);
														K.Materializer.crash();
														return fDone();
													}, 50);
											});
									});
							});
					});

				test('M5 review: builds wait for a MaxConcurrentBuilds slot per store',
					(fDone) =>
					{
						let K = newKit({ Materializer: { MaxConcurrentBuilds: 2 } });
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000, () => { fSlots(); });
							});
						let fSlots = () =>
							{
								let tmpStarted = [];
								let tmpReleases = [];
								[ 'a', 'b', 'c' ].forEach((pName) => { K.Materializer._whenBuildSlot(STORE, pName, (fRelease) => { tmpStarted.push(pName); tmpReleases.push(fRelease); }); });
								Expect(tmpStarted).to.deep.equal([ 'a', 'b' ]);
								tmpReleases[0]();
								setTimeout(
									() =>
									{
										Expect(tmpStarted).to.deep.equal([ 'a', 'b', 'c' ]);
										K.Materializer.crash();
										return fDone();
									}, 10);
							};
					});

				test('updateState and the stateFields pull seam: the Reconciler / Rebuilder fields ride every state write; one writer, latest wins',
					(fDone) =>
					{
						let K = newKit();
						K.Source.put(widget(1));
						K.Materializer.start(
							() =>
							{
								K.Materializer.quiesce(STORE, null, 5000,
									() =>
									{
										K.Materializer.updateState(STORE, 'Widget', { SweepWatermark: '2026-01-01 00:00:00.000', ScrubCursor: 5, Unknown: 'ignored' },
											(pError) =>
											{
												Expect(pError).to.not.exist;
												// Informational fields are coalesced into the store's periodic state write.
												Expect(K.Materializer.status().Stores.ClickHouse.Entities.Widget).to.be.an('object');
												return K.Materializer.quiesce(STORE, null, 5000, (pQuiesceError) => { Expect(pQuiesceError || null).to.equal(null); return fAfterUpdate(); });
											});
										let fAfterUpdate = () =>
											{
												let tmpState = K.Store.stateOf('Widget');
												Expect(tmpState).to.deep.include({ SweepWatermark: '2026-01-01 00:00:00.000', ScrubCursor: 5 });
												Expect(tmpState.Unknown).to.equal(undefined);
												// a later write keeps them (one state object)
												K.Materializer.setState(STORE, 'Widget', 'Unverified', 'test');
												setTimeout(
													() =>
													{
														let tmpLater = K.Store.stateOf('Widget');
														Expect(tmpLater).to.deep.include({ State: 'Unverified', SweepWatermark: '2026-01-01 00:00:00.000', ScrubCursor: 5 });
														Expect(tmpLater.UnverifiedSince).to.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
														Expect(tmpLater._Version).to.be.above(tmpState._Version);
														K.Materializer.crash();
														return fDone();
													}, 20);
											};
									});
							});
					});
			}
		);

		PROVIDERS.forEach(
			(pProvider) =>
			{
				suite
				(
					`MaterializeSource-InProcess on ${pProvider.Provider} ProjectTrack (§58.7)`,
					function ()
					{
						if (!pProvider.Ready)
						{
							test.skip(`skipped: ${pProvider.Reason}`, () => {});
							return;
						}
						this.timeout(30000);
						let _Harness = null;
						let _Behaviors = 0;

						suiteSetup(
							(fDone) =>
							{
								_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider }, fDone);
							});

						suiteTeardown(
							(fDone) =>
							{
								if (_Harness)
								{
									return _Harness.stop(fDone);
								}
								return fDone();
							});

						let source = () =>
						{
							return _Harness.fable.RetoldFacetingMaterializeSourceInProcess;
						};

						/**
						 * Run SQL on the fixture database ('?' placeholders; double-quoted identifiers).
						 */
						let fSQL = (pSQL, pParams, fCallback) =>
						{
							if (pProvider.Provider === 'SQLite')
							{
								let tmpStatement = _Harness.db.prepare(pSQL);
								if (/^\s*SELECT/i.test(pSQL))
								{
									return fCallback(tmpStatement.all(...(pParams || [])).map((pRow) => { return Object.assign({}, pRow); }));
								}
								tmpStatement.run(...(pParams || []));
								return fCallback([]);
							}
							let tmpIndex = 0;
							_Harness.connection.pool.query(pSQL.replace(/\?/g, () => { tmpIndex++; return `$${tmpIndex}`; }), pParams || [],
								(pError, pResult) =>
								{
									Expect(pError).to.not.exist;
									return fCallback(pResult.rows || []);
								});
						};

						test('readRows / readRange see soft-deleted rows, project only the asked columns, and never run a behavior (a throwing one is never called)',
							(fDone) =>
							{
								let fThrow = () => { _Behaviors++; throw new Error('a behavior ran'); };
								[ 'Reads-QueryConfiguration', 'Read-QueryConfiguration', 'Reads-PostOperation', 'Read-PostOperation' ].forEach((pHash) => { _Harness.installBehavior('Task', pHash, fThrow); });
								fSQL('SELECT "IDTask" FROM "Task" WHERE "Deleted" = 1 ORDER BY "IDTask" LIMIT 1', [],
									(pDeletedRows) =>
									{
										fSQL('SELECT "IDTask" FROM "Task" WHERE "Deleted" = 0 ORDER BY "IDTask" LIMIT 2', [],
											(pLiveRows) =>
											{
												let tmpDeleted = Number(pDeletedRows[0].IDTask);
												let tmpLive = pLiveRows.map((pRow) => { return Number(pRow.IDTask); });
												let tmpIDs = [ tmpDeleted, tmpLive[0], tmpLive[1], 99999999 ];
												Expect(source().dialect('Task')).to.equal(pProvider.Provider);
												source().readRows('Task', tmpIDs.concat([ String(tmpLive[0]) ]), { Columns: [ 'IDTask', 'Deleted', 'IDCustomer', 'Status' ] },
													(pError, pRows) =>
													{
														Expect(pError).to.not.exist;
														Expect(pRows.map((pRow) => { return Number(pRow.IDTask); }).sort((pA, pB) => { return pA - pB; })).to.deep.equal([ tmpDeleted, tmpLive[0], tmpLive[1] ].sort((pA, pB) => { return pA - pB; }));
														Expect(Object.keys(pRows[0]).sort()).to.deep.equal([ 'Deleted', 'IDCustomer', 'IDTask', 'Status' ]);
														Expect(Number(pRows.filter((pRow) => { return Number(pRow.IDTask) === tmpDeleted; })[0].Deleted)).to.equal(1);
														Expect(Object.getPrototypeOf(pRows[0])).to.equal(Object.prototype);
														source().readRange('Task', null, 3, { Columns: [ 'Deleted' ] },
															(pRangeError, pRange) =>
															{
																Expect(pRangeError).to.not.exist;
																Expect(pRange.length).to.equal(3);
																Expect(Object.keys(pRange[0]).sort()).to.deep.equal([ 'Deleted', 'IDTask' ]);
																fSQL('SELECT "IDTask" FROM "Task" ORDER BY "IDTask" LIMIT 3', [],
																	(pFirst) =>
																	{
																		let tmpAll = pFirst.map((pRow) => { return Number(pRow.IDTask); });
																		Expect(pRange.map((pRow) => { return Number(pRow.IDTask); })).to.deep.equal(tmpAll);
																		source().readRange('Task', tmpAll[0], 100, { Columns: [ 'Deleted' ], ToID: tmpAll[2] },
																			(pRangeError2, pRange2) =>
																			{
																				Expect(pRange2.map((pRow) => { return Number(pRow.IDTask); })).to.deep.equal([ tmpAll[1], tmpAll[2] ]);
																				Expect(_Behaviors).to.equal(0);
																				source().readRows('Task', [ 1 ], { Columns: [ 'IDTask; DROP TABLE Task' ] },
																					(pBadError) =>
																					{
																						Expect(pBadError).to.exist;
																						Expect(pBadError.SourceError).to.equal(true);
																						source().readRange('Task', null, 0, { Columns: [] },
																							(pCapError) =>
																							{
																								Expect(pCapError).to.exist;
																								return fDone();
																							});
																					});
																			});
																	});
															});
													});
											});
									});
							});

						test('readIDs: liveness of a range (deleted and tenant-unset rows are not live); checksums over live rows equal SQL',
							(fDone) =>
							{
								fSQL('SELECT COUNT(*) AS "N", SUM("IDTask") AS "S" FROM "Task" WHERE "Deleted" = 0 AND "IDCustomer" IS NOT NULL AND "IDCustomer" <> 0', [],
									(pTotals) =>
									{
										source().checksums('Task', 50,
											(pError, pBuckets) =>
											{
												Expect(pError).to.not.exist;
												let tmpCount = 0;
												let tmpSum = 0;
												Object.keys(pBuckets).forEach((pBucket) => { tmpCount += pBuckets[pBucket].Count; tmpSum += pBuckets[pBucket].IDSum; });
												Expect(tmpCount).to.equal(Number(pTotals[0].N));
												Expect(tmpSum).to.equal(Number(pTotals[0].S));
												fSQL('SELECT COUNT(*) AS "N", SUM("IDTask") AS "S" FROM "Task" WHERE "Deleted" = 0 AND "IDCustomer" <> 0 AND "IDTask" < 50', [],
													(pZero) =>
													{
														Expect(pBuckets['0']).to.deep.equal({ Count: Number(pZero[0].N), IDSum: Number(pZero[0].S) });
														source().readIDs('Task', null, 60,
															(pIDsError, pIDs) =>
															{
																Expect(pIDsError).to.not.exist;
																fSQL('SELECT "IDTask", "Deleted", "IDCustomer" FROM "Task" WHERE "IDTask" <= 60 ORDER BY "IDTask"', [],
																	(pExpected) =>
																	{
																		Expect(pIDs).to.deep.equal(pExpected.map((pRow) => { return { ID: Number(pRow.IDTask), Live: (Number(pRow.Deleted) === 0) && (pRow.IDCustomer !== null) && (Number(pRow.IDCustomer) !== 0) }; }));
																		return fDone();
																	});
															});
													});
											});
									});
							});

						test('sweep: a compound (UpdateDate, ID) keyset that never stalls on rows sharing one stamp; NULL stamps never swept',
							(fDone) =>
							{
								// 7 rows share one stamp, more than the Cap
								fSQL('UPDATE "Task" SET "UpdateDate" = \'2031-05-05 05:05:05\' WHERE "IDTask" IN (SELECT "IDTask" FROM "Task" ORDER BY "IDTask" LIMIT 7)', [],
									() =>
									{
										fSQL('SELECT "IDTask" FROM "Task" WHERE "UpdateDate" >= \'2031-05-05 05:05:05\' ORDER BY "UpdateDate", "IDTask"', [],
											(pExpectedRows) =>
											{
												let tmpExpected = pExpectedRows.map((pRow) => { return Number(pRow.IDTask); });
												Expect(tmpExpected.length).to.be.at.least(7);
												let tmpSeen = [];
												let fPage = (pFrom, pPages) =>
												{
													source().sweep('Task', { Column: 'UpdateDate', From: pFrom, Cap: 3 },
														(pError, pPage) =>
														{
															Expect(pError).to.not.exist;
															pPage.Rows.forEach((pRow) => { tmpSeen.push(pRow.ID); Expect(pRow.At).to.match(/^2\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/); });
															if (pPage.Next)
															{
																Expect(pPages).to.be.below(20);
																return fPage(pPage.Next, pPages + 1);
															}
															Expect(tmpSeen).to.deep.equal(tmpExpected);
															return fDone();
														});
												};
												fPage({ At: '2031-05-05 05:05:05', ID: 0 }, 0);
											});
									});
							});

						test('idsByFilter: FoxHound entries (soft-deleted rows included), keyset paged, Cap + 1 at most; a bad operator is refused',
							(fDone) =>
							{
								fSQL('SELECT "IDTask" FROM "Task" WHERE "Status" = \'Done\' ORDER BY "IDTask"', [],
									(pRows) =>
									{
										let tmpExpected = pRows.map((pRow) => { return Number(pRow.IDTask); });
										Expect(tmpExpected.length).to.be.above(3);
										source().idsByFilter('Task', [ { Column: 'Status', Operator: '=', Value: 'Done', Connector: 'AND', Parameter: 'Status' } ], { Cap: 100000 },
											(pError, pIDs) =>
											{
												Expect(pError).to.not.exist;
												Expect(pIDs).to.deep.equal(tmpExpected);
												source().idsByFilter('Task', [ { Column: '"Task"."Status"', Operator: '=', Value: 'Done', Connector: 'AND' } ], { Cap: 2 },
													(pError2, pCapped) =>
													{
														Expect(pCapped).to.deep.equal(tmpExpected.slice(0, 3));
														source().idsByFilter('Task', [ { Column: 'Status', Operator: 'DROP', Value: 1 } ], {},
															(pError3) =>
															{
																Expect(pError3).to.exist;
																return fDone();
															});
													});
											});
									});
							});
					}
				);
			});

		PROVIDERS.forEach(
			(pProvider) =>
			{
				suite
				(
					`ClickHouse-gated: the materializer end to end on ${pProvider.Provider} ProjectTrack`,
					function ()
					{
						let tmpAvailable = libSupport.available();
						if (!tmpAvailable.Available)
						{
							test.skip(`skipped: ${tmpAvailable.Reason}`, () => {});
							return;
						}
						if (!pProvider.Ready)
						{
							test.skip(`skipped: ${pProvider.Reason}`, () => {});
							return;
						}
						this.timeout(90000);
						let _Harness = null;
						let _Database = null;
						let _Entities = [ 'Client', 'Project', 'Task', 'FormType' ];

						let materializer = () => { return _Harness.fable.RetoldFacetingMaterializer; };
						let freshness = () => { return _Harness.fable.RetoldFacetingFreshness; };
						let store = () => { return _Harness.fable.RetoldFacetingStoreClickHouse; };

						/**
						 * Run SQL on the fixture database ('?' placeholders; double-quoted identifiers).
						 */
						let fSQL = (pSQL, pParams, fCallback) =>
						{
							if (pProvider.Provider === 'SQLite')
							{
								let tmpStatement = _Harness.db.prepare(pSQL);
								if (/^\s*SELECT/i.test(pSQL))
								{
									return fCallback(tmpStatement.all(...(pParams || [])).map((pRow) => { return Object.assign({}, pRow); }));
								}
								tmpStatement.run(...(pParams || []));
								return fCallback([]);
							}
							let tmpIndex = 0;
							_Harness.connection.pool.query(pSQL.replace(/\?/g, () => { tmpIndex++; return `$${tmpIndex}`; }), pParams || [],
								(pError, pResult) =>
								{
									Expect(pError).to.not.exist;
									return fCallback((pResult.rows || []).map((pRow) => { let tmpRow = {}; Object.keys(pRow).forEach((pKey) => { let tmpValue = pRow[pKey]; tmpRow[pKey] = ((typeof(tmpValue) === 'string') && /^-?\d+$/.test(tmpValue)) ? Number(tmpValue) : tmpValue; }); return tmpRow; }));
								});
						};

						/**
						 * The store as the wiring installs it (§54.2): configure, the two intake subscribers, start.
						 */
						let fInstall = (fCallback) =>
						{
							let tmpService = _Harness.faceting;
							let tmpFable = _Harness.fable;
							if (!tmpFable.RetoldFacetingMaterializer.started())
							{
								let tmpSection = Object.assign({}, libOptions.STORE_DEFAULTS.ClickHouse, tmpService.options.Stores.ClickHouse);
								tmpFable.RetoldFacetingStoreClickHouse.configure(tmpSection);
							}
							tmpFable.RetoldFacetingChangeIntake.subscribe('Freshness', (pEvent) => { tmpFable.RetoldFacetingFreshness.observe(pEvent); });
							tmpFable.RetoldFacetingChangeIntake.subscribe('Materializer', (pEvent) => { tmpFable.RetoldFacetingMaterializer.onChange(pEvent); });
							return tmpFable.RetoldFacetingMaterializer.start(fCallback);
						};

						let fAssertAll = (fCallback) =>
						{
							let tmpIndex = 0;
							let fNext = () =>
							{
								if (tmpIndex >= _Entities.length)
								{
									return fCallback();
								}
								let tmpEntity = _Entities[tmpIndex++];
								libSupport.assertMirrorEqualsSource(_Harness, STORE, tmpEntity,
									(pError, pReport) =>
									{
										if (pError)
										{
											return fCallback(new Error(`${tmpEntity}: ${pError.message} ${JSON.stringify(pError.Report || {})}`));
										}
										Expect(pReport.Rows, tmpEntity).to.be.above(0);
										return fNext();
									});
							};
							fNext();
						};

						suiteSetup(
							(fDone) =>
							{
								libSupport.ensure(
									(pEnsureError) =>
									{
										if (pEnsureError)
										{
											return fDone(pEnsureError);
										}
										_Database = libSupport.freshDatabase();
										let tmpMaterialize = {};
										_Entities.forEach((pEntity) => { tmpMaterialize[pEntity] = { Store: [ STORE ] }; });
										_Harness = libHarness.start(
											{
												Port: PORT,
												Fixture: 'ProjectTrack',
												Provider: pProvider.Provider,
												Faceting:
													{
														Stores: { ClickHouse: libSupport.storeOptions(_Database) },
														Materialize: tmpMaterialize,
														Materializer: { FlushIntervalMS: 100, IdleTickMS: 10, RebuildPageSize: 500 },
														Reconcile: { AutoStart: false }
													}
											},
											(pError) =>
											{
												if (pError)
												{
													return fDone(pError);
												}
												fInstall(
													(pInstallError) =>
													{
														if (pInstallError)
														{
															return fDone(pInstallError);
														}
														return materializer().quiesce(STORE, null, 60000, fDone);
													});
											});
									});
							});

						suiteTeardown(
							(fDone) =>
							{
								let fRelease = () =>
								{
									if (!_Database)
									{
										return fDone();
									}
									return libSupport.release(_Database, () => { return fDone(); });
								};
								if (!_Harness)
								{
									return fRelease();
								}
								let fStopHarness = () => { _Harness.stop(() => { return fRelease(); }); };
								if (_Harness.fable && _Harness.fable.RetoldFacetingMaterializer)
								{
									return _Harness.fable.RetoldFacetingMaterializer.stop(fStopHarness);
								}
								return fStopHarness();
							});

						test('the backfill mirrors every declared entity: Live, Exact, the mirror equals the source row for row',
							(fDone) =>
							{
								_Entities.forEach((pEntity) => { Expect(freshness().state(STORE, pEntity).State, pEntity).to.equal('Live'); });
								Expect(freshness().entityFreshness(STORE, 'Task').Exact).to.equal(true);
								Expect(store().status()).to.deep.include({ Available: true, Database: _Database });
								fAssertAll(fDone);
							});

						test('CRUD writes reach the mirror: create, update, soft delete, a tenant move by raw SQL + notify; not Exact until applied, then Exact and equal',
							(fDone) =>
							{
								let tmpLead = _Harness.as('Lead');
								fSQL('SELECT "IDTask", "IDProject" FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0 ORDER BY "IDTask" LIMIT 2', [],
									(tmpTask) =>
									{
										fSQL('SELECT "IDProject" FROM "Project" WHERE "IDCustomer" = 1 AND "Deleted" = 0 ORDER BY "IDProject" LIMIT 1', [],
											(pProjects) =>
											{
												let tmpProject = pProjects[0];
												_Harness.request('POST', '/1.0/Task', { Title: 'Materialized', IDProject: tmpProject.IDProject, Status: 'Open', IDCustomer: 1 }, tmpLead,
													(pError) =>
													{
														Expect(pError).to.not.exist;
														// the hint is observed in the same tick as the write: not Exact until it is flushed
														Expect(freshness().entityFreshness(STORE, 'Task').Exact).to.equal(false);
														_Harness.request('PUT', '/1.0/Task', { IDTask: tmpTask[0].IDTask, Status: 'Done' }, tmpLead,
															(pError2) =>
															{
																Expect(pError2).to.not.exist;
																_Harness.request('DELETE', `/1.0/Task/${tmpTask[1].IDTask}`, null, tmpLead,
																	(pError3) =>
																	{
																		Expect(pError3).to.not.exist;
																		// a raw writer: a tenant move and an in-place update, then notify (ids, tenants)
																		fSQL('UPDATE "Project" SET "IDCustomer" = 2, "Status" = ? WHERE "IDProject" = ?', [ 'Moved', tmpProject.IDProject ],
																			() =>
																			{
																				_Harness.faceting.notify('Project', { Operation: 'Update', IDs: [ tmpProject.IDProject ], Tenants: [ 1, 2 ] });
																				materializer().quiesce(STORE, null, 30000,
																					(pQuiesceError) =>
																					{
																						Expect(pQuiesceError).to.not.exist;
																						Expect(freshness().entityFreshness(STORE, 'Task').Exact).to.equal(true);
																						Expect(freshness().entityFreshness(STORE, 'Project').Exact).to.equal(true);
																						store().queryRows(`SELECT count() AS N FROM \`${_Database}\`.\`Project\` FINAL WHERE _IsDeleted = 0 AND IDProject = {p:Int64} AND IDCustomer = 2`, { p: tmpProject.IDProject }, { p: 'Int64' }, {},
																							(pQueryError, pRows) =>
																							{
																								Expect(pQueryError).to.not.exist;
																								Expect(pRows[0].N).to.equal(1);
																								Expect(materializer().status().Stores.ClickHouse.Entities.Task.Flushes).to.be.at.least(1);
																								fAssertAll(fDone);
																							});
																					});
																			});
																	});
															});
													});
											});
									});
							});

						test('a filter-scoped notify (notifyByFilter) is resolved: rows that left and rows that entered the filter are both re-read',
							(fDone) =>
							{
								fSQL('SELECT "IDTask" FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0 AND "Status" = \'Open\' ORDER BY "IDTask" LIMIT 3', [],
									(tmpRows) =>
									{
										Expect(tmpRows.length).to.equal(3);
										// a raw bulk update by predicate, announced by its PRE-write predicate
										let tmpResolved = [];
										let fResolve = materializer().resolveFilter.bind(materializer());
										materializer().resolveFilter = (pStore, pEntity, pFilter, pTenants, pSeqN, fCallback) =>
										{
											return fResolve(pStore, pEntity, pFilter, pTenants, pSeqN, (pError, pResult) => { tmpResolved.push(pResult); if (fCallback) { fCallback(pError, pResult); } });
										};
										fSQL(`UPDATE "Task" SET "Status" = 'Blocked' WHERE "IDTask" IN (${tmpRows.map((pRow) => { return Number(pRow.IDTask); }).join(',')})`, [],
											() =>
											{
												_Harness.faceting.notifyByFilter('Task', 'FBV~Status~EQ~Open', { Tenants: [ 1 ] });
												materializer().quiesce(STORE, [ 'Task' ], 30000,
													(pError) =>
													{
														Expect(pError).to.not.exist;
														delete materializer().resolveFilter;
														// resolved through the compiled mirror predicate ∪ the source (no whole-entity Resync) —
														// once for the notify and once for its settle re-delivery (quiesce waits for both)
														Expect(tmpResolved.length).to.be.within(1, 2);
														tmpResolved.forEach((pResult) => { Expect(pResult.Dirty).to.equal(false); });
														Expect(tmpResolved[0].Enqueued).to.be.at.least(3);
														libSupport.assertMirrorEqualsSource(_Harness, STORE, 'Task', (pAssertError) => { return fDone(pAssertError || null); });
													});
											});
									});
							});

						test('a restart after a clean stop resumes (CatchingUp → Live); after a crash (CleanShutdown = 0) the entity is Unverified until verify, and still equal',
							(fDone) =>
							{
								materializer().stop(
									() =>
									{
										store().readState('Task',
											(pError, pState) =>
											{
												Expect(pError).to.not.exist;
												Expect(pState.CleanShutdown).to.equal(1);
												fInstall(
													() =>
													{
														Expect([ 'CatchingUp', 'Live' ]).to.include(freshness().state(STORE, 'Task').State);
														materializer().quiesce(STORE, null, 30000,
															(pQuiesceError) =>
															{
																Expect(pQuiesceError).to.not.exist;
																Expect(freshness().state(STORE, 'Task').State).to.equal('Live');
																// a crash, a raw change nobody hinted, a restart
																materializer().crash();
																fSQL('UPDATE "Task" SET "Status" = \'WhileDown\' WHERE "IDTask" = (SELECT MIN("IDTask") FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0)', [],
																	() =>
																	{
																		let tmpSeen = [];
																		let fSetState = freshness().setState.bind(freshness());
																		freshness().setState = (pStore, pEntity, pState, pReason) => { if (pEntity === 'Task') { tmpSeen.push(pState); } return fSetState(pStore, pEntity, pState, pReason); };
																		fInstall(
																			() =>
																			{
																				Expect(tmpSeen.filter((pState) => { return pState !== 'Absent'; })[0]).to.equal('Unverified');
																				Expect(freshness().admits(STORE, { Task: [] }, { Mode: 'Exact' }).Admit).to.equal(false);
																				let fLive = (pTries) =>
																				{
																					if ((freshness().state(STORE, 'Task').State !== 'Live') && (pTries < 600))
																					{
																						return setTimeout(() => { fLive(pTries + 1); }, 50);
																					}
																					freshness().setState = fSetState;
																					Expect(freshness().state(STORE, 'Task').State).to.equal('Live');
																					materializer().quiesce(STORE, null, 30000,
																						() =>
																						{
																							fAssertAll(fDone);
																						});
																				};
																				fLive(0);
																			});
																	});
															});
													});
											});
									});
							});
					}
				);
			});
	}
);
