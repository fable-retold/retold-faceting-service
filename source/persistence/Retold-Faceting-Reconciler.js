/**
 * Retold Faceting - Reconciler
 *
 * Finds what no hint reported (design 04 §9; internal-contracts §60) and only ENQUEUES IDs or Range
 * tasks — the WriterLoop's fresh read and keymap diff do every repair:
 *
 *   Sweep   (watermarked entities) compound (UpdateDate, ID) keyset from the watermark − overlap;
 *           every ID in the window → the PendingSet; the watermark advances only after a complete pass
 *   Bisect  { Count, IDSum } per ID bucket, source vs keymap, one pass per side; differing leaves →
 *           IDs on exactly one side; divergence above RebuildDivergenceRatio → a rebuild (Unverified)
 *   Scrub   a paced, rotating, unconditional re-read of ID ranges (ScrubCursor / ScrubbedThrough)
 *   Verify  Bisect + a full Scrub: the way out of Unverified (unclean boot, divergence rebuild)
 *
 *   start(pStore) / stop() / sweep / bisect / scrub (pStore, pEntity, pOptions, fCallback)
 *   verify(pStore, pEntity, fCallback) / status(pStore, pEntity) / isRunning(pStore, pEntity, pLevel)
 *   stateFields(pStore, pEntity)   the SweepWatermark / ScrubCursor / ScrubbedThrough / LastBisect it owns
 *
 * One run per (store, entity, level) at a time: a concurrent call with the same intent JOINS the run
 * in flight (its callback gets that result); a different intent (a full Scrub while a tick runs, a
 * verify's own Bisect while a timer's runs) waits for it and runs next.  The timers (Reconcile.AutoStart)
 * are unref'd and skip a level that is still running.
 *
 * Reads go through MaterializeSource-InProcess (sweep / checksums / readIDs) and the store (keymap
 * checksums and ranges); writes only through Materializer.enqueue and WriterLoop.addRangeTask.  Never
 * throws: every outcome is a callback; logs carry entity names and counts, never values.
 *
 * Contract: internal-contracts §60.  Owner: builder D (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libRebuilder = require('./Retold-Faceting-Rebuilder.js');
const libDDL = require('../store/clickhouse/ClickHouse-DDL.js');

// The reconcile levels (§60).
const LEVELS = Object.freeze([ 'Sweep', 'Bisect', 'Scrub', 'Verify' ]);

// States in which an entity has no usable live table, or its writes are failing: the timers skip
// them, and a Scrub (which writes the live target) refuses them.
const SKIP_STATES = Object.freeze([ 'Absent', 'Building', 'Degraded' ]);

// Range task kinds a scrub() may issue (§58.5): 'Fill' is the additive-column fill (§55.4).
const SCRUB_KINDS = Object.freeze([ 'Scrub', 'Fill' ]);

// A verify gives up (staying Unverified) after this many Bisect passes that escalated or saw a newer
// Unverified trigger.
const VERIFY_MAX_ATTEMPTS = 3;

// The paced rotation issues a Range task once at least this many rows are owed (or the whole entity,
// when it is smaller), so a small entity is not re-read one row per tick.
const SCRUB_MIN_BATCH = 256;

// The divergence check reads at most this many Sweep pages of recently stamped rows; beyond it the
// Bisect is "busy" (heavy write load) and never escalates.
const RECENT_MAX_PAGES = 20;

// IDs per Materializer.enqueue call.
const ENQUEUE_CHUNK = 10000;

const formatUTC = libRebuilder.formatUTC;

/**
 * Epoch ms (UTC) of a stamp: a Date, or a date / date-time text (' ' or 'T' separated, optional
 * fraction, optional Z / ±hh:mm offset; no offset = UTC wall clock, the StorageTimeZone).
 *
 * @param {any} pValue
 * @return {number|null}
 */
const toEpochMS = (pValue) =>
{
	if (pValue instanceof Date)
	{
		let tmpTime = pValue.getTime();
		return Number.isFinite(tmpTime) ? tmpTime : null;
	}
	if (typeof(pValue) !== 'string')
	{
		return null;
	}
	let tmpMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(pValue.trim());
	if (!tmpMatch)
	{
		return null;
	}
	let tmpFraction = tmpMatch[7] ? Number((tmpMatch[7] + '000').slice(0, 3)) : 0;
	let tmpEpoch = Date.UTC(Number(tmpMatch[1]), Number(tmpMatch[2]) - 1, Number(tmpMatch[3]),
		Number(tmpMatch[4] || 0), Number(tmpMatch[5] || 0), Number(tmpMatch[6] || 0), tmpFraction);
	if (!Number.isFinite(tmpEpoch))
	{
		return null;
	}
	let tmpZone = tmpMatch[8];
	if (tmpZone && (tmpZone !== 'Z'))
	{
		let tmpSign = (tmpZone[0] === '-') ? -1 : 1;
		let tmpDigits = tmpZone.slice(1).replace(':', '');
		let tmpOffsetMinutes = (Number(tmpDigits.slice(0, 2)) * 60) + Number(tmpDigits.slice(2, 4) || 0);
		tmpEpoch -= tmpSign * tmpOffsetMinutes * 60000;
	}
	return tmpEpoch;
};

/**
 * 'YYYY-MM-DD HH:mm:ss' (UTC, floored to the second): the lower bound handed to the source.  Second
 * precision and a space separator compare correctly against SQLite's datetime('now') text and
 * conservatively (a superset) against ISO 'T' text; PostgreSQL parses it as a timestamp.
 *
 * @param {number} pEpochMS
 * @return {string}
 */
const formatSecond = (pEpochMS) =>
{
	return new Date(Math.floor(pEpochMS / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * The comparison key of an ID (a number, a bigint, or an integer-literal string all meet here).
 *
 * @param {any} pID
 * @return {string}
 */
const idKey = (pID) =>
{
	if (typeof(pID) === 'string')
	{
		let tmpTrimmed = pID.trim();
		return (/^-?\d+$/.test(tmpTrimmed)) ? String(BigInt(tmpTrimmed)) : tmpTrimmed;
	}
	return String(pID);
};

/**
 * An ID as the PendingSet takes it: a number when it is a safe integer, else as given.
 *
 * @param {any} pID
 * @return {any}
 */
const idValue = (pID) =>
{
	let tmpNumber = Number(pID);
	return Number.isSafeInteger(tmpNumber) ? tmpNumber : pID;
};

/**
 * Do two checksum numbers (numbers, bigints or decimal strings from either side) agree?
 *
 * @param {any} pLeft
 * @param {any} pRight
 * @return {boolean}
 */
const sameNumber = (pLeft, pRight) =>
{
	let tmpLeft = ((pLeft === null) || (pLeft === undefined)) ? '0' : String(pLeft).trim();
	let tmpRight = ((pRight === null) || (pRight === undefined)) ? '0' : String(pRight).trim();
	if (tmpLeft === tmpRight)
	{
		return true;
	}
	if ((/^-?\d+$/.test(tmpLeft)) && (/^-?\d+$/.test(tmpRight)))
	{
		return BigInt(tmpLeft) === BigInt(tmpRight);
	}
	let tmpLeftNumber = Number(tmpLeft);
	let tmpRightNumber = Number(tmpRight);
	return Number.isFinite(tmpLeftNumber) && (tmpLeftNumber === tmpRightNumber);
};

/**
 * The ID range of a checksum bucket (bucket = intDiv(ID, LeafRange), truncating toward zero on every
 * side: SQLite / PostgreSQL integer division and ClickHouse intDiv), as (AfterID, ToID].
 *
 * @param {number} pBucket
 * @param {number} pLeafRange
 * @return {{ AfterID: number, ToID: number }}
 */
const leafBounds = (pBucket, pLeafRange) =>
{
	if (pBucket > 0)
	{
		return { AfterID: (pBucket * pLeafRange) - 1, ToID: (pBucket * pLeafRange) + pLeafRange - 1 };
	}
	if (pBucket === 0)
	{
		return { AfterID: -pLeafRange, ToID: pLeafRange - 1 };
	}
	return { AfterID: (pBucket * pLeafRange) - pLeafRange, ToID: pBucket * pLeafRange };
};

/**
 * The buckets of a checksum map whose { Count, IDSum } differ between the two sides (or exist on one
 * side only), ascending.  Bucket keys are normalized (a '3' and a 3 are the same bucket).
 *
 * @param {Record<string, { Count: any, IDSum: any }>} pSource
 * @param {Record<string, { Count: any, IDSum: any }>} pStore
 * @return {{ Buckets: number, Differing: Array<number>, SourceTotal: number }}
 */
const diffChecksums = (pSource, pStore) =>
{
	let tmpSource = new Map();
	let tmpStore = new Map();
	let tmpTotal = 0;
	Object.keys(pSource || {}).forEach(
		(pKey) =>
		{
			let tmpEntry = pSource[pKey] || {};
			tmpSource.set(idKey(pKey), tmpEntry);
			tmpTotal += Number(tmpEntry.Count) || 0;
		});
	Object.keys(pStore || {}).forEach((pKey) => { tmpStore.set(idKey(pKey), pStore[pKey] || {}); });
	let tmpAll = new Set([ ...tmpSource.keys(), ...tmpStore.keys() ]);
	let tmpDiffering = [];
	tmpAll.forEach(
		(pKey) =>
		{
			let tmpLeft = tmpSource.get(pKey) || { Count: 0, IDSum: 0 };
			let tmpRight = tmpStore.get(pKey) || { Count: 0, IDSum: 0 };
			if (!sameNumber(tmpLeft.Count, tmpRight.Count) || !sameNumber(tmpLeft.IDSum, tmpRight.IDSum))
			{
				tmpDiffering.push(Number(pKey));
			}
		});
	tmpDiffering.sort((pA, pB) => { return pA - pB; });
	return { Buckets: tmpAll.size, Differing: tmpDiffering, SourceTotal: tmpTotal };
};

/**
 * The IDs present on exactly one side of a leaf: live source IDs ([ { ID, Live } ]) vs the keymap's
 * live IDs (a Map, or an object / array of IDs).
 *
 * @param {Array<{ ID: any, Live: any }>} pSourceIDs
 * @param {any} pKeys
 * @return {Array<any>}
 */
const leafDifference = (pSourceIDs, pKeys) =>
{
	let tmpSource = new Map();
	(Array.isArray(pSourceIDs) ? pSourceIDs : []).forEach(
		(pEntry) =>
		{
			if (pEntry && (pEntry.Live === true || pEntry.Live === 1 || pEntry.Live === '1'))
			{
				tmpSource.set(idKey(pEntry.ID), pEntry.ID);
			}
		});
	let tmpKeymap = new Map();
	if (pKeys instanceof Map)
	{
		pKeys.forEach((pValue, pID) => { tmpKeymap.set(idKey(pID), pID); });
	}
	else if (Array.isArray(pKeys))
	{
		pKeys.forEach((pID) => { tmpKeymap.set(idKey(pID), pID); });
	}
	else if (pKeys && (typeof(pKeys) === 'object'))
	{
		Object.keys(pKeys).forEach((pID) => { tmpKeymap.set(idKey(pID), pID); });
	}
	let tmpDifferent = [];
	tmpSource.forEach((pID, pKey) => { if (!tmpKeymap.has(pKey)) { tmpDifferent.push(pID); } });
	tmpKeymap.forEach((pID, pKey) => { if (!tmpSource.has(pKey)) { tmpDifferent.push(pID); } });
	return tmpDifferent;
};

class RetoldFacetingReconciler extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingReconciler';

		// every timer (unref'd); stop() clears them
		this._Timers = [];
		// 'S:E' → [ timers ] (so start() is idempotent per entity)
		this._EntityTimers = new Map();
		// 'S:E' → the entity's reconcile record
		this._Entities = new Map();
		// 'S:E:Level' → { JoinKey, Callbacks, Queue }
		this._Running = new Map();
		this._Stopped = false;
		// Store → { Running: boolean, Queue: [ fRun ] }: timed Bisects run one entity at a time per store
		// (each is a full-table aggregate on the primary).
		this._BisectQueues = {};
		this._Stats = { Sweeps: 0, Bisects: 0, Scrubs: 0, Verifies: 0, Enqueued: 0, Rebuilds: 0, Errors: 0, SweepSkipped: 0 };
	}

	// ---- options ------------------------------------------------------------------------------

	/**
	 * @param {string} pName
	 * @param {number} pDefault
	 * @param {number} [pMin]
	 * @return {number}
	 */
	_number(pName, pDefault, pMin)
	{
		let tmpReconcile = this.options.Reconcile || {};
		let tmpValue = Number(tmpReconcile[pName]);
		let tmpMin = (typeof(pMin) === 'number') ? pMin : 0;
		return (Number.isFinite(tmpValue) && (tmpValue >= tmpMin)) ? tmpValue : pDefault;
	}

	/**
	 * The Sweep / divergence overlap: Reconcile.MaxTxnMS, plus an hour when the source compares stamps
	 * in a session time zone that is not UTC (PostgreSQL `timestamp` repeats an hour at the DST
	 * fall-back).  In-process the session zone is the process zone; SQLite stamps are always UTC.
	 *
	 * @param {string} pEntity
	 * @return {number}
	 */
	overlapMS(pEntity)
	{
		let tmpOverlap = this._number('MaxTxnMS', 60000, 0);
		let tmpSource = this.fable.RetoldFacetingMaterializeSourceInProcess;
		let tmpDialect = null;
		try
		{
			tmpDialect = (tmpSource && (typeof(tmpSource.dialect) === 'function')) ? tmpSource.dialect(pEntity) : null;
		}
		catch (pError)
		{
			tmpDialect = null;
		}
		if ((tmpDialect !== 'SQLite') && (new Date().getTimezoneOffset() !== 0))
		{
			tmpOverlap += 3600000;
		}
		return tmpOverlap;
	}

	/**
	 * Reconcile.SweepIntervalMS for an entity ('Auto': 600000 when a change source sees its writes and
	 * it is not a RawWriterEntities entry, else 60000).
	 *
	 * @param {string} pEntity
	 * @return {number}
	 */
	sweepIntervalMS(pEntity)
	{
		let tmpReconcile = this.options.Reconcile || {};
		let tmpConfigured = Number(tmpReconcile.SweepIntervalMS);
		if ((tmpReconcile.SweepIntervalMS !== 'Auto') && Number.isFinite(tmpConfigured) && (tmpConfigured > 0))
		{
			return tmpConfigured;
		}
		let tmpRaw = Array.isArray(tmpReconcile.RawWriterEntities) && (tmpReconcile.RawWriterEntities.indexOf(pEntity) >= 0);
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpCovered = false;
		try
		{
			tmpCovered = !!(tmpIntake && (typeof(tmpIntake.covers) === 'function') && tmpIntake.covers(pEntity));
		}
		catch (pError)
		{
			tmpCovered = false;
		}
		return (tmpCovered && !tmpRaw) ? 600000 : 60000;
	}

	/**
	 * The paced Scrub ceiling per tick: ScrubRowsPerSecond × ScrubTickMS / 1000 (at least 1).
	 *
	 * @return {number}
	 */
	scrubTickCap()
	{
		let tmpRate = this._number('ScrubRowsPerSecond', 2000, 1);
		let tmpTick = this._number('ScrubTickMS', 1000, 1);
		return Math.max(1, Math.floor((tmpRate * tmpTick) / 1000));
	}

	/**
	 * Rows per Range task of a full Scrub ("as fast as the loop allows"): the tick ceiling or
	 * Materializer.BatchIDs, whichever is larger.
	 *
	 * @return {number}
	 */
	scrubFullCap()
	{
		let tmpMaterializer = this.options.Materializer || {};
		let tmpBatch = Number(tmpMaterializer.BatchIDs);
		return Math.max(this.scrubTickCap(), (Number.isFinite(tmpBatch) && (tmpBatch >= 1)) ? Math.floor(tmpBatch) : 2000);
	}

	// ---- collaborators ------------------------------------------------------------------------

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null} the MirrorSpec
	 */
	_spec(pStore, pEntity)
	{
		try
		{
			let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
			if (tmpMirrorSpec && (typeof(tmpMirrorSpec.spec) === 'function'))
			{
				let tmpSpec = tmpMirrorSpec.spec(pStore, pEntity);
				if (tmpSpec)
				{
					return tmpSpec;
				}
			}
			let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
			if (tmpMaterializer && (typeof(tmpMaterializer.entityInfo) === 'function'))
			{
				let tmpInfo = tmpMaterializer.entityInfo(pStore, pEntity);
				if (tmpInfo && tmpInfo.Spec)
				{
					return tmpInfo.Spec;
				}
			}
		}
		catch (pError)
		{
			return null;
		}
		return null;
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null} the WriterLoop
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
	 * The collaborators of a run, or the error a caller gets (404 for an entity the store does not
	 * materialize, 503 when the materializer / source / store is missing).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {{ Error: Error|null, Spec?: Record<string, any>, Loop?: Record<string, any>, Source?: Record<string, any>, Store?: Record<string, any> }}
	 */
	_context(pStore, pEntity)
	{
		let tmpSpec = this._spec(pStore, pEntity);
		let tmpLoop = this._loop(pStore, pEntity);
		if (!tmpSpec || !tmpLoop)
		{
			return { Error: libFacetErrors.create('FACET_UNKNOWN_ENTITY', `RetoldFacetingReconciler: ${pStore}.${pEntity} is not materialized.`, { Store: pStore, Entity: pEntity }) };
		}
		let tmpSource = this.fable.RetoldFacetingMaterializeSourceInProcess;
		let tmpStore = libRebuilder.storeService(this.fable, pStore);
		if (!tmpSource || !tmpStore)
		{
			return { Error: libFacetErrors.create('FACET_ENGINE_UNAVAILABLE', `RetoldFacetingReconciler: ${pStore} is not available.`, { Store: pStore }) };
		}
		return { Error: null, Spec: tmpSpec, Loop: tmpLoop, Source: tmpSource, Store: tmpStore };
	}

	/**
	 * The entity's reconcile record (created on first use).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	_record(pStore, pEntity)
	{
		let tmpKey = `${pStore}:${pEntity}`;
		let tmpRecord = this._Entities.get(tmpKey);
		if (!tmpRecord)
		{
			tmpRecord = (
				{
					Store: pStore, Entity: pEntity, Loaded: false,
					LastSweep: null, Watermark: null,
					LastBisect: null, Divergence: null,
					ScrubCursor: null, ScrubbedThrough: null, ScrubPassStart: null, PassRows: 0, Total: null, Owed: 0,
					LastVerify: null
				});
			this._Entities.set(tmpKey, tmpRecord);
		}
		return tmpRecord;
	}

	/**
	 * Seed a record once from the persisted state row (SweepWatermark, ScrubCursor, ScrubbedThrough,
	 * LastBisect).  The row is read WITHOUT Store.readState: that call refreshes the store's own
	 * cache of the row, and a read racing the Materializer's state write (CleanShutdown 0 at start)
	 * could put the older row back under the next merged write.  Sources, in order: the
	 * Materializer's stateRow(S, E) (the row it read at start), entityInfo(S, E).StateRow, a plain
	 * FINAL read of _rfs_entity_state through queryRows (ClickHouse: the store exposes Database).
	 * A failure leaves the record unseeded (retried on the next run); never fatal.
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pStore - the store service
	 * @param {Function} fCallback
	 */
	_load(pRecord, pStore, fCallback)
	{
		if (pRecord.Loaded)
		{
			return fCallback();
		}
		let fSeed = (pState) =>
		{
			pRecord.Loaded = true;
			if (!pState || (typeof(pState) !== 'object'))
			{
				return fCallback();
			}
			let tmpWatermark = pState.SweepWatermark;
			if ((pRecord.Watermark === null) && (typeof(tmpWatermark) === 'string') && (toEpochMS(tmpWatermark) !== null))
			{
				pRecord.Watermark = formatUTC(toEpochMS(tmpWatermark));
			}
			let tmpCursor = Number(pState.ScrubCursor);
			if ((pRecord.ScrubCursor === null) && (pState.ScrubCursor !== null) && (pState.ScrubCursor !== undefined) && Number.isSafeInteger(tmpCursor))
			{
				pRecord.ScrubCursor = tmpCursor;
			}
			let fDate = (pValue) =>
			{
				let tmpMS = (typeof(pValue) === 'number') ? pValue : toEpochMS(pValue);
				return ((tmpMS === null) || !Number.isFinite(tmpMS) || (tmpMS <= 0)) ? null : formatUTC(tmpMS);
			};
			if (pRecord.ScrubbedThrough === null)
			{
				pRecord.ScrubbedThrough = fDate(pState.ScrubbedThrough);
			}
			if (pRecord.LastBisect === null)
			{
				pRecord.LastBisect = fDate(pState.LastBisect);
			}
			return fCallback();
		};
		try
		{
			let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
			if (tmpMaterializer && (typeof(tmpMaterializer.stateRow) === 'function'))
			{
				return fSeed(tmpMaterializer.stateRow(pRecord.Store, pRecord.Entity));
			}
			if (tmpMaterializer && (typeof(tmpMaterializer.entityInfo) === 'function'))
			{
				let tmpInfo = tmpMaterializer.entityInfo(pRecord.Store, pRecord.Entity);
				if (tmpInfo && tmpInfo.StateRow && (typeof(tmpInfo.StateRow) === 'object'))
				{
					return fSeed(tmpInfo.StateRow);
				}
			}
		}
		catch (pError)
		{
			// fall through to the plain read
		}
		if (!pStore || (typeof(pStore.queryRows) !== 'function') || (typeof(pStore.Database) !== 'string') || !libDDL.IDENTIFIER_PATTERN.test(pStore.Database))
		{
			pRecord.Loaded = true;
			return fCallback();
		}
		let tmpCalled = false;
		try
		{
			pStore.queryRows(`SELECT \`SweepWatermark\`, \`ScrubCursor\`, toString(\`ScrubbedThrough\`) AS ScrubbedThrough, toString(\`LastBisect\`) AS LastBisect FROM ${libDDL.qualified(pStore.Database, libDDL.STATE_TABLE)} FINAL WHERE \`Store\` = {s:String} AND \`Entity\` = {e:String}`,
				{ s: pRecord.Store, e: pRecord.Entity }, { s: 'String', e: 'String' }, null,
				(pError, pRows) =>
				{
					if (tmpCalled)
					{
						return;
					}
					tmpCalled = true;
					if (pError)
					{
						// Unseeded: the next run tries again.
						return fCallback();
					}
					return fSeed((Array.isArray(pRows) && pRows.length > 0) ? pRows[0] : null);
				});
		}
		catch (pError)
		{
			if (!tmpCalled)
			{
				tmpCalled = true;
				return fCallback();
			}
		}
	}

	/**
	 * Persist reconcile fields of the state row (best effort; logged, never fatal).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pFields
	 */
	_persist(pStore, pEntity, pFields)
	{
		libRebuilder.persistStateFields(this.fable, pStore, pEntity, pFields,
			(pError) =>
			{
				if (pError)
				{
					this.log.warn(`RetoldFaceting: could not persist the reconcile state of ${pStore}.${pEntity}: ${pError.message}`);
				}
			});
	}

	/**
	 * Enqueue IDs for a re-read (chunked); returns how many the Materializer took.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Array<any>} pIDs
	 * @param {string} pSource - 'Sweep' | 'Bisect' | 'Scrub' | 'Admin'
	 * @return {number}
	 */
	_enqueue(pStore, pEntity, pIDs, pSource)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || (typeof(tmpMaterializer.enqueue) !== 'function') || !Array.isArray(pIDs) || (pIDs.length < 1))
		{
			return 0;
		}
		let tmpCount = 0;
		for (let i = 0; i < pIDs.length; i += ENQUEUE_CHUNK)
		{
			let tmpChunk = pIDs.slice(i, i + ENQUEUE_CHUNK).map(idValue);
			let tmpTaken = tmpMaterializer.enqueue(pStore, pEntity, tmpChunk, { Source: pSource, SeqN: null });
			tmpCount += (typeof(tmpTaken) === 'number') ? tmpTaken : tmpChunk.length;
		}
		this._Stats.Enqueued += tmpCount;
		return tmpCount;
	}

	/**
	 * Run fWork exclusively per (store, entity, level): the same pJoinKey joins a run in flight, a
	 * different one waits for it.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pLevel
	 * @param {string} pJoinKey
	 * @param {(fDone: (pError?: Error|null, pResult?: any) => void) => void} fWork
	 * @param {Function} fCallback
	 */
	_run(pStore, pEntity, pLevel, pJoinKey, fWork, fCallback)
	{
		let tmpKey = `${pStore}:${pEntity}:${pLevel}`;
		let tmpRunning = this._Running.get(tmpKey);
		if (tmpRunning)
		{
			if (tmpRunning.JoinKey === pJoinKey)
			{
				tmpRunning.Callbacks.push(fCallback);
				return;
			}
			tmpRunning.Queue.push(() => { this._run(pStore, pEntity, pLevel, pJoinKey, fWork, fCallback); });
			return;
		}
		tmpRunning = { JoinKey: pJoinKey, Callbacks: [ fCallback ], Queue: [] };
		this._Running.set(tmpKey, tmpRunning);
		let tmpFinished = false;
		let fDone = (pError, pResult) =>
		{
			if (tmpFinished)
			{
				return;
			}
			tmpFinished = true;
			if (this._Running.get(tmpKey) === tmpRunning)
			{
				this._Running.delete(tmpKey);
			}
			if (pError)
			{
				this._Stats.Errors++;
			}
			libRebuilder.callAll(tmpRunning.Callbacks, [ pError || null, pResult ]);
			// The next queued intent (after the callbacks: a waiter may have queued more).
			let tmpQueue = tmpRunning.Queue;
			if (tmpQueue.length > 0)
			{
				let fNext = tmpQueue.shift();
				let tmpRest = tmpQueue.splice(0);
				fNext();
				let tmpNext = this._Running.get(tmpKey);
				if (tmpNext)
				{
					tmpNext.Queue.push(...tmpRest);
				}
				else
				{
					tmpRest.forEach((fQueued) => { fQueued(); });
				}
			}
		};
		try
		{
			fWork(fDone);
		}
		catch (pError)
		{
			fDone(pError);
		}
	}

	/**
	 * Is a level running for (store, entity)?  (storeAdmin's one-in-flight rule.)
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pLevel
	 * @return {boolean}
	 */
	isRunning(pStore, pEntity, pLevel)
	{
		return this._Running.has(`${pStore}:${pEntity}:${pLevel}`);
	}

	// ---- timers -------------------------------------------------------------------------------

	/**
	 * Start the per-entity timers of a store (Reconcile.AutoStart; idempotent per entity: a second
	 * call only adds entities that gained a spec and drops those that lost theirs).
	 *
	 * @param {string} pStore
	 */
	start(pStore)
	{
		let tmpReconcile = this.options.Reconcile || {};
		if (tmpReconcile.AutoStart === false)
		{
			return;
		}
		this._Stopped = false;
		let tmpEntities = [];
		try
		{
			let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
			tmpEntities = (tmpMirrorSpec && (typeof(tmpMirrorSpec.entities) === 'function')) ? (tmpMirrorSpec.entities(pStore) || []) : [];
		}
		catch (pError)
		{
			tmpEntities = [];
		}
		// Entities that lost their spec: stop their timers.
		this._EntityTimers.forEach(
			(pTimers, pKey) =>
			{
				let tmpParts = pKey.split(':');
				if ((tmpParts[0] === pStore) && (tmpEntities.indexOf(tmpParts.slice(1).join(':')) < 0))
				{
					pTimers.forEach((pTimer) => { clearInterval(pTimer); });
					this._Timers = this._Timers.filter((pTimer) => { return pTimers.indexOf(pTimer) < 0; });
					this._EntityTimers.delete(pKey);
				}
			});
		tmpEntities.forEach(
			(pEntity) =>
			{
				let tmpKey = `${pStore}:${pEntity}`;
				if (this._EntityTimers.has(tmpKey))
				{
					return;
				}
				let tmpSpec = this._spec(pStore, pEntity);
				if (!tmpSpec)
				{
					return;
				}
				let tmpTimers = [];
				let fEvery = (pMS, fTick) =>
				{
					let tmpTimer = setInterval(fTick, Math.max(1, Math.floor(pMS)));
					if (typeof(tmpTimer.unref) === 'function')
					{
						tmpTimer.unref();
					}
					tmpTimers.push(tmpTimer);
					this._Timers.push(tmpTimer);
				};
				// Sweep / Bisect timers start at a random phase and run with a jittered period (± JitterRatio),
				// so every entity's full-table work never hits the primary at the same instant.
				let tmpJitter = Math.min(0.9, this._number('JitterRatio', 0.15, 0));
				let fJittered = (pMS, fTick) =>
				{
					let tmpHolder = { Timer: null };
					let fNext = (pDelay) =>
					{
						tmpHolder.Timer = setTimeout(
							() =>
							{
								if (this._Stopped || (this._EntityTimers.get(tmpKey) !== tmpTimers))
								{
									return;
								}
								fTick();
								fNext(pMS * (1 + tmpJitter * ((Math.random() * 2) - 1)));
							}, Math.max(1, Math.floor(pDelay)));
						if (typeof(tmpHolder.Timer.unref) === 'function')
						{
							tmpHolder.Timer.unref();
						}
						let tmpIndex = tmpTimers.indexOf(tmpHolder.Previous);
						if (tmpIndex >= 0)
						{
							tmpTimers[tmpIndex] = tmpHolder.Timer;
						}
						else
						{
							tmpTimers.push(tmpHolder.Timer);
						}
						let tmpGlobal = this._Timers.indexOf(tmpHolder.Previous);
						if (tmpGlobal >= 0)
						{
							this._Timers[tmpGlobal] = tmpHolder.Timer;
						}
						else
						{
							this._Timers.push(tmpHolder.Timer);
						}
						tmpHolder.Previous = tmpHolder.Timer;
					};
					fNext((tmpJitter > 0) ? (pMS * Math.random()) + 1 : pMS);
				};
				if (tmpSpec.Watermark)
				{
					fJittered(this.sweepIntervalMS(pEntity), () => { this._timerRun(pStore, pEntity, 'Sweep'); });
				}
				fJittered(tmpSpec.Watermark ? this._number('BisectIntervalMS', 86400000, 1) : this._number('HardDeleteBisectIntervalMS', 3600000, 1),
					() => { this._timerRun(pStore, pEntity, 'Bisect'); });
				fEvery(this._number('ScrubTickMS', 1000, 1), () => { this._scrubTick(pStore, pEntity); });
				this._EntityTimers.set(tmpKey, tmpTimers);
				this._seedTotal(pStore, pEntity);
			});
	}

	/**
	 * The paced Scrub needs the entity's row count: seed it cheaply (the store's active-part row count,
	 * an upper bound) instead of scrubbing at the ceiling until the first wrap or Bisect.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 */
	_seedTotal(pStore, pEntity)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let tmpStore = libRebuilder.storeService(this.fable, pStore);
		if ((tmpRecord.Total !== null) || !tmpStore || (typeof(tmpStore.approximateRows) !== 'function'))
		{
			return;
		}
		try
		{
			tmpStore.approximateRows(pEntity,
				(pError, pRows) =>
				{
					if (!pError && Number.isFinite(pRows) && (tmpRecord.Total === null))
					{
						tmpRecord.Total = Math.max(0, pRows);
					}
				});
		}
		catch (pError)
		{
			// Unseeded: the conservative pace applies until the first wrap.
		}
	}

	/**
	 * The Rebuilder recorded a Sweep watermark for a build that swapped in: the next Sweep starts there.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pWatermark - the source's stamp text
	 */
	seedWatermark(pStore, pEntity, pWatermark)
	{
		let tmpMS = toEpochMS(pWatermark);
		if (tmpMS === null)
		{
			return;
		}
		let tmpRecord = this._record(pStore, pEntity);
		let tmpCurrent = toEpochMS(tmpRecord.Watermark);
		if ((tmpCurrent === null) || (tmpMS > tmpCurrent))
		{
			tmpRecord.Watermark = formatUTC(tmpMS);
		}
	}

	/**
	 * Stop the timers of one store's entities (the store's lease was lost; a new start re-creates them).
	 *
	 * @param {string} pStore
	 */
	stopStore(pStore)
	{
		Array.from(this._EntityTimers.keys()).forEach(
			(pKey) =>
			{
				if (pKey.split(':')[0] !== pStore)
				{
					return;
				}
				let tmpTimers = this._EntityTimers.get(pKey) || [];
				tmpTimers.forEach((pTimer) => { clearTimeout(pTimer); clearInterval(pTimer); });
				this._Timers = this._Timers.filter((pTimer) => { return tmpTimers.indexOf(pTimer) < 0; });
				this._EntityTimers.delete(pKey);
				this._Entities.delete(pKey);
			});
		delete this._BisectQueues[pStore];
	}

	/**
	 * Clear every timer and forget the in-memory reconcile records (as a process exit would: the next
	 * start re-seeds them from the persisted state row).  Runs in flight finish (their callbacks still
	 * fire; what they learn after this point is not kept).
	 */
	stop()
	{
		this._Stopped = true;
		this._Timers.forEach((pTimer) => { clearTimeout(pTimer); clearInterval(pTimer); });
		this._Timers = [];
		this._EntityTimers.clear();
		this._Entities.clear();
	}

	/**
	 * May a timer run a level now?  Not after stop(), not while it runs, not in a skip state.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pLevel
	 * @return {boolean}
	 */
	_timerMay(pStore, pEntity, pLevel)
	{
		if (this._Stopped || this.isRunning(pStore, pEntity, pLevel))
		{
			return false;
		}
		let tmpState = libRebuilder.entityState(this.fable, pStore, pEntity).State;
		return (SKIP_STATES.indexOf(tmpState) < 0) && (tmpState !== 'Rebuilding');
	}

	/**
	 * A Sweep / Bisect timer tick.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pLevel
	 */
	_timerRun(pStore, pEntity, pLevel)
	{
		if (!this._timerMay(pStore, pEntity, pLevel))
		{
			return;
		}
		let fLogged = (pError) =>
		{
			if (pError)
			{
				this.log.warn(`RetoldFaceting: the timed ${pLevel} of ${pStore}.${pEntity} failed: ${pError.message}`);
			}
		};
		if (pLevel === 'Sweep')
		{
			return this.sweep(pStore, pEntity, {}, fLogged);
		}
		// Timed Bisects run one entity at a time per store.
		if (!this._BisectQueues[pStore])
		{
			this._BisectQueues[pStore] = { Running: false, Queue: [], Keys: new Set() };
		}
		let tmpQueue = this._BisectQueues[pStore];
		if (tmpQueue.Keys.has(pEntity))
		{
			return;
		}
		tmpQueue.Keys.add(pEntity);
		let fRun = () =>
		{
			tmpQueue.Running = true;
			this.bisect(pStore, pEntity, {},
				(pError) =>
				{
					tmpQueue.Running = false;
					tmpQueue.Keys.delete(pEntity);
					fLogged(pError);
					if ((tmpQueue.Queue.length > 0) && !this._Stopped && (this._BisectQueues[pStore] === tmpQueue))
					{
						let fNext = tmpQueue.Queue.shift();
						setImmediate(fNext);
					}
				});
		};
		if (tmpQueue.Running)
		{
			tmpQueue.Queue.push(() => { if (this._timerMay(pStore, pEntity, 'Bisect')) { return fRun(); } tmpQueue.Keys.delete(pEntity); if (tmpQueue.Queue.length > 0) { setImmediate(tmpQueue.Queue.shift()); } });
			return;
		}
		return fRun();
	}

	/**
	 * The paced Scrub rotation: each tick owes Total × ScrubTickMS / ScrubPeriodMS rows (the tick
	 * ceiling while Total is unknown, i.e. before the first wrap or Bisect), capped by the ceiling;
	 * a Range task is issued once SCRUB_MIN_BATCH rows (or the whole entity) are owed.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 */
	_scrubTick(pStore, pEntity)
	{
		if (!this._timerMay(pStore, pEntity, 'Scrub'))
		{
			return;
		}
		let tmpRecord = this._record(pStore, pEntity);
		let tmpCeiling = this.scrubTickCap();
		let tmpPeriod = this._number('ScrubPeriodMS', 86400000, 1);
		let tmpTick = this._number('ScrubTickMS', 1000, 1);
		// Until the row count is known (no seed, no wrap, no Bisect yet) a conservative pace — never the
		// ceiling, which after every restart would re-read every large entity at full speed.
		let tmpUnknown = Math.min(tmpCeiling, Math.max(1, this._number('ScrubUnknownTotalRowsPerTick', 256, 1)));
		let tmpPerTick = (tmpRecord.Total === null) ? tmpUnknown : Math.min(tmpCeiling, (tmpRecord.Total * tmpTick) / tmpPeriod);
		tmpRecord.Owed = Math.min(tmpCeiling, tmpRecord.Owed + tmpPerTick);
		let tmpThreshold = Math.min(tmpCeiling, SCRUB_MIN_BATCH, (tmpRecord.Total === null) ? tmpUnknown : Math.max(1, tmpRecord.Total));
		if (tmpRecord.Owed < tmpThreshold)
		{
			return;
		}
		let tmpCap = Math.max(1, Math.floor(tmpRecord.Owed));
		tmpRecord.Owed = Math.max(0, tmpRecord.Owed - tmpCap);
		this.scrub(pStore, pEntity, { Cap: tmpCap },
			(pError) =>
			{
				if (pError)
				{
					this.log.warn(`RetoldFaceting: the timed Scrub of ${pStore}.${pEntity} failed: ${pError.message}`);
				}
			});
	}

	// ---- Sweep --------------------------------------------------------------------------------

	/**
	 * One complete Sweep pass from (Watermark − OverlapMS) (or from the start with no watermark):
	 * every ID stamped in the window is enqueued (no compare); the watermark becomes the largest
	 * stamp seen, and is persisted, only when the pass completed.
	 *
	 * IDs already pending are hinted again rather than skipped: a re-hint of an ID still waiting is
	 * free (it is read once anyway), and a re-hint of an ID IN FLIGHT is exactly what keeps a raw,
	 * stamped write that committed after that cycle's read from being acked away (§58.3) — skipping
	 * it would leave that write to the Scrub.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ From?: { At: any, ID: any }|null, Cap?: number }} pOptions
	 * @param {(pError?: Error|null, pResult?: { Enqueued: number, Watermark: string|null, Pages: number, Skipped?: string }) => void} fCallback
	 */
	sweep(pStore, pEntity, pOptions, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : ((typeof(pOptions) === 'function') ? pOptions : () => {});
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let tmpContext = this._context(pStore, pEntity);
		if (tmpContext.Error)
		{
			return fDone(tmpContext.Error);
		}
		let tmpColumn = tmpContext.Spec.Watermark;
		if (!tmpColumn)
		{
			return fDone(null, { Enqueued: 0, Watermark: null, Pages: 0, Skipped: 'NoWatermark' });
		}
		let tmpRecord = this._record(pStore, pEntity);
		this._run(pStore, pEntity, 'Sweep', 'Sweep',
			(fRunDone) =>
			{
				this._load(tmpRecord, tmpContext.Store,
					() =>
					{
						this._Stats.Sweeps++;
						let tmpCap = Math.max(1, Math.floor(Number(tmpOptions.Cap) || this._number('SweepCap', 5000, 1)));
						let tmpFrom = null;
						if (Object.prototype.hasOwnProperty.call(tmpOptions, 'From'))
						{
							tmpFrom = tmpOptions.From || { At: null, ID: null };
						}
						else
						{
							let tmpWatermark = toEpochMS(tmpRecord.Watermark);
							// { At: t, ID: null } is "At >= t" (the window start); a page's Next carries the ID.
							tmpFrom = (tmpWatermark === null) ? { At: null, ID: null } : { At: formatSecond(tmpWatermark - this.overlapMS(pEntity)), ID: null };
						}
						let tmpEnqueued = 0;
						let tmpPages = 0;
						let tmpMaxMS = null;
						let fPage = null;
						let fAfterPage = (pRows, pNext, pFrom) =>
						{
							if (!pNext || (pRows.length < tmpCap))
							{
								// A complete pass: the watermark advances (DB stamps only).
								if (tmpMaxMS !== null)
								{
									tmpRecord.Watermark = formatUTC(tmpMaxMS);
									this._persist(pStore, pEntity, { SweepWatermark: tmpRecord.Watermark });
								}
								tmpRecord.LastSweep = new Date().toISOString();
								return fRunDone(null, { Enqueued: tmpEnqueued, Watermark: tmpRecord.Watermark, Pages: tmpPages });
							}
							if (JSON.stringify(pNext) === JSON.stringify(pFrom))
							{
								return fRunDone(new Error(`RetoldFacetingReconciler: the Sweep cursor of ${pStore}.${pEntity} did not advance.`));
							}
							return fPage(pNext);
						};
						fPage = (pFrom) =>
						{
							let tmpCalled = false;
							try
							{
								tmpContext.Source.sweep(pEntity, { Column: tmpColumn, From: pFrom, Cap: tmpCap },
									(pError, pPage) =>
									{
										if (tmpCalled)
										{
											return;
										}
										tmpCalled = true;
										if (pError)
										{
											return fRunDone(pError);
										}
										let tmpRows = (pPage && Array.isArray(pPage.Rows)) ? pPage.Rows : [];
										tmpPages++;
										for (let i = 0; i < tmpRows.length; i++)
										{
											let tmpAt = toEpochMS((tmpRows[i] || {}).At);
											if ((tmpAt !== null) && ((tmpMaxMS === null) || (tmpAt > tmpMaxMS)))
											{
												tmpMaxMS = tmpAt;
											}
										}
										let tmpNext = pPage ? pPage.Next : null;
										// Only rows newer than what the mirror holds are re-read (the keymap's stamp),
										// and never faster than the loop applies them (no PendingSet overflow).
										return this._sweepCandidates(pStore, pEntity, tmpContext, tmpRows,
											(pCandidates) =>
											{
												this._waitForRoom(pStore, pEntity,
													() =>
													{
														tmpEnqueued += this._enqueue(pStore, pEntity, pCandidates, 'Sweep');
														return fAfterPage(tmpRows, tmpNext, pFrom);
													});
											});
									});
							}
							catch (pError)
							{
								if (!tmpCalled)
								{
									tmpCalled = true;
									return fRunDone(pError);
								}
							}
						};
						fPage(tmpFrom);
					});
			}, fDone);
	}

	/**
	 * The IDs of a Sweep page worth re-reading: those the mirror does not hold, or whose source stamp is
	 * newer than the stamp its keymap recorded (or ties it at the mirror's millisecond precision while the
	 * source carries more), so a steady-state Sweep re-reads only what changed — not every row of its
	 * window.  Without a usable keymap stamp every ID is a candidate (the old, unfiltered rule).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pContext
	 * @param {Array<{ ID: any, At: any }>} pRows
	 * @param {(pCandidates: Array<any>) => void} fCallback
	 */
	_sweepCandidates(pStore, pEntity, pContext, pRows, fCallback)
	{
		let tmpAll = [];
		pRows.forEach((pRow) => { if (pRow && (pRow.ID !== null) && (pRow.ID !== undefined)) { tmpAll.push(pRow); } });
		let tmpSpec = pContext.Spec;
		let tmpHasStamp = Array.isArray(tmpSpec.KeymapColumns) && (tmpSpec.KeymapColumns.indexOf(tmpSpec.Watermark) >= 0);
		if ((tmpAll.length < 1) || !tmpHasStamp || !pContext.Store || (typeof(pContext.Store.readKeys) !== 'function'))
		{
			return fCallback(tmpAll.map((pRow) => { return pRow.ID; }));
		}
		let tmpCalled = false;
		try
		{
			pContext.Store.readKeys(pEntity, tmpAll.map((pRow) => { return idValue(pRow.ID); }).filter((pID) => { return Number.isSafeInteger(pID); }), 'Live',
				(pError, pKeys) =>
				{
					if (tmpCalled)
					{
						return;
					}
					tmpCalled = true;
					if (pError || !(pKeys instanceof Map))
					{
						return fCallback(tmpAll.map((pRow) => { return pRow.ID; }));
					}
					let tmpCandidates = [];
					tmpAll.forEach(
						(pRow) =>
						{
							let tmpID = idValue(pRow.ID);
							let tmpKeys = pKeys.get(tmpID) || pKeys.get(String(tmpID)) || [];
							if (tmpKeys.length < 1)
							{
								tmpCandidates.push(pRow.ID);
								return;
							}
							let tmpSource = toEpochMS(pRow.At);
							let tmpMirror = null;
							tmpKeys.forEach((pKey) => { let tmpAt = toEpochMS(pKey.UpdateDate); if ((tmpAt !== null) && ((tmpMirror === null) || (tmpAt > tmpMirror))) { tmpMirror = tmpAt; } });
							let tmpFraction = /\.(\d+)$/.exec(String(pRow.At || ''));
							let tmpFiner = !!tmpFraction && (tmpFraction[1].length > 3) && /[1-9]/.test(tmpFraction[1].slice(3));
							if ((tmpSource === null) || (tmpMirror === null) || (tmpSource > tmpMirror) || ((tmpSource === tmpMirror) && tmpFiner))
							{
								tmpCandidates.push(pRow.ID);
								return;
							}
							this._Stats.SweepSkipped++;
						});
					return fCallback(tmpCandidates);
				});
		}
		catch (pError)
		{
			if (!tmpCalled)
			{
				tmpCalled = true;
				return fCallback(tmpAll.map((pRow) => { return pRow.ID; }));
			}
		}
	}

	/**
	 * Wait (≤ 60 s) while the entity's PendingSet holds more than a few batches: a Sweep or a Bisect never
	 * enqueues faster than the loop applies, so it never overflows the set into a whole-entity Resync.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {() => void} fCallback
	 */
	_waitForRoom(pStore, pEntity, fCallback)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || (typeof(tmpMaterializer.pendingInfo) !== 'function'))
		{
			return fCallback();
		}
		let tmpOptions = this.options.Materializer || {};
		let tmpBatch = (Number(tmpOptions.BatchIDs) > 0) ? Number(tmpOptions.BatchIDs) : 2000;
		let tmpOverflow = (Number(tmpOptions.OverflowIDs) > 0) ? Number(tmpOptions.OverflowIDs) : 100000;
		let tmpRoom = Math.max(1, Math.min(tmpBatch * 5, Math.floor(tmpOverflow / 2)));
		let tmpUntil = Date.now() + 60000;
		let fCheck = () =>
		{
			let tmpInfo = null;
			try
			{
				tmpInfo = tmpMaterializer.pendingInfo(pStore, pEntity, { Light: true });
			}
			catch (pError)
			{
				tmpInfo = null;
			}
			if (!tmpInfo || ((Number(tmpInfo.Pending) || 0) <= tmpRoom) || this._Stopped || (Date.now() >= tmpUntil))
			{
				return fCallback();
			}
			let tmpLoop = this._loop(pStore, pEntity);
			if (tmpLoop && (typeof(tmpLoop.requestFlush) === 'function'))
			{
				tmpLoop.requestFlush();
			}
			let tmpTimer = setTimeout(fCheck, 25);
			if (typeof(tmpTimer.unref) === 'function')
			{
				tmpTimer.unref();
			}
		};
		fCheck();
	}

	// ---- Bisect -------------------------------------------------------------------------------

	/**
	 * IDs stamped at or after pFromMS (the divergence exclusion), through the source's Sweep reader;
	 * null when more than RECENT_MAX_PAGES pages are that recent (a busy entity: never escalate).
	 *
	 * @param {Record<string, any>} pSource
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @param {number} pFromMS
	 * @param {(pError: Error|null, pIDs?: Set<string>|null) => void} fCallback
	 */
	_recentIDs(pSource, pEntity, pColumn, pFromMS, fCallback)
	{
		let tmpCap = this._number('SweepCap', 5000, 1);
		let tmpIDs = new Set();
		let tmpPages = 0;
		let fPage = (pFrom) =>
		{
			if (tmpPages >= RECENT_MAX_PAGES)
			{
				return fCallback(null, null);
			}
			let tmpCalled = false;
			try
			{
				pSource.sweep(pEntity, { Column: pColumn, From: pFrom, Cap: tmpCap },
					(pError, pPage) =>
					{
						if (tmpCalled)
						{
							return;
						}
						tmpCalled = true;
						if (pError)
						{
							return fCallback(pError);
						}
						tmpPages++;
						let tmpRows = (pPage && Array.isArray(pPage.Rows)) ? pPage.Rows : [];
						tmpRows.forEach((pRow) => { if (pRow && (pRow.ID !== null) && (pRow.ID !== undefined)) { tmpIDs.add(idKey(pRow.ID)); } });
						if (!pPage || !pPage.Next || (tmpRows.length < tmpCap) || (JSON.stringify(pPage.Next) === JSON.stringify(pFrom)))
						{
							return fCallback(null, tmpIDs);
						}
						return fPage(pPage.Next);
					});
			}
			catch (pError)
			{
				if (!tmpCalled)
				{
					tmpCalled = true;
					return fCallback(pError);
				}
			}
		};
		fPage({ At: formatSecond(pFromMS), ID: null });
	}

	/**
	 * The stamp column the divergence exclusion can read: the spec's watermark, else a mirrored
	 * UpdateDate (unindexed: only read when a Bisect is about to escalate).
	 *
	 * @param {Record<string, any>} pSpec
	 * @return {string|null}
	 */
	_stampColumn(pSpec)
	{
		if (pSpec.Watermark)
		{
			return pSpec.Watermark;
		}
		let tmpNames = Array.isArray(pSpec.ColumnNames) ? pSpec.ColumnNames
			: (Array.isArray(pSpec.Columns) ? pSpec.Columns.map((pColumn) => { return pColumn && pColumn.Column; }) : []);
		return (tmpNames.indexOf('UpdateDate') >= 0) ? 'UpdateDate' : null;
	}

	/**
	 * One Bisect pass: source checksums (live rows) vs keymap checksums per ID bucket; every differing
	 * leaf → the IDs on exactly one side → enqueued.  Divergence (differing IDs / live source rows,
	 * excluding IDs already pending or in flight and rows stamped since BisectStart − OverlapMS) above
	 * Reconcile.RebuildDivergenceRatio escalates to a rebuild (Reason 'Divergence', ending Unverified;
	 * a verify follows unless this Bisect is a verify's own).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ Escalate?: boolean, FromVerify?: boolean, VerifyAfterRebuild?: boolean, LeafRange?: number }} pOptions
	 * @param {(pError?: Error|null, pResult?: { Buckets: number, DifferingLeaves: number, Enqueued: number, Divergence: number, Rebuilt: boolean, Busy?: boolean }) => void} fCallback
	 */
	bisect(pStore, pEntity, pOptions, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : ((typeof(pOptions) === 'function') ? pOptions : () => {});
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let tmpContext = this._context(pStore, pEntity);
		if (tmpContext.Error)
		{
			return fDone(tmpContext.Error);
		}
		let tmpRecord = this._record(pStore, pEntity);
		this._run(pStore, pEntity, 'Bisect', tmpOptions.FromVerify ? 'Bisect:Verify' : 'Bisect',
			(fRunDone) =>
			{
				this._Stats.Bisects++;
				let tmpBisectStart = Date.now();
				let tmpLeafRange = Math.max(1, Math.floor(Number(tmpOptions.LeafRange) || this._number('LeafRange', 2000, 1)));
				let tmpSourceSums = null;
				let tmpStoreSums = null;
				let tmpPendingReads = 2;
				let tmpFailed = false;
				let fBoth = (pError) =>
				{
					if (tmpFailed)
					{
						return;
					}
					if (pError)
					{
						tmpFailed = true;
						return fRunDone(pError);
					}
					tmpPendingReads--;
					if (tmpPendingReads > 0)
					{
						return;
					}
					return this._bisectLeaves(pStore, pEntity, tmpContext, tmpRecord, tmpOptions, tmpLeafRange, tmpBisectStart, diffChecksums(tmpSourceSums, tmpStoreSums), fRunDone);
				};
				try
				{
					tmpContext.Source.checksums(pEntity, tmpLeafRange, (pError, pBuckets) => { tmpSourceSums = pBuckets || {}; fBoth(pError); });
				}
				catch (pError)
				{
					fBoth(pError);
				}
				try
				{
					tmpContext.Store.bucketChecksums(pEntity, tmpLeafRange, 'Live', (pError, pBuckets) => { tmpStoreSums = pBuckets || {}; fBoth(pError); });
				}
				catch (pError)
				{
					fBoth(pError);
				}
			}, fDone);
	}

	/**
	 * The leaf phase of a Bisect (see bisect()).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pOptions
	 * @param {number} pLeafRange
	 * @param {number} pBisectStart
	 * @param {{ Buckets: number, Differing: Array<number>, SourceTotal: number }} pDiff
	 * @param {Function} fDone
	 */
	_bisectLeaves(pStore, pEntity, pContext, pRecord, pOptions, pLeafRange, pBisectStart, pDiff, fDone)
	{
		let tmpDifferent = [];
		let tmpIndex = 0;
		let fLeaf = () =>
		{
			if (tmpIndex >= pDiff.Differing.length)
			{
				return this._bisectDecide(pStore, pEntity, pContext, pRecord, pOptions, pBisectStart, pDiff, tmpDifferent, fDone);
			}
			let tmpBounds = leafBounds(pDiff.Differing[tmpIndex], pLeafRange);
			tmpIndex++;
			let tmpSourceIDs = null;
			let tmpKeys = null;
			let tmpPending = 2;
			let tmpFailed = false;
			let fBoth = (pError) =>
			{
				if (tmpFailed)
				{
					return;
				}
				if (pError)
				{
					tmpFailed = true;
					return fDone(pError);
				}
				tmpPending--;
				if (tmpPending > 0)
				{
					return;
				}
				let tmpLeafDifferent = leafDifference(tmpSourceIDs, tmpKeys);
				for (let i = 0; i < tmpLeafDifferent.length; i++)
				{
					tmpDifferent.push(tmpLeafDifferent[i]);
				}
				return setImmediate(fLeaf);
			};
			try
			{
				pContext.Source.readIDs(pEntity, tmpBounds.AfterID, tmpBounds.ToID, (pError, pIDs) => { tmpSourceIDs = pIDs || []; fBoth(pError); });
			}
			catch (pError)
			{
				fBoth(pError);
			}
			try
			{
				pContext.Store.readKeyRange(pEntity, tmpBounds.AfterID, tmpBounds.ToID, 'Live', (pError, pKeys) => { tmpKeys = pKeys || new Map(); fBoth(pError); });
			}
			catch (pError)
			{
				fBoth(pError);
			}
		};
		fLeaf();
	}

	/**
	 * Enqueue the differing IDs, compute the divergence, escalate when it is too high.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pOptions
	 * @param {number} pBisectStart
	 * @param {Record<string, any>} pDiff
	 * @param {Array<any>} pDifferent
	 * @param {Function} fDone
	 */
	_bisectDecide(pStore, pEntity, pContext, pRecord, pOptions, pBisectStart, pDiff, pDifferent, fDone)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		// The pending exclusion is read BEFORE these IDs are enqueued (afterwards every one of them is
		// pending): per ID when the Materializer can say, else as a count bound from pendingInfo.
		let tmpCandidates = pDifferent;
		let tmpPendingBound = 0;
		if (tmpMaterializer && (typeof(tmpMaterializer.isPending) === 'function'))
		{
			tmpCandidates = pDifferent.filter(
				(pID) =>
				{
					try
					{
						return !tmpMaterializer.isPending(pStore, pEntity, idValue(pID));
					}
					catch (pError)
					{
						return true;
					}
				});
		}
		else if (tmpMaterializer && (typeof(tmpMaterializer.pendingInfo) === 'function'))
		{
			try
			{
				let tmpInfo = tmpMaterializer.pendingInfo(pStore, pEntity) || {};
				tmpPendingBound = (Number(tmpInfo.Pending) || 0) + (Number(tmpInfo.InFlight) || 0);
			}
			catch (pError)
			{
				tmpPendingBound = 0;
			}
		}
		let tmpEnqueued = this._enqueue(pStore, pEntity, pDifferent, 'Bisect');
		let tmpTotal = pDiff.SourceTotal;
		let fRatio = (pCount) =>
		{
			if (pCount <= 0)
			{
				return 0;
			}
			return (tmpTotal > 0) ? (pCount / tmpTotal) : 1;
		};
		let tmpRatio = this._number('RebuildDivergenceRatio', 0.01, 0);
		let fFinish = (pDivergence, pBusy) =>
		{
			pRecord.LastBisect = formatUTC(Date.now());
			pRecord.Divergence = pDivergence;
			pRecord.Total = tmpTotal;
			this._persist(pStore, pEntity, { LastBisect: pRecord.LastBisect });
			let tmpResult = { Buckets: pDiff.Buckets, DifferingLeaves: pDiff.Differing.length, LeafSample: pDiff.Differing.slice(0, 20), Enqueued: tmpEnqueued, Divergence: pDivergence, Rebuilt: false };
			if (pBusy)
			{
				tmpResult.Busy = true;
			}
			if (pBusy || (pDivergence <= tmpRatio) || (pOptions.Escalate === false))
			{
				return fDone(null, tmpResult);
			}
			let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
			if (!tmpRebuilder || (typeof(tmpRebuilder.rebuild) !== 'function'))
			{
				return fDone(null, tmpResult);
			}
			this.log.warn(`RetoldFaceting: ${pStore}.${pEntity} diverges from its source (${pDifferent.length} of ${tmpTotal} rows); rebuilding.`);
			this._Stats.Rebuilds++;
			tmpRebuilder.rebuild(pStore, pEntity, { Reason: 'Divergence' },
				(pError) =>
				{
					if (pError)
					{
						return fDone(pError);
					}
					tmpResult.Rebuilt = true;
					if (!pOptions.FromVerify && (pOptions.VerifyAfterRebuild !== false) && !this._Stopped)
					{
						// The divergence rebuild ended Unverified: verify in the background.
						let tmpTimer = setTimeout(
							() =>
							{
								this._Timers = this._Timers.filter((pTimer) => { return pTimer !== tmpTimer; });
								this.verify(pStore, pEntity,
									(pVerifyError) =>
									{
										if (pVerifyError)
										{
											this.log.warn(`RetoldFaceting: verifying ${pStore}.${pEntity} after a divergence rebuild failed: ${pVerifyError.message}`);
										}
									});
							}, 0);
						if (typeof(tmpTimer.unref) === 'function')
						{
							tmpTimer.unref();
						}
						this._Timers.push(tmpTimer);
					}
					return fDone(null, tmpResult);
				});
		};

		let tmpRaw = fRatio(Math.max(0, tmpCandidates.length - tmpPendingBound));
		if (tmpRaw <= tmpRatio)
		{
			return fFinish(tmpRaw, false);
		}
		// Above the ratio: exclude rows stamped since BisectStart − OverlapMS (in-flight writes, not
		// lost ones) before deciding.
		let tmpColumn = this._stampColumn(pContext.Spec);
		if (!tmpColumn)
		{
			return fFinish(tmpRaw, false);
		}
		this._recentIDs(pContext.Source, pEntity, tmpColumn, pBisectStart - this.overlapMS(pEntity),
			(pError, pRecent) =>
			{
				if (pError)
				{
					return fDone(pError);
				}
				if (pRecent === null)
				{
					return fFinish(tmpRaw, true);
				}
				let tmpRemaining = tmpCandidates.filter((pID) => { return !pRecent.has(idKey(pID)); });
				return fFinish(fRatio(Math.max(0, tmpRemaining.length - tmpPendingBound)), false);
			});
	}

	// ---- Scrub --------------------------------------------------------------------------------

	/**
	 * A Scrub: one paced tick (a Range task from the rotating cursor, Cap = pOptions.Cap or the tick
	 * ceiling; a short read wraps the rotation and sets ScrubbedThrough to the pass's start), or with
	 * { Full: true } one complete pass from the start now (Kind 'Fill' for the additive-column fill).
	 * Unconditional: no compare, the WriterLoop's re-read is idempotent.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ Full?: boolean, Kind?: string, Cap?: number }} pOptions
	 * @param {(pError?: Error|null, pResult?: { Ranges: number, Rows: number, Wrapped: boolean, Skipped?: string }) => void} fCallback
	 */
	scrub(pStore, pEntity, pOptions, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : ((typeof(pOptions) === 'function') ? pOptions : () => {});
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let tmpContext = this._context(pStore, pEntity);
		if (tmpContext.Error)
		{
			return fDone(tmpContext.Error);
		}
		let tmpKind = (SCRUB_KINDS.indexOf(tmpOptions.Kind) >= 0) ? tmpOptions.Kind : 'Scrub';
		let tmpFull = (tmpOptions.Full === true);
		let tmpState = libRebuilder.entityState(this.fable, pStore, pEntity).State;
		if ((tmpState === 'Absent') || (tmpState === 'Building'))
		{
			// No live table to write: a Scrub of it is meaningless (the build reads everything).
			return fDone(null, { Ranges: 0, Rows: 0, Wrapped: false, Skipped: `State:${tmpState}` });
		}
		let tmpRecord = this._record(pStore, pEntity);
		let tmpJoinKey = tmpFull ? `Full:${tmpKind}${tmpOptions.FromVerify ? ':Verify' : ''}` : 'Tick';
		this._run(pStore, pEntity, 'Scrub', tmpJoinKey,
			(fRunDone) =>
			{
				this._load(tmpRecord, tmpContext.Store,
					() =>
					{
						this._Stats.Scrubs++;
						if (tmpFull)
						{
							return this._scrubFull(pStore, pEntity, tmpContext.Loop, tmpRecord, tmpKind, tmpOptions, fRunDone);
						}
						return this._scrubTickRun(pStore, pEntity, tmpContext.Loop, tmpRecord, tmpKind, tmpOptions, fRunDone);
					});
			}, fDone);
	}

	/**
	 * One Range task on the WriterLoop, called back once.
	 *
	 * @param {Record<string, any>} pLoop
	 * @param {Record<string, any>} pTask
	 * @param {(pError: Error|null, pResult?: { LastID: any, Rows: number, Exhausted: boolean }) => void} fCallback
	 */
	_rangeTask(pLoop, pTask, fCallback)
	{
		let tmpCalled = false;
		try
		{
			pLoop.addRangeTask(pTask,
				(pError, pResult) =>
				{
					if (tmpCalled)
					{
						return;
					}
					tmpCalled = true;
					if (pError)
					{
						return fCallback(pError);
					}
					let tmpResult = pResult || {};
					let tmpRows = Number(tmpResult.Rows) || 0;
					let tmpLastID = ((tmpResult.LastID === null) || (tmpResult.LastID === undefined)) ? null : tmpResult.LastID;
					// A read that returned nothing, or did not move past AfterID, ends the pass.
					let tmpExhausted = (tmpResult.Exhausted === true) || (tmpRows === 0) || (tmpLastID === null) || (idKey(tmpLastID) === idKey(pTask.AfterID));
					return fCallback(null, { LastID: tmpLastID, Rows: tmpRows, Exhausted: tmpExhausted });
				});
		}
		catch (pError)
		{
			if (!tmpCalled)
			{
				tmpCalled = true;
				return fCallback(pError);
			}
		}
	}

	/**
	 * A paced tick of the rotation.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pLoop
	 * @param {Record<string, any>} pRecord
	 * @param {string} pKind
	 * @param {Record<string, any>} pOptions
	 * @param {Function} fDone
	 */
	_scrubTickRun(pStore, pEntity, pLoop, pRecord, pKind, pOptions, fDone)
	{
		let tmpCap = Math.max(1, Math.floor(Number(pOptions.Cap) || this.scrubTickCap()));
		let tmpAfter = pRecord.ScrubCursor;
		if (tmpAfter === null)
		{
			// A new rotation starts now.
			pRecord.ScrubPassStart = Date.now();
			pRecord.PassRows = 0;
		}
		else if (pRecord.ScrubPassStart === null)
		{
			// A rotation resumed from a persisted cursor: its start (an earlier process) is unknown, so
			// its wrap cannot vouch for a ScrubbedThrough.
			pRecord.ScrubPassStart = -1;
			pRecord.PassRows = 0;
		}
		this._rangeTask(pLoop, { Kind: pKind, Target: 'Live', AfterID: tmpAfter, ToID: null, Cap: tmpCap },
			(pError, pResult) =>
			{
				if (pError)
				{
					return fDone(pError);
				}
				pRecord.PassRows += pResult.Rows;
				let tmpFields = {};
				if (pResult.Exhausted)
				{
					if (pRecord.ScrubPassStart > 0)
					{
						pRecord.ScrubbedThrough = formatUTC(pRecord.ScrubPassStart);
						pRecord.Total = pRecord.PassRows;
						tmpFields.ScrubbedThrough = pRecord.ScrubbedThrough;
						this._wrapped(pStore, pEntity, pRecord.ScrubPassStart);
					}
					pRecord.ScrubCursor = null;
					pRecord.ScrubPassStart = null;
					pRecord.PassRows = 0;
				}
				else
				{
					pRecord.ScrubCursor = idValue(pResult.LastID);
				}
				tmpFields.ScrubCursor = pRecord.ScrubCursor;
				this._persist(pStore, pEntity, tmpFields);
				return fDone(null, { Ranges: 1, Rows: pResult.Rows, Wrapped: pResult.Exhausted });
			});
	}

	/**
	 * One complete pass from the start, as fast as the loop allows (Range priority, below Stream).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pLoop
	 * @param {Record<string, any>} pRecord
	 * @param {string} pKind
	 * @param {Record<string, any>} pOptions
	 * @param {Function} fDone
	 */
	_scrubFull(pStore, pEntity, pLoop, pRecord, pKind, pOptions, fDone)
	{
		let tmpCap = Math.max(1, Math.floor(Number(pOptions.Cap) || this.scrubFullCap()));
		let tmpPassStart = Date.now();
		let tmpRanges = 0;
		let tmpRows = 0;
		let fNext = (pAfterID) =>
		{
			this._rangeTask(pLoop, { Kind: pKind, Target: 'Live', AfterID: pAfterID, ToID: null, Cap: tmpCap },
				(pError, pResult) =>
				{
					if (pError)
					{
						return fDone(pError);
					}
					tmpRanges++;
					tmpRows += pResult.Rows;
					if (!pResult.Exhausted)
					{
						return fNext(pResult.LastID);
					}
					// A full pass is a full rotation: the paced cursor restarts from the beginning.
					pRecord.ScrubbedThrough = formatUTC(tmpPassStart);
					this._wrapped(pStore, pEntity, tmpPassStart);
					pRecord.Total = tmpRows;
					pRecord.ScrubCursor = null;
					pRecord.ScrubPassStart = null;
					pRecord.PassRows = 0;
					pRecord.Owed = 0;
					this._persist(pStore, pEntity, { ScrubCursor: null, ScrubbedThrough: pRecord.ScrubbedThrough });
					return fDone(null, { Ranges: tmpRanges, Rows: tmpRows, Wrapped: true });
				});
		};
		fNext(null);
	}

	/**
	 * A full rotation re-read every live row: the Materializer clears the Lossy flags only known as sticky.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} pPassStartMS
	 */
	_wrapped(pStore, pEntity, pPassStartMS)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (tmpMaterializer && (typeof(tmpMaterializer.scrubWrapped) === 'function'))
		{
			try
			{
				tmpMaterializer.scrubWrapped(pStore, pEntity, pPassStartMS);
			}
			catch (pError)
			{
				// Never fatal for the Scrub.
			}
		}
	}

	// ---- Verify -------------------------------------------------------------------------------

	/**
	 * The way out of Unverified: a Bisect, then a full Scrub; when both completed and no newer
	 * Unverified trigger arrived meanwhile, the entity goes Live (UnverifiedSince cleared with the
	 * state).  A Bisect that escalated to a divergence rebuild is a newer trigger: the verify starts
	 * over (at most VERIFY_MAX_ATTEMPTS passes, then it stays Unverified).  An entity that is not
	 * Unverified is reconciled the same way and left in its state.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>|Function} [pOptions]
	 * @param {(pError?: Error|null, pResult?: { Verified: boolean, State: string, Attempts: number, Bisect: any, Scrub: any, Reason?: string }) => void} [fCallback]
	 */
	verify(pStore, pEntity, pOptions, fCallback)
	{
		let fDone = (typeof(pOptions) === 'function') ? pOptions : ((typeof(fCallback) === 'function') ? fCallback : () => {});
		let tmpContext = this._context(pStore, pEntity);
		if (tmpContext.Error)
		{
			return fDone(tmpContext.Error);
		}
		let tmpRecord = this._record(pStore, pEntity);
		this._run(pStore, pEntity, 'Verify', 'Verify',
			(fRunDone) =>
			{
				this._Stats.Verifies++;
				let tmpBaseline = libRebuilder.entityState(this.fable, pStore, pEntity);
				let tmpAttempts = 0;
				let tmpBisect = null;
				let fAttempt = () =>
				{
					tmpAttempts++;
					this.bisect(pStore, pEntity, { FromVerify: true },
						(pBisectError, pBisect) =>
						{
							if (pBisectError)
							{
								return fRunDone(pBisectError);
							}
							tmpBisect = pBisect;
							if (pBisect && pBisect.Rebuilt)
							{
								// The rebuild is a newer Unverified trigger: start over from it.
								tmpBaseline = libRebuilder.entityState(this.fable, pStore, pEntity);
								if (tmpAttempts < VERIFY_MAX_ATTEMPTS)
								{
									return fAttempt();
								}
								return fRunDone(null, { Verified: false, State: tmpBaseline.State, Attempts: tmpAttempts, Bisect: tmpBisect, Scrub: null, Reason: 'Divergence' });
							}
							this.scrub(pStore, pEntity, { Full: true, FromVerify: true },
								(pScrubError, pScrub) =>
								{
									if (pScrubError)
									{
										return fRunDone(pScrubError);
									}
									let tmpNow = libRebuilder.entityState(this.fable, pStore, pEntity);
									if (tmpNow.State !== 'Unverified')
									{
										// Nothing to lift (a verify of a Live entity), or someone else moved it.
										tmpRecord.LastVerify = new Date().toISOString();
										return fRunDone(null, { Verified: (tmpNow.State === 'Live') || (tmpNow.State === 'Lagging'), State: tmpNow.State, Attempts: tmpAttempts, Bisect: tmpBisect, Scrub: pScrub });
									}
									let tmpSameTrigger = (tmpBaseline.State !== 'Unverified') ? false : (String(tmpNow.Since) === String(tmpBaseline.Since));
									if (!tmpSameTrigger)
									{
										// A newer Unverified trigger arrived during this pass: it needs a pass of its own.
										tmpBaseline = tmpNow;
										if (tmpAttempts < VERIFY_MAX_ATTEMPTS)
										{
											return fAttempt();
										}
										return fRunDone(null, { Verified: false, State: tmpNow.State, Attempts: tmpAttempts, Bisect: tmpBisect, Scrub: pScrub, Reason: 'NewerTrigger' });
									}
									libRebuilder.setEntityState(this.fable, pStore, pEntity, 'Live', 'Verified');
									tmpRecord.LastVerify = new Date().toISOString();
									this.log.info(`RetoldFaceting: ${pStore}.${pEntity} verified (Bisect + full Scrub); Live.`);
									return fRunDone(null, { Verified: true, State: 'Live', Attempts: tmpAttempts, Bisect: tmpBisect, Scrub: pScrub });
								});
						});
				};
				fAttempt();
			}, fDone);
	}

	// ---- status -------------------------------------------------------------------------------

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {{ LastSweep: string|null, Watermark: string|null, LastBisect: string|null, Divergence: number|null, ScrubCursor: any, ScrubbedThrough: string|null, Running: Array<string> }}
	 */
	status(pStore, pEntity)
	{
		let tmpRecord = this._Entities.get(`${pStore}:${pEntity}`) || {};
		return (
			{
				LastSweep: tmpRecord.LastSweep || null,
				Watermark: tmpRecord.Watermark || null,
				LastBisect: tmpRecord.LastBisect || null,
				Divergence: (typeof(tmpRecord.Divergence) === 'number') ? tmpRecord.Divergence : null,
				ScrubCursor: (tmpRecord.ScrubCursor === undefined) ? null : tmpRecord.ScrubCursor,
				ScrubbedThrough: tmpRecord.ScrubbedThrough || null,
				LastVerify: tmpRecord.LastVerify || null,
				Running: LEVELS.filter((pLevel) => { return this.isRunning(pStore, pEntity, pLevel); })
			});
	}

	/**
	 * The state-row fields the Reconciler owns (the pull seam of Rebuilder.persistStateFields):
	 * SweepWatermark, ScrubCursor, ScrubbedThrough, LastBisect — only those known in this process.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	stateFields(pStore, pEntity)
	{
		let tmpRecord = this._Entities.get(`${pStore}:${pEntity}`);
		if (!tmpRecord)
		{
			return {};
		}
		let tmpFields = {};
		if (tmpRecord.Watermark)
		{
			tmpFields.SweepWatermark = tmpRecord.Watermark;
		}
		if (tmpRecord.Loaded || (tmpRecord.ScrubCursor !== null))
		{
			tmpFields.ScrubCursor = tmpRecord.ScrubCursor;
		}
		if (tmpRecord.ScrubbedThrough)
		{
			tmpFields.ScrubbedThrough = tmpRecord.ScrubbedThrough;
		}
		if (tmpRecord.LastBisect)
		{
			tmpFields.LastBisect = tmpRecord.LastBisect;
		}
		return tmpFields;
	}

	/**
	 * @return {Record<string, any>}
	 */
	stats()
	{
		return Object.assign({ Timers: this._Timers.length, Entities: this._Entities.size }, this._Stats);
	}
}

module.exports = RetoldFacetingReconciler;
module.exports.serviceType = 'RetoldFacetingReconciler';
module.exports.LEVELS = LEVELS;
module.exports.SKIP_STATES = SKIP_STATES;
module.exports.SCRUB_KINDS = SCRUB_KINDS;
module.exports.VERIFY_MAX_ATTEMPTS = VERIFY_MAX_ATTEMPTS;
module.exports.SCRUB_MIN_BATCH = SCRUB_MIN_BATCH;
// Pure helpers (exported for the unit tests).
module.exports.toEpochMS = toEpochMS;
module.exports.formatSecond = formatSecond;
module.exports.idKey = idKey;
module.exports.sameNumber = sameNumber;
module.exports.leafBounds = leafBounds;
module.exports.diffChecksums = diffChecksums;
module.exports.leafDifference = leafDifference;
