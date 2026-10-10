/**
 * Retold Faceting - Materializer
 *
 * Orchestrates the stores (design 04 §6, §13.1; internal-contracts §58): at start() it connects each
 * configured store (feature-not-boot), compiles the MirrorSpecs, ensures the schema, seeds the
 * WriterClock from the store, and per mirrored entity builds a PendingSet, a FlushBuffer and ONE
 * serialized WriterLoop, then decides the entity's boot state from _rfs_entity_state (absent →
 * backfill; additive / non-additive spec change; clean shutdown → CatchingUp; unclean → Unverified +
 * verify).  It is the ChangeIntake subscriber 'Materializer': every change event becomes pending IDs
 * (or a Dirty mark, or a filter resolution) for every store that mirrors the entity, synchronously.
 *
 *   start(fCallback) / stop(fCallback) / crash() (tests) / reload()
 *   onChange(pEvent) / enqueue(pStore, pEntity, pIDs, pOptions) / resolveFilter(…) / isPending(…)
 *   loop(pStore, pEntity) / flushNow(…) / quiesce(…) / recoverWipe(pStore)
 *   pendingInfo(pStore, pEntity) / entityInfo(pStore, pEntity) / setState(…) / updateState(…) / status()
 *   store(pStore) / useStore(pStore, pService) (tests: an in-memory store)
 *
 * The state row (_rfs_entity_state) has ONE writer: this service.  The Rebuilder and the Reconciler hand
 * it their fields (updateState, or their stateFields() pulled into every write); every write is the
 * full latest state object with a WriterClock version, and it is written only after the inserts it
 * describes were acknowledged.  Detail carries counters and a snapshot of the spec the live tables
 * follow (names and types only, never values), so a non-additive spec change found at boot can still
 * dual-write the old live tables during its shadow rebuild.
 *
 * Exactly one process materializes a store (D-28), enforced by a lease row in the store
 * (_rfs_lease: Owner, ExpiresAt): taken at start (claim, settle, read back), renewed every
 * Lease.HeartbeatMS, checked before every flush and state write, released by a graceful stop.  A
 * process that does not hold an unexpired lease never writes and leaves the store unused (Reason
 * 'NotLeader'), retrying; a holder that loses it (paused past its TTL, another owner took over) halts
 * its loops and boots again from the store once it holds it again (Unverified until verified).
 *
 * Builds (backfills, SpecChange rebuilds, boot verifies) run at most Materializer.MaxConcurrentBuilds at
 * a time per store; a failed backfill is retried with back-off.  State rows are written at once on
 * lifecycle changes (State, CleanShutdown, SpecHash, Lossy / Filling columns, Epoch) and otherwise
 * coalesced into one multi-row INSERT per store every StateWriteIntervalMS.  Nothing runs until start().
 *
 * Contract: internal-contracts §58, §59.3, §61.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');
const libPerfHooks = require('perf_hooks');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libStoreBase = require('../store/Retold-Faceting-StoreBase.js');
const libDDL = require('../store/clickhouse/ClickHouse-DDL.js');
const libRetoldFacetingPendingSet = require('./Retold-Faceting-PendingSet.js');
const libRetoldFacetingFlushBuffer = require('./Retold-Faceting-FlushBuffer.js');
const libRetoldFacetingWriterLoop = require('./Retold-Faceting-WriterLoop.js');
const libRetoldFacetingWriterClock = require('./Retold-Faceting-WriterClock.js');
const libMaterializeSource = require('./MaterializeSource-InProcess.js');

// Where a pending hint came from (internal-contracts §58.2, §60).
const HINT_SOURCES = Object.freeze([ 'Change', 'Filter', 'Sweep', 'Bisect', 'Scrub', 'Admin' ]);

// The stores M5 knows (Solr / OpenSearch are seams).
const STORE_NAMES = Object.freeze([ 'ClickHouse' ]);

// A notify settle re-delivery (internal-contracts §58.2: a harmless re-hint).
const SETTLE_SUFFIX = '~settle';

// States a quiesce() waits through (the store is being built or caught up).
const UNSETTLED_STATES = Object.freeze([ 'Absent', 'Building', 'Rebuilding', 'CatchingUp' ]);

// A request-path read that hit a missing table asks for a confirmation at most this often per store.
const WIPE_CHECK_MS = 60000;

// The reconcile / rebuild fields of the state row (merged from updateState / stateFields()).
const STATE_FIELDS = Object.freeze([ 'SweepWatermark', 'ScrubCursor', 'ScrubbedThrough', 'LastRebuild', 'LastBisect' ]);

// The spec members a snapshot keeps (names and types; never values).
const SNAPSHOT_KEYS = Object.freeze([ 'Entity', 'Store', 'SpecVersion', 'Identity', 'Kind', 'TenantColumn', 'OwnerColumn', 'RequiredColumns', 'DeleteColumn', 'SortKey', 'Columns', 'ColumnNames', 'KeymapColumns', 'TrackedKeyColumns', 'SourceColumns', 'Watermark', 'UnsetValues', 'SpecHash' ]);

const isPlainObject = libRetoldFacetingUtil.isPlainObject;
const toID = libMaterializeSource.toID;

/**
 * 'YYYY-MM-DD HH:mm:ss.SSS' (UTC) of an epoch-ms instant (the DateTime64(3, 'UTC') text).
 *
 * @param {number|null} pEpochMS
 * @return {string|null}
 */
const formatUTC = (pEpochMS) =>
{
	if ((typeof(pEpochMS) !== 'number') || !Number.isFinite(pEpochMS))
	{
		return null;
	}
	return new Date(pEpochMS).toISOString().replace('T', ' ').replace('Z', '');
};

/**
 * Parse a JSON-ish state field (the store may hand back the text or the object).
 *
 * @param {any} pValue
 * @param {any} pDefault
 * @return {any}
 */
const parseField = (pValue, pDefault) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined') || (pValue === ''))
	{
		return pDefault;
	}
	if (typeof(pValue) === 'string')
	{
		try
		{
			return JSON.parse(pValue);
		}
		catch (pError)
		{
			return pDefault;
		}
	}
	return pValue;
};

/**
 * Run tasks one after the other, never failing the sequence.
 *
 * @param {Array<(fNext: () => void) => void>} pTasks
 * @param {() => void} fCallback
 */
const series = (pTasks, fCallback) =>
{
	let tmpIndex = 0;
	let fNext = () =>
	{
		if (tmpIndex >= pTasks.length)
		{
			return fCallback();
		}
		let tmpTask = pTasks[tmpIndex++];
		let tmpCalled = false;
		try
		{
			tmpTask(() => { if (!tmpCalled) { tmpCalled = true; setImmediate(fNext); } });
		}
		catch (pError)
		{
			if (!tmpCalled)
			{
				tmpCalled = true;
				setImmediate(fNext);
			}
		}
	};
	fNext();
};

class RetoldFacetingMaterializer extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingMaterializer';

		this._Started = false;
		this._Stopping = false;
		// { Store: { Name, Available, Reason, Connecting, Recovering, Clock, Timer, Entities: { Entity: record } } }
		this._Stores = {};
		// Test-injected store services (useStore).
		this._InjectedStores = {};
		this._Timers = new Set();

		// The local monotonic clock (shared with the PendingSets; tests replace it).
		this.monotonicNow = () => { return libPerfHooks.performance.now(); };
		// The filter compiler of filter-scoped hints (C's ClickHouse-FoldCompiler.compileFilter; tests replace it).
		this.compileFilter = null;
		// This materializer's identity in the store lease (a restart of the same instance — crash() then
		// start() — is the same owner; another process is another one).
		this.OwnerID = `mz:${libCrypto.randomBytes(8).toString('hex')}`;
	}

	// ---- collaborators ------------------------------------------------------------------------

	/**
	 * The store service of a store name.
	 *
	 * @param {string} pStore
	 * @return {any|null}
	 */
	store(pStore)
	{
		if (this._InjectedStores[pStore])
		{
			return this._InjectedStores[pStore];
		}
		let tmpService = this.fable[`RetoldFacetingStore${pStore}`];
		return ((typeof(tmpService) === 'object') && (tmpService !== null)) ? tmpService : null;
	}

	/**
	 * Tests: use this store service (an in-memory fake) for a store name.
	 *
	 * @param {string} pStore
	 * @param {any} pService
	 */
	useStore(pStore, pService)
	{
		if (pService)
		{
			this._InjectedStores[pStore] = pService;
		}
		else
		{
			delete this._InjectedStores[pStore];
		}
	}

	/**
	 * @return {any} the Freshness service
	 */
	_freshness()
	{
		return this.fable.RetoldFacetingFreshness || null;
	}

	/**
	 * @return {any} the MirrorSpec service
	 */
	_mirrorSpec()
	{
		return this.fable.RetoldFacetingMirrorSpec || null;
	}

	/**
	 * @return {any} the trusted source
	 */
	_source()
	{
		return this.fable.RetoldFacetingMaterializeSourceInProcess || null;
	}

	/**
	 * Is materialization on?  false → never; 'Auto' / true → when a store section is an object.
	 *
	 * @return {boolean}
	 */
	enabled()
	{
		let tmpMaterializer = this.options.Materializer || {};
		if (tmpMaterializer.Enabled === false)
		{
			return false;
		}
		return this._storeNames().length > 0;
	}

	/**
	 * The configured stores (an object section, or an injected service).
	 *
	 * @return {Array<string>}
	 */
	_storeNames()
	{
		let tmpStores = isPlainObject(this.options.Stores) ? this.options.Stores : {};
		return STORE_NAMES.filter((pStore) => { return isPlainObject(tmpStores[pStore]) || !!this._InjectedStores[pStore]; });
	}

	/**
	 * The entities the declaration names for a store (before compilation; for early hint capture).
	 *
	 * @param {string} pStore
	 * @return {Array<string>}
	 */
	_declaredEntities(pStore)
	{
		let tmpMaterialize = isPlainObject(this.options.Materialize) ? this.options.Materialize : {};
		return Object.keys(tmpMaterialize).filter(
			(pEntity) =>
			{
				let tmpEntry = tmpMaterialize[pEntity];
				return isPlainObject(tmpEntry) && Array.isArray(tmpEntry.Store) && (tmpEntry.Store.indexOf(pStore) >= 0);
			}).sort();
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	_record(pStore, pEntity)
	{
		let tmpStore = this._Stores[pStore];
		return (tmpStore && Object.prototype.hasOwnProperty.call(tmpStore.Entities, pEntity)) ? tmpStore.Entities[pEntity] : null;
	}

	/**
	 * The per (store, entity) structures (created once; the loop is attached when the store is up).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	_ensureRecord(pStore, pEntity)
	{
		let tmpStore = this._Stores[pStore];
		let tmpRecord = this._record(pStore, pEntity);
		if (tmpRecord)
		{
			return tmpRecord;
		}
		let tmpHash = `${pStore}:${pEntity}`;
		let tmpPendingSet = new libRetoldFacetingPendingSet(this.fable, this.options, tmpHash);
		let tmpLoop = new libRetoldFacetingWriterLoop(this.fable, this.options, tmpHash);
		tmpLoop.monotonicNow = () => { return this.monotonicNow(); };
		tmpRecord = (
			{
				Store: pStore,
				Entity: pEntity,
				PendingSet: tmpPendingSet,
				FlushBuffer: new libRetoldFacetingFlushBuffer(this.fable, this.options, tmpHash),
				WriterLoop: tmpLoop,
				Spec: null,
				LiveSpec: null,
				Attached: false,
				Epoch: 0,
				CleanShutdown: 0,
				FillingColumns: [],
				PersistSpecHash: null,
				Persisted: {},
				Resolving: 0,
				ResolvingSince: null,
				LostHints: false,
				CatchUpHold: 0,
				Filling: false,
				LastStateText: null,
				LastLifecycleText: null,
				DowntimeMS: null,
				StateWrites: 0
			});
		tmpStore.Entities[pEntity] = tmpRecord;
		let tmpFreshness = this._freshness();
		if (tmpFreshness)
		{
			tmpFreshness.register(pStore, pEntity, { State: 'Absent', Reason: 'NotStarted' });
		}
		return tmpRecord;
	}

	// ---- lifecycle ----------------------------------------------------------------------------

	/**
	 * Start materializing (§58.1).  Never calls back an error that should fail attach: an unavailable
	 * store is retried every RetryConnectMS (unref'd) while Live answers.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	start(fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		if (!this.enabled())
		{
			return fDone();
		}
		if (this._Started)
		{
			return fDone();
		}
		this._Started = true;
		this._Stopping = false;
		let tmpFreshness = this._freshness();
		if (tmpFreshness)
		{
			tmpFreshness.monotonicNow = () => { return this.monotonicNow(); };
		}
		let tmpStores = this._storeNames();
		tmpStores.forEach(
			(pStore) =>
			{
				this._Stores[pStore] =
					{
						Name: pStore, Available: false, Reason: 'Connecting', Connecting: false, Recovering: false,
						Clock: new libRetoldFacetingWriterClock(this.fable, this.options, pStore), Timer: null, Entities: {},
						// The lease (null: not held), the build queue, the coalesced state writes, the health timer.
						Lease: null, LeaseTimer: null, Builds: { Running: 0, Queue: [] },
						StateDirty: new Set(), StateTimer: null, StateFlushing: false, HealthTimer: null, Stretch: 1,
						WipeCheckAt: 0
					};
				// Hints are captured from the first moment: a change that arrives while the store is still
				// connecting must not be lost (the entity could otherwise be judged Exact without it).
				this._declaredEntities(pStore).forEach((pEntity) => { this._ensureRecord(pStore, pEntity); });
			});
		series(tmpStores.map((pStore) => { return (fNext) => { return this._connectStore(pStore, fNext); }; }), () => { return fDone(); });
	}

	/**
	 * Retry connecting a store later (unref'd).
	 *
	 * @param {string} pStore
	 * @param {number} [pDelayMS] - instead of RetryConnectMS
	 */
	_retryLater(pStore, pDelayMS)
	{
		let tmpStore = this._Stores[pStore];
		if (!tmpStore || !this._Started || this._Stopping || tmpStore.Timer)
		{
			return;
		}
		let tmpSection = (isPlainObject(this.options.Stores) && isPlainObject(this.options.Stores[pStore])) ? this.options.Stores[pStore] : {};
		let tmpDelay = ((typeof(tmpSection.RetryConnectMS) === 'number') && (tmpSection.RetryConnectMS > 0)) ? tmpSection.RetryConnectMS : 60000;
		if ((tmpStore.Reason === 'NotLeader') || (tmpStore.Reason === 'LeaseLost'))
		{
			// The lease holder may stop at any moment (a rolling deploy): ask again every heartbeat.
			tmpDelay = Math.min(tmpDelay, this._leaseOptions().HeartbeatMS);
		}
		if (typeof(pDelayMS) === 'number')
		{
			tmpDelay = Math.max(1, pDelayMS);
		}
		tmpStore.Timer = setTimeout(
			() =>
			{
				this._Timers.delete(tmpStore.Timer);
				tmpStore.Timer = null;
				if (this._Started && !this._Stopping && (this._Stores[pStore] === tmpStore))
				{
					this._connectStore(pStore, () => {});
				}
			}, tmpDelay);
		if (typeof(tmpStore.Timer.unref) === 'function')
		{
			tmpStore.Timer.unref();
		}
		this._Timers.add(tmpStore.Timer);
	}

	/**
	 * Mark a store unavailable (and retry, unless it is misconfigured).
	 *
	 * @param {string} pStore
	 * @param {string} pReason
	 * @param {boolean} pRetry
	 */
	_unavailable(pStore, pReason, pRetry)
	{
		let tmpStore = this._Stores[pStore];
		if (!tmpStore)
		{
			return;
		}
		tmpStore.Available = false;
		tmpStore.Reason = pReason;
		Object.keys(tmpStore.Entities).forEach(
			(pEntity) =>
			{
				let tmpFreshness = this._freshness();
				if (tmpFreshness && (tmpFreshness.state(pStore, pEntity).State !== 'Absent'))
				{
					tmpFreshness.setState(pStore, pEntity, 'Absent', pReason);
				}
			});
		if (pRetry)
		{
			this._retryLater(pStore);
		}
	}

	/**
	 * Connect a store, compile, ensure the schema, seed the clock, boot every entity.
	 *
	 * @param {string} pStore
	 * @param {() => void} fCallback
	 */
	_connectStore(pStore, fCallback)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || tmpStoreRecord.Connecting || tmpStoreRecord.Available || this._Stopping)
		{
			return fCallback();
		}
		let tmpStore = this.store(pStore);
		if (!tmpStore)
		{
			this.fable.log.error(`RetoldFaceting Materializer: no ${pStore} store service is registered.`);
			this._unavailable(pStore, 'NoStore', false);
			return fCallback();
		}
		let tmpStatus = (typeof(tmpStore.status) === 'function') ? tmpStore.status() : { Configured: true };
		if (!tmpStatus.Configured || (tmpStatus.Reason === 'Misconfigured'))
		{
			this.fable.log.warn(`RetoldFaceting Materializer: the ${pStore} store is not configured (${tmpStatus.Reason || 'NotConfigured'}); answering Live.`);
			this._unavailable(pStore, tmpStatus.Reason || 'NotConfigured', false);
			return fCallback();
		}
		tmpStoreRecord.Connecting = true;
		let fEnd = (pReason, pRetry) =>
		{
			tmpStoreRecord.Connecting = false;
			if (pReason)
			{
				this._unavailable(pStore, pReason, pRetry);
			}
			return fCallback();
		};
		tmpStore.connect(
			(pConnectError, pResult) =>
			{
				if ((this._Stores[pStore] !== tmpStoreRecord) || this._Stopping)
				{
					return fEnd(null, false);
				}
				if (pConnectError || !pResult || !pResult.Up)
				{
					this.fable.log.warn(`RetoldFaceting Materializer: the ${pStore} store is unavailable${pConnectError ? ` (${pConnectError.message})` : ''}; answering Live, retrying.`);
					return fEnd('StoreUnavailable', true);
				}
				let tmpCompiled;
				try
				{
					tmpCompiled = this._compile();
				}
				catch (pCompileError)
				{
					this.fable.log.error(`RetoldFaceting Materializer: the Materialize declaration could not be compiled (${pCompileError.message}).`);
					return fEnd('SpecError', true);
				}
				let tmpSpecs = (tmpCompiled && isPlainObject(tmpCompiled.Specs) && isPlainObject(tmpCompiled.Specs[pStore])) ? tmpCompiled.Specs[pStore] : {};
				this._dropUndeclared(pStore, tmpSpecs);
				// The owner marker binds the store to this deployment's source database.
				let tmpSource = this._source();
				if (tmpSource && (typeof(tmpSource.fingerprint) === 'function') && (tmpStore.SourceFingerprint === null || typeof(tmpStore.SourceFingerprint) === 'undefined'))
				{
					try
					{
						tmpStore.SourceFingerprint = tmpSource.fingerprint(Object.keys(tmpSpecs).sort());
					}
					catch (pFingerprintError)
					{
						tmpStore.SourceFingerprint = null;
					}
				}
				tmpStore.ensureSchema(tmpSpecs,
					(pSchemaError, pReport) =>
					{
						if ((this._Stores[pStore] !== tmpStoreRecord) || this._Stopping)
						{
							return fEnd(null, false);
						}
						if (pSchemaError)
						{
							if (pSchemaError.OwnerMismatch)
							{
								// Another deployment's database: never retried, never written.
								return fEnd('Misconfigured', false);
							}
							this.fable.log.error(`RetoldFaceting Materializer: the ${pStore} schema could not be ensured (${pSchemaError.message}); retrying.`);
							return fEnd('SchemaError', true);
						}
						tmpStore.maxVersion(
							(pVersionError, pMaxVersion) =>
							{
								if ((this._Stores[pStore] !== tmpStoreRecord) || this._Stopping)
								{
									return fEnd(null, false);
								}
								if (pVersionError)
								{
									this.fable.log.error(`RetoldFaceting Materializer: the ${pStore} version floor could not be read (${pVersionError.message}); retrying.`);
									return fEnd('SchemaError', true);
								}
								tmpStoreRecord.Clock.seed(Number(pMaxVersion) || 0);
								this._acquireLease(pStore,
									(pLeader, pLeaseReason) =>
									{
										if ((this._Stores[pStore] !== tmpStoreRecord) || this._Stopping)
										{
											return fEnd(null, false);
										}
										if (!pLeader)
										{
											// Another live process materializes this store: stay off it (Live answers).
											return fEnd(pLeaseReason || 'NotLeader', true);
										}
										tmpStoreRecord.Available = true;
										tmpStoreRecord.Reason = null;
										this._startStoreTimers(pStore);
										let tmpEntities = (pReport && isPlainObject(pReport.Entities)) ? pReport.Entities : {};
										series(Object.keys(tmpSpecs).sort().map(
											(pEntity) =>
											{
												return (fNext) => { return this._bootEntity(pStore, pEntity, tmpSpecs[pEntity], tmpEntities[pEntity] || null, fNext); };
											}),
											() =>
											{
												this._startReconciler(pStore);
												return fEnd(null, false);
											});
									});
							});
					});
			});
	}

	/**
	 * Compile the declaration (MirrorSpec.compile over the catalog and the host).
	 *
	 * @return {{ Specs: Record<string, Record<string, any>>, Disabled: Array<any>, Warnings: Array<any> }}
	 */
	_compile()
	{
		let tmpMirrorSpec = this._mirrorSpec();
		if (!tmpMirrorSpec || (typeof(tmpMirrorSpec.compile) !== 'function'))
		{
			throw new Error('no MirrorSpec service');
		}
		let tmpService = this.fable.RetoldFacetingService;
		return tmpMirrorSpec.compile(this.options.Materialize,
			{
				Catalog: this.fable.RetoldFacetingCatalog || null,
				Host: (tmpService && tmpService.Host) ? tmpService.Host : null,
				Registry: this.fable.RetoldFacetingDefinitionRegistry || null,
				Options: this.options
			});
	}

	/**
	 * Entities whose declaration is gone or disabled stop (their tables stay, §55.4).
	 *
	 * @param {string} pStore
	 * @param {Record<string, any>} pSpecs
	 */
	_dropUndeclared(pStore, pSpecs)
	{
		let tmpStoreRecord = this._Stores[pStore];
		Object.keys(tmpStoreRecord.Entities).forEach(
			(pEntity) =>
			{
				if (Object.prototype.hasOwnProperty.call(pSpecs, pEntity))
				{
					return;
				}
				let tmpRecord = tmpStoreRecord.Entities[pEntity];
				tmpRecord.WriterLoop.halt('Undeclared');
				delete tmpStoreRecord.Entities[pEntity];
				let tmpFreshness = this._freshness();
				if (tmpFreshness && (typeof(tmpFreshness.unregister) === 'function'))
				{
					tmpFreshness.unregister(pStore, pEntity);
				}
			});
	}

	/**
	 * Attach an entity's loop and decide its boot state (§58.1).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>|null} pReport - ensureSchema's report of the entity
	 * @param {() => void} fCallback
	 */
	_bootEntity(pStore, pEntity, pSpec, pReport, fCallback)
	{
		let tmpRecord = this._ensureRecord(pStore, pEntity);
		let tmpStore = this.store(pStore);
		let tmpStoreRecord = this._Stores[pStore];
		tmpStore.readState(pEntity,
			(pStateError, pState) =>
			{
				if (this._Stopping || !this._Started || (this._Stores[pStore] !== tmpStoreRecord))
				{
					return fCallback();
				}
				if (pStateError)
				{
					// Never drop or rebuild live tables on a read error: a missing table is a wipe (confirmed
					// and recovered); anything else (a time-out, a 5xx) makes the store unavailable and the
					// whole boot is retried (Live answers meanwhile).
					let tmpCodes = (tmpStore.constructor && Array.isArray(tmpStore.constructor.WIPE_ERROR_CODES)) ? tmpStore.constructor.WIPE_ERROR_CODES : [ 60, 81 ];
					if ((pStateError.Code !== undefined) && (tmpCodes.indexOf(Number(pStateError.Code)) >= 0))
					{
						this.fable.log.warn(`RetoldFaceting Materializer: the state table of ${pStore} is gone (${pStateError.message}); recovering the store.`);
						setImmediate(() => { this.recoverWipe(pStore); });
						return fCallback();
					}
					this.fable.log.warn(`RetoldFaceting Materializer: the state of ${pStore}.${pEntity} could not be read (${pStateError.message}); the store is retried later (answering Live).`);
					this._unavailable(pStore, 'StateUnreadable', true);
					return fCallback();
				}
				let tmpState = pState || null;
				// Leftover shadows of interrupted builds (a stop, a crash): nothing is building yet at boot.
				let tmpShadows = (pReport && Array.isArray(pReport.Shadows)) ? pReport.Shadows : [];
				if ((tmpShadows.length > 0) && (typeof(tmpStore.dropShadow) === 'function'))
				{
					tmpShadows.forEach(
						(pBuildID) =>
						{
							this.fable.log.info(`RetoldFaceting Materializer: dropping the leftover shadow ${pBuildID} of ${pStore}.${pEntity} (an interrupted build).`);
							tmpStore.dropShadow(pEntity, pBuildID, (pDropError) => { if (pDropError) { this.fable.log.warn(`RetoldFaceting Materializer: the leftover shadow ${pBuildID} of ${pStore}.${pEntity} could not be dropped (${pDropError.message}).`); } });
						});
				}
				// How long the store went unwritten (the state row's last write): a long downtime is Bisected.
				tmpRecord.DowntimeMS = (tmpState && Number.isFinite(tmpState.UpdatedAt)) ? Math.max(0, Date.now() - tmpState.UpdatedAt) : null;
				let tmpClass = this._classify(pReport, pSpec);
				let tmpLive = (tmpClass.Kind !== 'Absent');
				let tmpAnyTable = !!(pReport && (pReport.MirrorExists || pReport.KeymapExists));
				let tmpDetail = tmpState ? parseField(tmpState.Detail, {}) : {};
				let tmpSnapshot = (isPlainObject(tmpDetail) && isPlainObject(tmpDetail.Spec) && Array.isArray(tmpDetail.Spec.Columns)) ? tmpDetail.Spec : null;
				// The decision first (the loop must not write a table that is about to be dropped or altered).
				let tmpDecision;
				if (!tmpState || !tmpLive)
				{
					tmpDecision = 'Backfill';
				}
				else if (tmpClass.Kind === 'Rebuild')
				{
					tmpDecision = (tmpSnapshot && (tmpSnapshot.SpecHash === (pReport && pReport.SpecHash))) ? 'RebuildBeside' : 'RebuildFresh';
				}
				else if (tmpClass.Kind === 'Additive')
				{
					tmpDecision = 'Additive';
				}
				else
				{
					tmpDecision = 'Resume';
				}

				tmpRecord.Spec = pSpec;
				tmpRecord.Epoch = (tmpState && Number.isFinite(Number(tmpState.Epoch))) ? Number(tmpState.Epoch) : 0;
				tmpRecord.CleanShutdown = 0;
				tmpRecord.PersistSpecHash = pSpec.SpecHash;
				tmpRecord.FillingColumns = [];
				STATE_FIELDS.forEach((pField) => { if (tmpState && (tmpState[pField] !== undefined) && (tmpState[pField] !== null)) { tmpRecord.Persisted[pField] = tmpState[pField]; } });
				tmpRecord.LostHints = false;
				let tmpFreshness = this._freshness();
				if (tmpFreshness)
				{
					tmpFreshness.register(pStore, pEntity, { Epoch: tmpRecord.Epoch });
				}
				let tmpWritesLive = ((tmpDecision === 'Resume') || (tmpDecision === 'RebuildBeside'));
				this._attachLoop(tmpRecord, tmpWritesLive ? [ libStoreBase.TARGET_LIVE ] : [], (tmpDecision === 'RebuildBeside') ? tmpSnapshot : null);
				if (tmpState && tmpLive && (tmpDecision !== 'RebuildFresh'))
				{
					tmpRecord.WriterLoop.seedLossy(parseField(tmpState.LossyColumns, {}));
				}

				if (tmpDecision === 'Backfill')
				{
					// No state or no live table: a full build (§59.1); partial leftovers are dropped first.
					return this._backfill(pStore, pEntity, 'Initial', fCallback, tmpAnyTable ? 'DropLive' : null);
				}
				if (tmpDecision === 'RebuildBeside')
				{
					// The live tables follow the snapshot: dual-write them through the shadow rebuild.
					tmpRecord.WriterLoop.setSpec(pSpec, { KeepLiveSpec: true });
					tmpRecord.LiveSpec = tmpSnapshot;
					tmpRecord.PersistSpecHash = tmpSnapshot.SpecHash;
					// Writes made while this process was down are not proven applied (no Sweep runs on this path):
					// Unverified, so the Rebuilding state that follows never serves Exact requests until the swap.
					this.setState(pStore, pEntity, 'Unverified', 'SpecChange');
					this._writeState(tmpRecord, { Force: true }, () => {});
					this._rebuild(pStore, pEntity, 'SpecChange');
					return fCallback();
				}
				if (tmpDecision === 'RebuildFresh')
				{
					// The old layout is unknown: never serve or write the stale tables; build afresh.
					this.fable.log.warn(`RetoldFaceting Materializer: ${pStore}.${pEntity} changed incompatibly (${tmpClass.Reason || 'SpecChange'}) and its old layout is unknown; rebuilding it from scratch (answering Live meanwhile).`);
					return this._backfill(pStore, pEntity, 'SpecChange', fCallback, 'DropLive');
				}
				if (tmpDecision === 'Additive')
				{
					tmpRecord.PersistSpecHash = (tmpState.SpecHash || (pReport && pReport.SpecHash)) || pSpec.SpecHash;
					return this._additive(pStore, pEntity, tmpClass.Added.concat(tmpClass.KeymapAdded || []), tmpState, fCallback);
				}
				let tmpPersistedFilling = parseField(tmpState.FillingColumns, []);
				// Same layout.  A fill that did not finish before the last stop is repeated.
				if (Array.isArray(tmpPersistedFilling) && (tmpPersistedFilling.length > 0))
				{
					tmpRecord.PersistSpecHash = tmpState.SpecHash || pSpec.SpecHash;
					tmpRecord.FillingColumns = tmpPersistedFilling.filter((pColumn) => { return pSpec.ColumnNames.indexOf(pColumn) >= 0; });
				}
				let tmpClean = (Number(tmpState.CleanShutdown) === 1);
				if (tmpClean)
				{
					this.setState(pStore, pEntity, 'CatchingUp', 'CleanStart');
				}
				else
				{
					this.setState(pStore, pEntity, 'Unverified', 'UncleanShutdown');
				}
				// Running from here on: an unclean exit is detectable.
				this._writeState(tmpRecord, { Force: true },
					() =>
					{
						if (tmpRecord.FillingColumns.length > 0)
						{
							this._fill(pStore, pEntity, tmpRecord.FillingColumns.slice());
						}
						if (tmpClean)
						{
							this._catchUpAfterCleanStart(pStore, pEntity);
						}
						else
						{
							this._verify(pStore, pEntity);
						}
						return fCallback();
					});
			});
	}

	/**
	 * Classify the spec against the live tables (MirrorSpec.classifyChange when A provides it).
	 *
	 * @param {Record<string, any>|null} pReport
	 * @param {Record<string, any>} pSpec
	 * @return {{ Kind: string, Added: Array<string>, KeymapAdded: Array<string>, Reason: string|null }}
	 */
	_classify(pReport, pSpec)
	{
		let tmpMirrorSpec = this._mirrorSpec();
		if (tmpMirrorSpec && (typeof(tmpMirrorSpec.classifyChange) === 'function'))
		{
			return tmpMirrorSpec.classifyChange(pReport, pSpec);
		}
		let tmpReport = isPlainObject(pReport) ? pReport : {};
		if (!tmpReport.MirrorExists || !tmpReport.KeymapExists)
		{
			return { Kind: 'Absent', Added: [], KeymapAdded: [], Reason: 'NoMirror' };
		}
		return (tmpReport.SpecHash === pSpec.SpecHash) ? { Kind: 'Same', Added: [], KeymapAdded: [], Reason: null } : { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: 'SpecHash' };
	}

	/**
	 * Attach (or re-attach) an entity's WriterLoop to its collaborators.
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Array<string>} pTargets
	 * @param {Record<string, any>|null} [pLiveSpec] - the spec the live tables follow when it is not pRecord.Spec
	 */
	_attachLoop(pRecord, pTargets, pLiveSpec)
	{
		let tmpStoreRecord = this._Stores[pRecord.Store];
		pRecord.WriterLoop.attach(
			{
				StoreName: pRecord.Store,
				Entity: pRecord.Entity,
				Store: this.store(pRecord.Store),
				Spec: pLiveSpec || pRecord.Spec,
				Clock: tmpStoreRecord.Clock,
				PendingSet: pRecord.PendingSet,
				FlushBuffer: pRecord.FlushBuffer,
				Source: this._source(),
				Freshness: this._freshness(),
				Targets: pTargets,
				onFlushed: (pLoop, pInfo, fDone) => { return this._onFlushed(pRecord, pInfo, fDone); },
				onWipe: (pStore) => { return this.recoverWipe(pStore); },
				onSwapped: (pLoop, pInfo) => { return this._onSwapped(pRecord, pInfo); },
				leaseValid: () => { return this.leaseValid(pRecord.Store); }
			});
		pRecord.FlushBuffer.setStretch(tmpStoreRecord.Stretch || 1);
		pRecord.Attached = true;
		pRecord.LiveSpec = null;
	}

	/**
	 * Start a backfill through the Rebuilder (D).  DropLive: the live tables exist but cannot be trusted
	 * or written (an incompatible change with an unknown old layout): drop them first.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pReason
	 * @param {() => void} fCallback - called once the build was started (not finished)
	 * @param {string|null} [pDropLive]
	 */
	_backfill(pStore, pEntity, pReason, fCallback, pDropLive, pAttempt)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let tmpStore = this.store(pStore);
		let tmpStoreRecord = this._Stores[pStore];
		let tmpAttempt = (Number.isInteger(pAttempt) && (pAttempt > 0)) ? pAttempt : 1;
		let fStart = () =>
		{
			tmpRecord.WriterLoop.setTargets([]);
			this.setState(pStore, pEntity, 'Building', pReason);
			let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
			if (!tmpRebuilder || (typeof(tmpRebuilder.backfill) !== 'function'))
			{
				this.fable.log.error(`RetoldFaceting Materializer: no Rebuilder; ${pStore}.${pEntity} stays unbuilt (answering Live).`);
				return;
			}
			// At most MaxConcurrentBuilds builds of a store at once (each pages the whole entity).
			this._whenBuildSlot(pStore, `the backfill of ${pEntity}`,
				(fRelease) =>
				{
					if (!this._Started || this._Stopping || (this._record(pStore, pEntity) !== tmpRecord) || (this._Stores[pStore] !== tmpStoreRecord))
					{
						return fRelease();
					}
					tmpRebuilder.backfill(pStore, pEntity, { Reason: pReason },
						(pError, pResult) =>
						{
							fRelease();
							if (pError)
							{
								this.fable.log.error(`RetoldFaceting Materializer: the backfill of ${pStore}.${pEntity} failed (${pError.message}).`);
								return this._retryBackfill(pStore, pEntity, pReason, tmpRecord, tmpStoreRecord, pError, tmpAttempt);
							}
							this.fable.log.info(`RetoldFaceting Materializer: ${pStore}.${pEntity} built (${(pResult && pResult.Rows) || 0} rows).`);
						});
				});
		};
		// The build is started (queued); the caller goes on.
		if (pDropLive !== 'DropLive')
		{
			fStart();
			return fCallback();
		}
		this._dropLiveTables(tmpStore, pEntity, () => { fStart(); return fCallback(); });
	}

	/**
	 * A backfill failed (not cancelled, superseded or stopped): try again with back-off (×2 from 1 s
	 * to MaxBackoffMS) while the entity is still Absent and this process still materializes the store —
	 * never left unbuilt until a restart.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pReason
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pStoreRecord
	 * @param {Error} pError
	 * @param {number} pAttempt
	 */
	_retryBackfill(pStore, pEntity, pReason, pRecord, pStoreRecord, pError, pAttempt)
	{
		if (!pError || pError.Cancelled || pError.Superseded || ((pError.LoopError === 'Stopped') || (pError.LoopError === 'Crashed') || (pError.LoopError === 'LeaseLost') || (pError.LoopError === 'Wipe')))
		{
			return;
		}
		let tmpMax = ((this.options.Materializer || {}).MaxBackoffMS > 0) ? this.options.Materializer.MaxBackoffMS : 30000;
		let tmpDelay = Math.min(tmpMax, 1000 * Math.pow(2, Math.min(10, pAttempt - 1)));
		this.fable.log.warn(`RetoldFaceting Materializer: retrying the backfill of ${pStore}.${pEntity} in ${tmpDelay} ms (attempt ${pAttempt + 1}).`);
		this._timer(
			() =>
			{
				if (!this._Started || this._Stopping || (this._record(pStore, pEntity) !== pRecord) || (this._Stores[pStore] !== pStoreRecord) || !pStoreRecord.Available)
				{
					return;
				}
				let tmpFreshness = this._freshness();
				let tmpState = tmpFreshness ? tmpFreshness.state(pStore, pEntity).State : 'Absent';
				let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
				if ((tmpState !== 'Absent') || (tmpRebuilder && (typeof(tmpRebuilder.status) === 'function') && tmpRebuilder.status(pStore, pEntity)))
				{
					return;
				}
				this._backfill(pStore, pEntity, pReason, () => {}, null, pAttempt + 1);
			}, tmpDelay);
	}

	/**
	 * DROP the live mirror and keymap of an entity (an incompatible layout that cannot be rebuilt beside).
	 *
	 * @param {any} pStore
	 * @param {string} pEntity
	 * @param {() => void} fCallback
	 */
	_dropLiveTables(pStore, pEntity, fCallback)
	{
		if (!pStore || (typeof(pStore.command) !== 'function') || (typeof(pStore.Database) !== 'string'))
		{
			return fCallback();
		}
		let tmpStatements = [];
		try
		{
			tmpStatements.push(libDDL.dropTableDDL(pStore.Database, libDDL.mirrorTableName(pEntity)));
			tmpStatements.push(libDDL.dropTableDDL(pStore.Database, libDDL.keymapTableName(pEntity)));
		}
		catch (pError)
		{
			return fCallback();
		}
		series(tmpStatements.map((pSQL) => { return (fNext) => { pStore.command(pSQL, null, null, () => { return fNext(); }); }; }), fCallback);
	}

	/**
	 * Start a rebuild through the Rebuilder (D).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pReason
	 */
	_rebuild(pStore, pEntity, pReason)
	{
		let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
		if (!tmpRebuilder || (typeof(tmpRebuilder.rebuild) !== 'function'))
		{
			this.fable.log.error(`RetoldFaceting Materializer: no Rebuilder; ${pStore}.${pEntity} keeps its old layout.`);
			return;
		}
		let tmpRecord = this._record(pStore, pEntity);
		this._whenBuildSlot(pStore, `the ${pReason} rebuild of ${pEntity}`,
			(fRelease) =>
			{
				if (!this._Started || this._Stopping || (this._record(pStore, pEntity) !== tmpRecord))
				{
					return fRelease();
				}
				tmpRebuilder.rebuild(pStore, pEntity, { Reason: pReason },
					(pError) =>
					{
						fRelease();
						if (pError)
						{
							this.fable.log.error(`RetoldFaceting Materializer: the ${pReason} rebuild of ${pStore}.${pEntity} failed (${pError.message}).`);
						}
					});
			});
	}

	/**
	 * An additive spec change (§55.4): ALTER … ADD COLUMN, the new columns read as not mirrored until a
	 * full Fill pass rewrote every row, then the state row records the new SpecHash.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Array<string>} pAdded
	 * @param {Record<string, any>|null} pState
	 * @param {() => void} fCallback
	 */
	_additive(pStore, pEntity, pAdded, pState, fCallback)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let tmpStore = this.store(pStore);
		let tmpAdded = pAdded.filter((pColumn, pIndex) => { return pAdded.indexOf(pColumn) === pIndex; });
		tmpStore.addColumns(pEntity, tmpRecord.Spec, tmpAdded,
			(pError) =>
			{
				if (pError)
				{
					this.fable.log.error(`RetoldFaceting Materializer: adding columns to ${pStore}.${pEntity} failed (${pError.message}); rebuilding instead.`);
					return this._backfill(pStore, pEntity, 'SpecChange', fCallback, 'DropLive');
				}
				tmpRecord.FillingColumns = tmpAdded.filter((pColumn) => { return tmpRecord.Spec.ColumnNames.indexOf(pColumn) >= 0; });
				tmpRecord.WriterLoop.setTargets([ libStoreBase.TARGET_LIVE ]);
				let tmpClean = pState && (Number(pState.CleanShutdown) === 1);
				this.setState(pStore, pEntity, tmpClean ? 'CatchingUp' : 'Unverified', tmpClean ? 'CleanStart' : 'UncleanShutdown');
				this._writeState(tmpRecord, { Force: true },
					() =>
					{
						this._fill(pStore, pEntity, tmpRecord.FillingColumns.slice());
						if (tmpClean)
						{
							this._catchUpAfterCleanStart(pStore, pEntity);
						}
						else
						{
							this._verify(pStore, pEntity);
						}
						return fCallback();
					});
			});
	}

	/**
	 * One full pass of Fill Range tasks over the live mirror; then the filling columns are complete and
	 * the state row takes the new SpecHash.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Array<string>} pColumns
	 */
	_fill(pStore, pEntity, pColumns)
	{
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord || tmpRecord.Filling)
		{
			return;
		}
		tmpRecord.Filling = true;
		let tmpLoop = tmpRecord.WriterLoop;
		let fPage = (pAfterID) =>
		{
			tmpLoop.addRangeTask({ Kind: 'Fill', Target: libStoreBase.TARGET_LIVE, AfterID: pAfterID, ToID: null, Cap: tmpLoop.RebuildPageSize },
				(pError, pResult) =>
				{
					if (this._record(pStore, pEntity) !== tmpRecord)
					{
						return;
					}
					if (pError)
					{
						tmpRecord.Filling = false;
						this.fable.log.warn(`RetoldFaceting Materializer: filling new columns of ${pStore}.${pEntity} stopped (${pError.message}); they stay unmirrored until the next start.`);
						return;
					}
					if (pResult && !pResult.Exhausted && (pResult.LastID !== null))
					{
						return fPage(pResult.LastID);
					}
					tmpRecord.Filling = false;
					tmpRecord.FillingColumns = tmpRecord.FillingColumns.filter((pColumn) => { return pColumns.indexOf(pColumn) < 0; });
					if (tmpRecord.FillingColumns.length < 1)
					{
						tmpRecord.PersistSpecHash = tmpRecord.Spec.SpecHash;
					}
					this.fable.log.info(`RetoldFaceting Materializer: new columns of ${pStore}.${pEntity} are filled (${pColumns.join(', ')}).`);
					this._writeStateSoon(tmpRecord);
				});
		};
		fPage(null);
	}

	/**
	 * After a clean start (CatchingUp): Sweep from the watermark when the entity has one, then Live once
	 * the hints drained.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 */
	_catchUpAfterCleanStart(pStore, pEntity)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		let tmpReconcile = this.options.Reconcile || {};
		let tmpBisectAfter = (Number.isFinite(tmpReconcile.BootBisectAfterMS) && (tmpReconcile.BootBisectAfterMS >= 0)) ? tmpReconcile.BootBisectAfterMS : 300000;
		// Inserts and hard deletes other writers made during a long downtime are seen by no hint and no
		// Sweep: a Bisect runs (holding CatchingUp) before the entity serves Exact requests (04 §9.2).
		let tmpBisect = !!tmpReconciler && (typeof(tmpReconciler.bisect) === 'function') && (tmpRecord.DowntimeMS !== null) && (tmpRecord.DowntimeMS !== undefined) && (tmpRecord.DowntimeMS > tmpBisectAfter);
		let tmpSweep = !!tmpRecord.Spec.Watermark && !!tmpReconciler && (typeof(tmpReconciler.sweep) === 'function');
		if (!tmpBisect && !tmpSweep)
		{
			return this._watchCatchUp(pStore, pEntity, this.monotonicNow());
		}
		tmpRecord.CatchUpHold++;
		let fFailed = (pWhat, pError) =>
		{
			tmpRecord.CatchUpHold--;
			// The writes made while this process was down are not proven applied.
			this.fable.log.warn(`RetoldFaceting Materializer: the catch-up ${pWhat} of ${pStore}.${pEntity} failed (${pError.message}); verifying instead.`);
			this.setState(pStore, pEntity, 'Unverified', `${pWhat}Failed`);
			return this._verify(pStore, pEntity);
		};
		let fSweep = () =>
		{
			if (!tmpSweep)
			{
				tmpRecord.CatchUpHold--;
				return this._watchCatchUp(pStore, pEntity, this.monotonicNow());
			}
			tmpReconciler.sweep(pStore, pEntity, {},
				(pError) =>
				{
					if (this._record(pStore, pEntity) !== tmpRecord)
					{
						return;
					}
					if (pError)
					{
						return fFailed('Sweep', pError);
					}
					tmpRecord.CatchUpHold--;
					return this._watchCatchUp(pStore, pEntity, this.monotonicNow());
				});
		};
		if (!tmpBisect)
		{
			return fSweep();
		}
		this.fable.log.info(`RetoldFaceting Materializer: ${pStore}.${pEntity} was not written for ${Math.round(tmpRecord.DowntimeMS / 1000)} s; a Bisect runs before it serves Exact requests.`);
		tmpReconciler.bisect(pStore, pEntity, {},
			(pError) =>
			{
				if (this._record(pStore, pEntity) !== tmpRecord)
				{
					return;
				}
				if (pError)
				{
					return fFailed('Bisect', pError);
				}
				return fSweep();
			});
	}

	/**
	 * Poll until the hints that existed at pSince were applied, then CatchingUp → Live.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} pSince - monotonic
	 */
	_watchCatchUp(pStore, pEntity, pSince)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let fCheck = () =>
		{
			if (!this._Started || this._Stopping || (this._record(pStore, pEntity) !== tmpRecord))
			{
				return;
			}
			let tmpFreshness = this._freshness();
			let tmpState = tmpFreshness ? tmpFreshness.state(pStore, pEntity).State : 'Live';
			if (tmpState !== 'CatchingUp')
			{
				return;
			}
			let tmpInfo = this.pendingInfo(pStore, pEntity);
			let tmpDrained = (tmpRecord.CatchUpHold < 1) && tmpInfo && !tmpInfo.Dirty && (tmpInfo.Resolving < 1)
				&& (((tmpInfo.Pending + tmpInfo.InFlight + tmpInfo.Buffered) === 0) || ((typeof(tmpInfo.OldestFirstSeen) === 'number') && (tmpInfo.OldestFirstSeen > pSince)));
			if (tmpDrained)
			{
				this.setState(pStore, pEntity, 'Live', 'CaughtUp');
				return;
			}
			this._timer(fCheck, tmpRecord.WriterLoop.IdleTickMS);
		};
		fCheck();
	}

	/**
	 * Unverified recovery through the Reconciler (D): Bisect + a full Scrub, then Live.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 */
	_verify(pStore, pEntity)
	{
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		if (!tmpReconciler || (typeof(tmpReconciler.verify) !== 'function'))
		{
			this.fable.log.warn(`RetoldFaceting Materializer: no Reconciler; ${pStore}.${pEntity} stays Unverified (Exact requests answer Live).`);
			return;
		}
		let tmpRecord = this._record(pStore, pEntity);
		this._whenBuildSlot(pStore, `the verify of ${pEntity}`,
			(fRelease) =>
			{
				if (!this._Started || this._Stopping || (this._record(pStore, pEntity) !== tmpRecord))
				{
					return fRelease();
				}
				tmpReconciler.verify(pStore, pEntity,
					(pError) =>
					{
						fRelease();
						if (pError)
						{
							this.fable.log.warn(`RetoldFaceting Materializer: verifying ${pStore}.${pEntity} failed (${pError.message}); it stays Unverified.`);
						}
					});
			});
	}

	/**
	 * Start the Reconciler's timers for a store (Reconcile.AutoStart).
	 *
	 * @param {string} pStore
	 */
	_startReconciler(pStore)
	{
		let tmpReconcile = this.options.Reconcile || {};
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		if ((tmpReconcile.AutoStart !== false) && tmpReconciler && (typeof(tmpReconciler.start) === 'function'))
		{
			try
			{
				tmpReconciler.start(pStore);
			}
			catch (pError)
			{
				this.fable.log.error(`RetoldFaceting Materializer: the Reconciler did not start (${pError.message}).`);
			}
		}
	}

	// ---- the lease (one process materializes a store) -----------------------------------------

	/**
	 * @return {{ Enabled: boolean, TTLMS: number, HeartbeatMS: number, SettleMS: number }}
	 */
	_leaseOptions()
	{
		let tmpLease = ((this.options.Materializer || {}).Lease) || {};
		let fPositive = (pValue, pDefault) => { return (Number.isFinite(pValue) && (pValue > 0)) ? pValue : pDefault; };
		let tmpTTL = fPositive(tmpLease.TTLMS, 30000);
		return (
			{
				Enabled: (tmpLease.Enabled !== false),
				TTLMS: tmpTTL,
				HeartbeatMS: Math.min(fPositive(tmpLease.HeartbeatMS, 10000), Math.max(1, Math.floor(tmpTTL / 2))),
				SettleMS: (Number.isFinite(tmpLease.SettleMS) && (tmpLease.SettleMS >= 0)) ? tmpLease.SettleMS : 250
			});
	}

	/**
	 * Does this process hold the store's lease now (may it write)?  Always true for a store without
	 * lease support (the in-memory test store) or with Lease.Enabled false.
	 *
	 * @param {string} pStore
	 * @return {boolean}
	 */
	leaseValid(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord)
		{
			return false;
		}
		if (!tmpStoreRecord.Lease)
		{
			return false;
		}
		return (tmpStoreRecord.Lease.Unleased === true) || (Date.now() < tmpStoreRecord.Lease.ValidUntil);
	}

	/**
	 * Take the store's lease: read it; an unexpired lease of another owner → not the leader; else write a
	 * claim, wait SettleMS (a concurrent claimant's row lands), read back: the leader is the owner of the
	 * latest row (FINAL), so of two simultaneous claimants exactly one wins.
	 *
	 * @param {string} pStore
	 * @param {(pLeader: boolean, pReason?: string) => void} fCallback
	 */
	_acquireLease(pStore, fCallback)
	{
		let tmpStoreRecord = this._Stores[pStore];
		let tmpStore = this.store(pStore);
		let tmpOptions = this._leaseOptions();
		if (!tmpOptions.Enabled || !tmpStore || (typeof(tmpStore.readLease) !== 'function') || (typeof(tmpStore.writeLease) !== 'function'))
		{
			tmpStoreRecord.Lease = { Unleased: true, ValidUntil: Infinity };
			return fCallback(true);
		}
		let tmpMargin = Math.min(tmpOptions.HeartbeatMS, Math.floor(tmpOptions.TTLMS / 3));
		tmpStore.readLease(
			(pReadError, pLease) =>
			{
				if (pReadError)
				{
					this.fable.log.warn(`RetoldFaceting Materializer: the ${pStore} lease could not be read (${pReadError.message}); retrying.`);
					return fCallback(false, 'LeaseError');
				}
				let tmpNow = Date.now();
				if (pLease && !pLease.Released && (pLease.Owner !== this.OwnerID) && Number.isFinite(pLease.ExpiresAtMS) && (pLease.ExpiresAtMS > tmpNow))
				{
					this.fable.log.info(`RetoldFaceting Materializer: another process materializes ${pStore} (its lease runs ${Math.round((pLease.ExpiresAtMS - tmpNow) / 1000)} s more); this one leaves the store unused and asks again.`);
					return fCallback(false, 'NotLeader');
				}
				let tmpClaimAt = Date.now();
				tmpStore.writeLease({ Owner: this.OwnerID, ExpiresAtMS: tmpClaimAt + tmpOptions.TTLMS, Released: false, Version: tmpStoreRecord.Clock.next() },
					(pWriteError) =>
					{
						if (pWriteError)
						{
							return fCallback(false, 'LeaseError');
						}
						let tmpSettle = setTimeout(
							() =>
							{
								tmpStore.readLease(
									(pCheckError, pCheck) =>
									{
										if (pCheckError || !pCheck || (pCheck.Owner !== this.OwnerID) || pCheck.Released)
										{
											return fCallback(false, pCheckError ? 'LeaseError' : 'NotLeader');
										}
										tmpStoreRecord.Lease = { Unleased: false, ValidUntil: tmpClaimAt + tmpOptions.TTLMS - tmpMargin, Version: pCheck.Version };
										this.fable.log.info(`RetoldFaceting Materializer: this process materializes ${pStore} (lease ${this.OwnerID}).`);
										return fCallback(true);
									});
							}, tmpOptions.SettleMS);
						if (typeof(tmpSettle.unref) === 'function')
						{
							tmpSettle.unref();
						}
					});
			});
	}

	/**
	 * Renew the lease (every HeartbeatMS): never after it lapsed (a process paused past its TTL must not
	 * override a successor) — it is lost then; the read-back after the renewal must still name this
	 * process, else it is lost too.  A lost lease halts every loop of the store (no write after it).
	 *
	 * @param {string} pStore
	 */
	_heartbeat(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		let tmpStore = this.store(pStore);
		if (!tmpStoreRecord || !tmpStoreRecord.Lease || tmpStoreRecord.Lease.Unleased || tmpStoreRecord.LeaseBeating || !this._Started || this._Stopping)
		{
			return;
		}
		let tmpOptions = this._leaseOptions();
		let tmpMargin = Math.min(tmpOptions.HeartbeatMS, Math.floor(tmpOptions.TTLMS / 3));
		let tmpAt = Date.now();
		if (tmpAt >= tmpStoreRecord.Lease.ValidUntil)
		{
			return this._loseLease(pStore, 'the lease lapsed before it was renewed');
		}
		tmpStoreRecord.LeaseBeating = true;
		tmpStore.writeLease({ Owner: this.OwnerID, ExpiresAtMS: tmpAt + tmpOptions.TTLMS, Released: false, Version: tmpStoreRecord.Clock.next() },
			(pWriteError) =>
			{
				if (pWriteError)
				{
					tmpStoreRecord.LeaseBeating = false;
					// Not renewed: it lapses at ValidUntil unless a later beat lands (flushes stop then).
					return;
				}
				tmpStore.readLease(
					(pReadError, pLease) =>
					{
						tmpStoreRecord.LeaseBeating = false;
						if ((this._Stores[pStore] !== tmpStoreRecord) || !tmpStoreRecord.Lease)
						{
							return;
						}
						if (pReadError)
						{
							return;
						}
						if (!pLease || (pLease.Owner !== this.OwnerID) || pLease.Released)
						{
							return this._loseLease(pStore, 'another process holds the lease');
						}
						tmpStoreRecord.Lease.ValidUntil = tmpAt + tmpOptions.TTLMS - tmpMargin;
					});
			});
	}

	/**
	 * This process no longer materializes the store: halt every loop (buffered cycles go back to pending,
	 * nothing more is written), every entity Absent, the store unused ('LeaseLost'), and ask again later
	 * (a re-acquired store boots from its state rows: Unverified until verified).
	 *
	 * @param {string} pStore
	 * @param {string} pWhy
	 */
	_loseLease(pStore, pWhy)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || !tmpStoreRecord.Lease)
		{
			return;
		}
		this.fable.log.warn(`RetoldFaceting Materializer: lost the ${pStore} lease (${pWhy}); this process stops writing it and answers Live.`);
		tmpStoreRecord.Lease = null;
		this._stopStoreTimers(pStore);
		Object.keys(tmpStoreRecord.Entities).forEach(
			(pEntity) =>
			{
				let tmpRecord = tmpStoreRecord.Entities[pEntity];
				tmpRecord.WriterLoop.reset('LeaseLost', () => {});
				tmpRecord.Attached = false;
			});
		let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		[ tmpRebuilder, tmpReconciler ].forEach((pService) => { if (pService && (typeof(pService.stopStore) === 'function')) { try { pService.stopStore(pStore); } catch (pError) { /* stopping anyway */ } } });
		this._unavailable(pStore, 'LeaseLost', true);
	}

	/**
	 * Give the lease back (a graceful stop): the next process takes over at once.
	 *
	 * @param {string} pStore
	 * @param {number} pTimeoutMS
	 * @param {() => void} fCallback
	 */
	_releaseLease(pStore, pTimeoutMS, fCallback)
	{
		let tmpStoreRecord = this._Stores[pStore];
		let tmpStore = this.store(pStore);
		if (!tmpStoreRecord || !tmpStoreRecord.Lease || tmpStoreRecord.Lease.Unleased || !tmpStore || (typeof(tmpStore.writeLease) !== 'function') || !this.leaseValid(pStore))
		{
			return fCallback();
		}
		tmpStoreRecord.Lease = null;
		tmpStore.writeLease({ Owner: this.OwnerID, ExpiresAtMS: Date.now(), Released: true, Version: tmpStoreRecord.Clock.next() }, () => { return fCallback(); }, { TimeoutMS: Math.max(1, pTimeoutMS) });
	}

	// ---- per-store timers: lease heartbeat, coalesced state writes, merge back-pressure ---------

	/**
	 * Start the store's timers (unref'd): the lease heartbeat and the health check (active parts).
	 *
	 * @param {string} pStore
	 */
	_startStoreTimers(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord)
		{
			return;
		}
		this._stopStoreTimers(pStore);
		if (tmpStoreRecord.Lease && !tmpStoreRecord.Lease.Unleased)
		{
			tmpStoreRecord.LeaseTimer = setInterval(() => { this._heartbeat(pStore); }, this._leaseOptions().HeartbeatMS);
			if (typeof(tmpStoreRecord.LeaseTimer.unref) === 'function')
			{
				tmpStoreRecord.LeaseTimer.unref();
			}
		}
		let tmpStore = this.store(pStore);
		let tmpHealthMS = ((this.options.Materializer || {}).HealthCheckMS > 0) ? this.options.Materializer.HealthCheckMS : 30000;
		if (tmpStore && (typeof(tmpStore.activeParts) === 'function'))
		{
			tmpStoreRecord.HealthTimer = setInterval(() => { this._healthCheck(pStore); }, tmpHealthMS);
			if (typeof(tmpStoreRecord.HealthTimer.unref) === 'function')
			{
				tmpStoreRecord.HealthTimer.unref();
			}
		}
	}

	/**
	 * @param {string} pStore
	 */
	_stopStoreTimers(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord)
		{
			return;
		}
		[ 'LeaseTimer', 'HealthTimer' ].forEach((pName) => { if (tmpStoreRecord[pName]) { clearInterval(tmpStoreRecord[pName]); tmpStoreRecord[pName] = null; } });
		if (tmpStoreRecord.StateTimer)
		{
			clearTimeout(tmpStoreRecord.StateTimer);
			tmpStoreRecord.StateTimer = null;
		}
	}

	/**
	 * Merge back-pressure (design 04 §6.1 step 7): above Materializer.PartsBackoffAbove active parts in
	 * any table of the store, every loop's flush interval is stretched ×4 until merges catch up.
	 *
	 * @param {string} pStore
	 */
	_healthCheck(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		let tmpStore = this.store(pStore);
		if (!tmpStoreRecord || !tmpStoreRecord.Available || !tmpStore)
		{
			return;
		}
		tmpStore.activeParts(
			(pError, pParts) =>
			{
				if (pError || (this._Stores[pStore] !== tmpStoreRecord))
				{
					return;
				}
				let tmpAbove = ((this.options.Materializer || {}).PartsBackoffAbove > 0) ? this.options.Materializer.PartsBackoffAbove : 150;
				let tmpStretch = (pParts > tmpAbove) ? 4 : 1;
				if (tmpStretch !== tmpStoreRecord.Stretch)
				{
					tmpStoreRecord.Stretch = tmpStretch;
					this.fable.log[(tmpStretch > 1) ? 'warn' : 'info'](`RetoldFaceting Materializer: ${pStore} has ${pParts} active parts in a table; flush interval ×${tmpStretch}.`);
					Object.keys(tmpStoreRecord.Entities).forEach((pEntity) => { tmpStoreRecord.Entities[pEntity].FlushBuffer.setStretch(tmpStretch); });
				}
			});
	}

	/**
	 * Is the store usable for reads now (O(1): the request path asks it per Agg)?  Materialized by this
	 * process (holding the lease) and the store service reachable.
	 *
	 * @param {string} pStore
	 * @return {boolean}
	 */
	storeAvailable(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!this._Started || !tmpStoreRecord || !tmpStoreRecord.Available)
		{
			return false;
		}
		let tmpStore = this.store(pStore);
		let tmpStatus = (tmpStore && (typeof(tmpStore.status) === 'function')) ? tmpStore.status() : { Available: true };
		return !!tmpStatus && (tmpStatus.Available !== false);
	}

	// ---- the build queue ------------------------------------------------------------------------

	/**
	 * Run a build (backfill, SpecChange rebuild, boot verify) when one of the store's
	 * MaxConcurrentBuilds slots is free; fStart gets fRelease, which it calls once when the build ends.
	 *
	 * @param {string} pStore
	 * @param {string} pWhat - for the log
	 * @param {(fRelease: () => void) => void} fStart
	 */
	_whenBuildSlot(pStore, pWhat, fStart)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord)
		{
			return;
		}
		let tmpMax = ((this.options.Materializer || {}).MaxConcurrentBuilds >= 1) ? Math.floor(this.options.Materializer.MaxConcurrentBuilds) : 2;
		let tmpBuilds = tmpStoreRecord.Builds;
		let fRun = () =>
		{
			tmpBuilds.Running++;
			let tmpReleased = false;
			let fRelease = () =>
			{
				if (tmpReleased)
				{
					return;
				}
				tmpReleased = true;
				tmpBuilds.Running = Math.max(0, tmpBuilds.Running - 1);
				if ((tmpBuilds.Queue.length > 0) && (this._Stores[pStore] === tmpStoreRecord) && !this._Stopping)
				{
					let fNext = tmpBuilds.Queue.shift();
					setImmediate(fNext);
				}
			};
			try
			{
				fStart(fRelease);
			}
			catch (pError)
			{
				this.fable.log.error(`RetoldFaceting Materializer: starting ${pWhat} threw: ${pError.message}`);
				fRelease();
			}
		};
		if (tmpBuilds.Running < tmpMax)
		{
			return fRun();
		}
		tmpBuilds.Queue.push(fRun);
	}

	/**
	 * An unref'd timer the service owns.
	 *
	 * @param {() => void} fRun
	 * @param {number} pDelayMS
	 */
	_timer(fRun, pDelayMS)
	{
		let tmpTimer = setTimeout(() => { this._Timers.delete(tmpTimer); fRun(); }, Math.max(1, pDelayMS));
		if (typeof(tmpTimer.unref) === 'function')
		{
			tmpTimer.unref();
		}
		this._Timers.add(tmpTimer);
	}

	/**
	 * Graceful stop (§58.1): no new hints are accepted, every loop drains (≤ DrainOnStopMS) and flushes,
	 * CleanShutdown = 1 for each entity that drained (0 for the others) — written for every entity of a
	 * store in ONE insert, bounded by what is left of the deadline, no retries — then the lease is given
	 * back, timers cleared.  Bounded: at DrainOnStopMS (+ a short grace for the last writes) the store
	 * clients are closed and stop() calls back whatever is still pending (an unwritten CleanShutdown
	 * stays 0: the safe outcome).  Idempotent.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	stop(fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		if (!this._Started || this._Stopping)
		{
			return fDone();
		}
		this._Stopping = true;
		this._clearTimers();
		[ this.fable.RetoldFacetingReconciler, this.fable.RetoldFacetingRebuilder ].forEach(
			(pService) =>
			{
				if (pService && (typeof(pService.stop) === 'function'))
				{
					try
					{
						pService.stop();
					}
					catch (pError)
					{
						// Stopping anyway.
					}
				}
			});
		let tmpMaterializer = this.options.Materializer || {};
		let tmpDrainMS = ((typeof(tmpMaterializer.DrainOnStopMS) === 'number') && (tmpMaterializer.DrainOnStopMS >= 0)) ? tmpMaterializer.DrainOnStopMS : 5000;
		let tmpStartedAt = Date.now();
		let tmpDeadline = tmpStartedAt + tmpDrainMS;
		// The last writes (state rows, the lease release) get what is left, at least a short grace.
		let tmpHardDeadline = tmpDeadline + Math.min(2000, Math.max(250, Math.floor(tmpDrainMS / 5)));
		let tmpRecords = [];
		Object.keys(this._Stores).forEach((pStore) => { this._stopStoreTimers(pStore); Object.keys(this._Stores[pStore].Entities).forEach((pEntity) => { tmpRecords.push(this._Stores[pStore].Entities[pEntity]); }); });
		let tmpFinished = false;
		let tmpHardTimer = null;
		let fFinish = () =>
		{
			if (tmpFinished)
			{
				return;
			}
			tmpFinished = true;
			if (tmpHardTimer)
			{
				clearTimeout(tmpHardTimer);
			}
			// Nothing applies hints any more: no request may judge these mirrors current.
			let tmpFreshness = this._freshness();
			tmpRecords.forEach(
				(pRecord) =>
				{
					pRecord.WriterLoop.halt('Stopped');
					if (tmpFreshness)
					{
						tmpFreshness.setState(pRecord.Store, pRecord.Entity, 'Absent', 'Stopped');
					}
				});
			this._Started = false;
			this._Stopping = false;
			this._Stores = {};
			return fDone();
		};
		// A hung store must not hold the process past its stop grace (docker / k8s SIGKILL it): close the
		// clients (in-flight requests are destroyed) and finish.
		tmpHardTimer = setTimeout(
			() =>
			{
				if (tmpFinished)
				{
					return;
				}
				this.fable.log.warn(`RetoldFaceting Materializer: the store did not answer within the stop deadline (${tmpHardDeadline - tmpStartedAt} ms); closing its connections (unflushed entities restart Unverified).`);
				Object.keys(this._Stores).forEach((pStore) => { let tmpStore = this.store(pStore); if (tmpStore && (typeof(tmpStore.close) === 'function')) { try { tmpStore.close(); } catch (pError) { /* closing anyway */ } } });
				return fFinish();
			}, Math.max(1, tmpHardDeadline - Date.now()));
		if (typeof(tmpHardTimer.unref) === 'function')
		{
			tmpHardTimer.unref();
		}
		if (tmpRecords.length < 1)
		{
			let tmpStoreNames = Object.keys(this._Stores);
			return series(tmpStoreNames.map((pStore) => { return (fNext) => { this._releaseLease(pStore, Math.max(1, tmpHardDeadline - Date.now()), fNext); }; }), fFinish);
		}
		let tmpRemaining = tmpRecords.length;
		let tmpClean = {};
		let fAllDrained = () =>
		{
			// One CleanShutdown write per store (every entity's row in one insert), then the lease back.
			series(Object.keys(this._Stores).map(
				(pStore) =>
				{
					return (fNext) =>
					{
						let tmpEntries = tmpRecords.filter((pRecord) => { return (pRecord.Store === pStore) && tmpClean[`${pRecord.Store}:${pRecord.Entity}`]; });
						this._writeStatesNow(pStore, tmpEntries, { Force: true, TimeoutMS: Math.max(1, tmpHardDeadline - Date.now()) },
							() =>
							{
								this._releaseLease(pStore, Math.max(1, tmpHardDeadline - Date.now()), fNext);
							});
					};
				}), fFinish);
		};
		let fOne = () =>
		{
			tmpRemaining--;
			if (tmpRemaining === 0)
			{
				return fAllDrained();
			}
		};
		tmpRecords.forEach(
			(pRecord) =>
			{
				if (!pRecord.Attached || !this._Stores[pRecord.Store] || !this._Stores[pRecord.Store].Available)
				{
					pRecord.WriterLoop.halt('Stopped');
					return fOne();
				}
				pRecord.WriterLoop.drain(tmpDeadline,
					(pDrained) =>
					{
						let tmpState = this._freshness() ? this._freshness().state(pRecord.Store, pRecord.Entity).State : 'Absent';
						let tmpHasLive = [ 'Live', 'Lagging', 'Rebuilding', 'CatchingUp', 'Unverified' ].indexOf(tmpState) >= 0;
						if (pDrained && !pRecord.LostHints && tmpHasLive && (pRecord.Resolving < 1))
						{
							pRecord.CleanShutdown = 1;
							tmpClean[`${pRecord.Store}:${pRecord.Entity}`] = true;
						}
						return fOne();
					});
			});
	}

	/**
	 * TESTS ONLY: a kill -9 — drop every in-memory structure and timer without writing anything.
	 */
	crash()
	{
		this._clearTimers();
		[ this.fable.RetoldFacetingReconciler, this.fable.RetoldFacetingRebuilder ].forEach(
			(pService) =>
			{
				if (pService && (typeof(pService.stop) === 'function'))
				{
					try
					{
						pService.stop();
					}
					catch (pError)
					{
						// crashed anyway
					}
				}
			});
		let tmpStores = this._Stores;
		this._Stores = {};
		this._Started = false;
		this._Stopping = false;
		Object.keys(tmpStores).forEach(
			(pStore) =>
			{
				if (tmpStores[pStore].Timer)
				{
					clearTimeout(tmpStores[pStore].Timer);
				}
				[ 'LeaseTimer', 'HealthTimer' ].forEach((pName) => { if (tmpStores[pStore][pName]) { clearInterval(tmpStores[pStore][pName]); } });
				if (tmpStores[pStore].StateTimer)
				{
					clearTimeout(tmpStores[pStore].StateTimer);
				}
				Object.keys(tmpStores[pStore].Entities).forEach(
					(pEntity) =>
					{
						let tmpRecord = tmpStores[pStore].Entities[pEntity];
						tmpRecord.WriterLoop.halt('Crashed');
						tmpRecord.PendingSet.clear();
						let tmpFreshness = this._freshness();
						if (tmpFreshness && (typeof(tmpFreshness.unregister) === 'function'))
						{
							tmpFreshness.unregister(pStore, pEntity);
						}
					});
			});
	}

	/**
	 * Clear the service's timers.
	 */
	_clearTimers()
	{
		this._Timers.forEach((pTimer) => { clearTimeout(pTimer); });
		this._Timers.clear();
		Object.keys(this._Stores).forEach((pStore) => { if (this._Stores[pStore].Timer) { clearTimeout(this._Stores[pStore].Timer); this._Stores[pStore].Timer = null; } });
	}

	/**
	 * Model reload (§55.4): recompile; per entity resume, add columns, rebuild, build or stop.
	 *
	 * @param {(pError?: Error) => void} [fCallback]
	 */
	reload(fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		if (!this._Started || this._Stopping)
		{
			return fDone();
		}
		series(Object.keys(this._Stores).map((pStore) => { return (fNext) => { return this._reloadStore(pStore, fNext); }; }), () => { return fDone(); });
	}

	/**
	 * @param {string} pStore
	 * @param {() => void} fCallback
	 */
	_reloadStore(pStore, fCallback)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord.Available)
		{
			// The next connect compiles the new model anyway.
			return this._connectStore(pStore, fCallback);
		}
		let tmpCompiled;
		try
		{
			tmpCompiled = this._compile();
		}
		catch (pError)
		{
			this.fable.log.error(`RetoldFaceting Materializer: the Materialize declaration could not be recompiled (${pError.message}).`);
			return fCallback();
		}
		let tmpSpecs = (tmpCompiled && isPlainObject(tmpCompiled.Specs) && isPlainObject(tmpCompiled.Specs[pStore])) ? tmpCompiled.Specs[pStore] : {};
		this._dropUndeclared(pStore, tmpSpecs);
		let tmpStore = this.store(pStore);
		tmpStore.ensureSchema(tmpSpecs,
			(pError, pReport) =>
			{
				if (pError)
				{
					this.fable.log.error(`RetoldFaceting Materializer: the ${pStore} schema could not be ensured on reload (${pError.message}).`);
					return fCallback();
				}
				let tmpEntities = (pReport && isPlainObject(pReport.Entities)) ? pReport.Entities : {};
				series(Object.keys(tmpSpecs).sort().map(
					(pEntity) =>
					{
						return (fNext) =>
						{
							let tmpRecord = this._record(pStore, pEntity);
							let tmpSpec = tmpSpecs[pEntity];
							if (!tmpRecord || !tmpRecord.Attached || !tmpRecord.Spec)
							{
								return this._bootEntity(pStore, pEntity, tmpSpec, tmpEntities[pEntity] || null, fNext);
							}
							let tmpLoop = tmpRecord.WriterLoop;
							// A rebuild in flight (or live tables pinned to an older layout): every target keeps
							// the layout its tables have (setSpec never retargets them); a different spec is
							// rebuilt again once the current one swaps in (onSwapped, Current false).
							let tmpBuilding = !!tmpLoop.rebuild() || !!tmpRecord.LiveSpec || (tmpLoop.specFor(libStoreBase.TARGET_LIVE) !== tmpRecord.Spec);
							if (tmpRecord.Spec.SpecHash === tmpSpec.SpecHash)
							{
								tmpRecord.Spec = tmpSpec;
								tmpLoop.setSpec(tmpSpec, {});
								return fNext();
							}
							if (tmpBuilding)
							{
								tmpLoop.setSpec(tmpSpec, { KeepLiveSpec: true });
								tmpRecord.Spec = tmpSpec;
								tmpRecord.LiveSpec = tmpLoop.specFor(libStoreBase.TARGET_LIVE);
								if (!tmpLoop.rebuild())
								{
									this._rebuild(pStore, pEntity, 'SpecChange');
								}
								return fNext();
							}
							let tmpClass = this._classify(tmpEntities[pEntity] || null, tmpSpec);
							if (tmpClass.Kind === 'Absent')
							{
								tmpRecord.Spec = tmpSpec;
								tmpLoop.setSpec(tmpSpec, { LiveChanged: true });
								return this._backfill(pStore, pEntity, 'SpecChange', fNext, null);
							}
							if (tmpClass.Kind === 'Additive')
							{
								let tmpAdded = tmpClass.Added.concat(tmpClass.KeymapAdded || []);
								return tmpStore.addColumns(pEntity, tmpSpec, tmpAdded.filter((pColumn, pIndex) => { return tmpAdded.indexOf(pColumn) === pIndex; }),
									(pAddError) =>
									{
										if (pAddError)
										{
											this.fable.log.error(`RetoldFaceting Materializer: adding columns to ${pStore}.${pEntity} failed (${pAddError.message}); rebuilding.`);
											tmpLoop.setSpec(tmpSpec, { KeepLiveSpec: true });
											tmpRecord.Spec = tmpSpec;
											tmpRecord.LiveSpec = tmpLoop.specFor(libStoreBase.TARGET_LIVE);
											this._rebuild(pStore, pEntity, 'SpecChange');
											return fNext();
										}
										tmpRecord.Spec = tmpSpec;
										// The live tables now carry the new columns (filled by the Fill pass).
										tmpLoop.setSpec(tmpSpec, { LiveChanged: true });
										tmpRecord.FillingColumns = tmpClass.Added.filter((pColumn) => { return tmpSpec.ColumnNames.indexOf(pColumn) >= 0; });
										this._writeStateSoon(tmpRecord);
										this._fill(pStore, pEntity, tmpRecord.FillingColumns.slice());
										return fNext();
									});
							}
							// Not additive: the live tables keep the old layout (dual-written) until the swap.
							tmpLoop.setSpec(tmpSpec, { KeepLiveSpec: true });
							tmpRecord.LiveSpec = tmpLoop.specFor(libStoreBase.TARGET_LIVE);
							tmpRecord.Spec = tmpSpec;
							this._rebuild(pStore, pEntity, 'SpecChange');
							return fNext();
						};
					}), () => { return fCallback(); });
			});
	}

	// ---- hints --------------------------------------------------------------------------------

	/**
	 * The local change-sequence counter of an event (null for a foreign epoch or none).
	 *
	 * @param {Record<string, any>} pEvent
	 * @return {number|null}
	 */
	_seqN(pEvent)
	{
		let tmpSeq = libRetoldFacetingUtil.parseSeq(pEvent ? pEvent.Seq : null);
		if (!tmpSeq)
		{
			return null;
		}
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpLocal = (tmpIntake && (typeof(tmpIntake.NodeEpoch) === 'string')) ? tmpIntake.NodeEpoch : null;
		return (tmpLocal && (tmpSeq.Epoch === tmpLocal)) ? tmpSeq.N : null;
	}

	/**
	 * The ChangeIntake subscriber 'Materializer' (synchronous, no I/O, O(IDs); never throws).
	 *
	 * @param {Record<string, any>} pEvent - a frozen ChangeEvent (§39.2)
	 */
	onChange(pEvent)
	{
		try
		{
			if (!this._Started || !pEvent || (typeof(pEvent.Entity) !== 'string'))
			{
				return;
			}
			let tmpSeqN = this._seqN(pEvent);
			let tmpTenants = Array.isArray(pEvent.Tenants) ? pEvent.Tenants : [ '*' ];
			let tmpStores = Object.keys(this._Stores);
			for (let i = 0; i < tmpStores.length; i++)
			{
				let tmpRecord = this._record(tmpStores[i], pEvent.Entity);
				if (!tmpRecord)
				{
					continue;
				}
				if (this._Stopping)
				{
					// Stopped accepting work: this entity cannot claim a clean shutdown.
					tmpRecord.LostHints = true;
					continue;
				}
				let tmpIDs = Array.isArray(pEvent.IDs) ? pEvent.IDs : [];
				if (tmpIDs.length > 0)
				{
					this._addIDs(tmpRecord, tmpIDs, tmpSeqN, tmpTenants);
				}
				else if ((pEvent.Operation === 'EntityDirty') && pEvent.Filter && ((typeof(pEvent.Filter) === 'string') || Array.isArray(pEvent.Filter)))
				{
					this.resolveFilter(tmpRecord.Store, tmpRecord.Entity, pEvent.Filter, tmpTenants, tmpSeqN);
				}
				else
				{
					tmpRecord.PendingSet.markDirty(tmpSeqN, tmpTenants, this.monotonicNow());
					tmpRecord.WriterLoop.kick();
				}
			}
		}
		catch (pError)
		{
			this.fable.log.error(`RetoldFaceting Materializer.onChange failed: ${pError.message}`);
		}
	}

	/**
	 * IDs into the PendingSet (an ID that is not a safe integer collapses the entity to Dirty).
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Array<any>} pIDs
	 * @param {number|null} pSeqN
	 * @param {Array<any>} pTenants
	 * @return {number} IDs added
	 */
	_addIDs(pRecord, pIDs, pSeqN, pTenants)
	{
		let tmpNow = this.monotonicNow();
		let tmpAdded = 0;
		let tmpUnknown = false;
		for (let i = 0; i < pIDs.length; i++)
		{
			let tmpID = toID(pIDs[i]);
			if (tmpID === null)
			{
				tmpUnknown = true;
				continue;
			}
			pRecord.PendingSet.add(tmpID, pSeqN, tmpNow);
			tmpAdded++;
		}
		if (tmpUnknown)
		{
			pRecord.PendingSet.markDirty(pSeqN, pTenants || [ '*' ], tmpNow);
		}
		pRecord.WriterLoop.kick();
		return tmpAdded;
	}

	/**
	 * IDs from the Reconciler, a filter resolution or an admin call (§58.1).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Array<any>} pIDs
	 * @param {{ Source: string, SeqN?: number|null }} [pOptions]
	 * @return {number} IDs enqueued
	 */
	enqueue(pStore, pEntity, pIDs, pOptions)
	{
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord || !this._Started || this._Stopping || !Array.isArray(pIDs))
		{
			return 0;
		}
		let tmpOptions = pOptions || {};
		let tmpSeqN = ((typeof(tmpOptions.SeqN) === 'number') && Number.isFinite(tmpOptions.SeqN)) ? tmpOptions.SeqN : null;
		return this._addIDs(tmpRecord, pIDs, tmpSeqN, [ '*' ]);
	}

	/**
	 * Is an ID pending (or in flight) for (S, E)?
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {any} pID
	 * @return {boolean}
	 */
	isPending(pStore, pEntity, pID)
	{
		let tmpRecord = this._record(pStore, pEntity);
		let tmpID = toID(pID);
		return !!tmpRecord && (tmpID !== null) && tmpRecord.PendingSet.has(tmpID);
	}

	/**
	 * A filter-scoped hint (notifyByFilter, §58.8): mirror IDs (the PRE-write predicate over the live
	 * mirror) ∪ source IDs (soft-deleted rows included) → enqueue; any refusal or error → a whole-entity
	 * Resync.  The entity counts as Resolving until done.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string|Array<Record<string, any>>} pFilter
	 * @param {Array<any>} pTenants
	 * @param {number|null} pSeqN
	 * @param {(pError?: Error|null, pResult?: { Enqueued: number, Dirty: boolean }) => void} [fCallback]
	 */
	resolveFilter(pStore, pEntity, pFilter, pTenants, pSeqN, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord)
		{
			return fDone(null, { Enqueued: 0, Dirty: false });
		}
		tmpRecord.Resolving++;
		if (tmpRecord.ResolvingSince === null)
		{
			tmpRecord.ResolvingSince = this.monotonicNow();
		}
		let tmpEnded = false;
		let fEnd = (pDirtyReason, pIDs) =>
		{
			if (tmpEnded)
			{
				return;
			}
			tmpEnded = true;
			let tmpEnqueued = 0;
			if (this._record(pStore, pEntity) === tmpRecord)
			{
				if (pDirtyReason)
				{
					this.fable.log.info(`RetoldFaceting Materializer: a filter-scoped change of ${pStore}.${pEntity} could not be resolved (${pDirtyReason}); re-reading the entity.`);
					tmpRecord.PendingSet.markDirty(pSeqN, pTenants || [ '*' ], this.monotonicNow());
				}
				else
				{
					tmpEnqueued = this._addIDs(tmpRecord, pIDs, pSeqN, pTenants);
				}
				tmpRecord.Resolving--;
				if (tmpRecord.Resolving < 1)
				{
					tmpRecord.Resolving = 0;
					tmpRecord.ResolvingSince = null;
				}
				tmpRecord.WriterLoop.kick();
			}
			return fDone(null, { Enqueued: tmpEnqueued, Dirty: !!pDirtyReason });
		};
		try
		{
			if (!tmpRecord.Attached || !tmpRecord.Spec)
			{
				return fEnd('NotAttached');
			}
			let tmpSource = this._source();
			let tmpDialect = (tmpSource && (typeof(tmpSource.dialect) === 'function')) ? (tmpSource.dialect(pEntity) || 'SQLite') : 'SQLite';
			let tmpEntries = this._filterEntries(pEntity, pFilter, tmpDialect);
			if (!tmpEntries)
			{
				return fEnd('FilterUnreadable');
			}
			let tmpCap = tmpRecord.PendingSet.OverflowIDs;
			this._mirrorIDs(tmpRecord, tmpEntries, tmpDialect,
				(pMirrorError, pMirrorIDs) =>
				{
					if (pMirrorError)
					{
						return fEnd(pMirrorError.message || 'MirrorRead');
					}
					if (!tmpSource || (typeof(tmpSource.idsByFilter) !== 'function'))
					{
						return fEnd('NoSource');
					}
					tmpSource.idsByFilter(pEntity, tmpEntries, { Cap: tmpCap },
						(pSourceError, pSourceIDs) =>
						{
							if (pSourceError)
							{
								return fEnd('SourceRead');
							}
							let tmpIDs = new Set();
							(pMirrorIDs || []).forEach((pID) => { let tmpID = toID(pID); if (tmpID !== null) { tmpIDs.add(tmpID); } });
							(pSourceIDs || []).forEach((pID) => { let tmpID = toID(pID); if (tmpID !== null) { tmpIDs.add(tmpID); } });
							if (((pSourceIDs || []).length > tmpCap) || (tmpIDs.size > tmpCap))
							{
								return fEnd('TooMany');
							}
							return fEnd(null, Array.from(tmpIDs));
						});
				});
		}
		catch (pError)
		{
			return fEnd(pError.message || 'Error');
		}
	}

	/**
	 * A notifyByFilter filter as FoxHound entries: a meadow filter string through FilterAST onto a
	 * scratch query of the entity's DAL; an entry array as given.  null when it cannot be read.
	 *
	 * @param {string} pEntity
	 * @param {string|Array<Record<string, any>>} pFilter
	 * @param {string} pDialect
	 * @return {Array<Record<string, any>>|null}
	 */
	_filterEntries(pEntity, pFilter, pDialect)
	{
		if (Array.isArray(pFilter))
		{
			return JSON.parse(JSON.stringify(pFilter));
		}
		if ((typeof(pFilter) !== 'string') || (pFilter.length < 1))
		{
			return null;
		}
		let tmpFilterAST = this.fable.RetoldFacetingFilterAST;
		let tmpService = this.fable.RetoldFacetingService;
		let tmpHost = (tmpService && tmpService.Host) ? tmpService.Host : null;
		let tmpDAL = (tmpHost && (typeof(tmpHost.getDAL) === 'function')) ? tmpHost.getDAL(pEntity) : null;
		if (!tmpFilterAST || !tmpDAL)
		{
			return null;
		}
		let tmpAST = tmpFilterAST.build(pEntity, { FilterString: pFilter });
		let tmpQuery = tmpDAL.query;
		tmpQuery.setDisableDeleteTracking(true);
		tmpFilterAST.applyToQuery(tmpAST.Conjuncts || [], tmpQuery, { Dialect: pDialect, ParameterPrefix: 'n' });
		return JSON.parse(JSON.stringify(tmpQuery.parameters.filter || []));
	}

	/**
	 * The live mirror's IDs matching filter entries (the PRE-write predicate: rows that left the filter).
	 * An entity whose live table is not built yet answers [] (its build reads everything anyway).
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Array<Record<string, any>>} pEntries
	 * @param {string} pDialect
	 * @param {(pError?: Error|null, pIDs?: Array<any>) => void} fCallback
	 */
	_mirrorIDs(pRecord, pEntries, pDialect, fCallback)
	{
		if (pRecord.WriterLoop.targets().indexOf(libStoreBase.TARGET_LIVE) < 0)
		{
			return fCallback(new Error('NoLiveTable'));
		}
		let tmpCompile = this.compileFilter;
		if (typeof(tmpCompile) !== 'function')
		{
			let tmpCompiler = null;
			try
			{
				tmpCompiler = require('../store/clickhouse/ClickHouse-FoldCompiler.js');
			}
			catch (pError)
			{
				tmpCompiler = null;
			}
			tmpCompile = (tmpCompiler && (typeof(tmpCompiler.compileFilter) === 'function')) ? tmpCompiler.compileFilter : null;
		}
		if (!tmpCompile)
		{
			return fCallback(new Error('NoCompiler'));
		}
		let tmpStore = this.store(pRecord.Store);
		let tmpSpec = pRecord.WriterLoop.specFor(libStoreBase.TARGET_LIVE);
		let tmpLossy = {};
		tmpLossy[pRecord.Entity] = pRecord.WriterLoop.lossy();
		let tmpFilling = {};
		tmpFilling[pRecord.Entity] = this._fillingColumns(pRecord);
		let tmpSection = (isPlainObject(this.options.Stores) && isPlainObject(this.options.Stores[pRecord.Store])) ? this.options.Stores[pRecord.Store] : {};
		let tmpOrder = tmpSection.SourceStringOrder;
		if ((tmpOrder !== 'Binary') && (tmpOrder !== 'Collated'))
		{
			tmpOrder = (pDialect === 'SQLite') ? 'Binary' : 'Collated';
		}
		let tmpCompiled = tmpCompile(tmpSpec, pEntries, { SourceDialect: pDialect, SourceStringOrder: tmpOrder, Lossy: tmpLossy, Filling: tmpFilling, Prefix: 'f' });
		if (!tmpCompiled || tmpCompiled.Refused || (typeof(tmpCompiled.SQL) !== 'string'))
		{
			return fCallback(new Error((tmpCompiled && tmpCompiled.Refused) ? `Refused:${tmpCompiled.Refused}` : 'Refused'));
		}
		let tmpSQL;
		try
		{
			tmpSQL = `SELECT DISTINCT ${libDDL.quoteIdentifier(tmpSpec.Identity)} AS \`ID\` FROM ${libDDL.qualified(tmpStore.Database, libDDL.mirrorTableName(pRecord.Entity))} FINAL WHERE \`_IsDeleted\` = 0 AND (${tmpCompiled.SQL})`;
		}
		catch (pError)
		{
			return fCallback(new Error('Identifier'));
		}
		tmpStore.queryRows(tmpSQL, tmpCompiled.Params || {}, tmpCompiled.Types || {}, {},
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(new Error('MirrorRead'));
				}
				return fCallback(null, (pRows || []).map((pRow) => { return pRow.ID; }));
			});
	}

	// ---- flush / swap callbacks, state ----------------------------------------------------------

	/**
	 * After every acknowledged flush (§58.5 step 8): AppliedSeq, CatchingUp → Live when drained, the state
	 * row (when something it carries changed).
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pInfo
	 * @param {() => void} fDone
	 */
	_onFlushed(pRecord, pInfo, fDone)
	{
		let tmpFreshness = this._freshness();
		if (tmpFreshness)
		{
			tmpFreshness.applied(pRecord.Store, pRecord.Entity);
			if ((tmpFreshness.state(pRecord.Store, pRecord.Entity).State === 'CatchingUp') && (pRecord.CatchUpHold < 1))
			{
				let tmpInfo = this.pendingInfo(pRecord.Store, pRecord.Entity);
				let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
				let tmpBuilding = !!(tmpRebuilder && (typeof(tmpRebuilder.status) === 'function') && tmpRebuilder.status(pRecord.Store, pRecord.Entity));
				if (tmpInfo && !tmpBuilding && !tmpInfo.Dirty && (tmpInfo.Resolving < 1) && ((tmpInfo.Pending + tmpInfo.InFlight) === 0))
				{
					this.setState(pRecord.Store, pRecord.Entity, 'Live', 'CaughtUp');
				}
			}
		}
		return this._writeState(pRecord, {}, () => { return fDone(); });
	}

	/**
	 * After a swap: Epoch++ (persisted), the live tables follow the new spec.
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {Record<string, any>} pInfo
	 */
	_onSwapped(pRecord, pInfo)
	{
		pRecord.Epoch++;
		let tmpCurrent = !pInfo || (pInfo.Current !== false);
		pRecord.LiveSpec = tmpCurrent ? null : (pInfo.Spec || null);
		pRecord.PersistSpecHash = (tmpCurrent || !pInfo.Spec) ? (pRecord.Spec ? pRecord.Spec.SpecHash : pRecord.PersistSpecHash) : pInfo.Spec.SpecHash;
		pRecord.FillingColumns = [];
		if (!tmpCurrent)
		{
			// The model changed again while this rebuild paged: the live tables follow the older spec
			// (pinned in the loop); rebuild once more for the current one.
			setImmediate(() => { if (this._Started && !this._Stopping && (this._record(pRecord.Store, pRecord.Entity) === pRecord)) { this._rebuild(pRecord.Store, pRecord.Entity, 'SpecChange'); } });
		}
		let tmpFreshness = this._freshness();
		if (tmpFreshness && (typeof(tmpFreshness.setEpoch) === 'function'))
		{
			tmpFreshness.setEpoch(pRecord.Store, pRecord.Entity, pRecord.Epoch);
		}
		this._writeStateSoon(pRecord);
	}

	/**
	 * A state transition (through Freshness, §61.1); persisted soon.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pState
	 * @param {string|null} [pReason]
	 */
	setState(pStore, pEntity, pState, pReason)
	{
		let tmpFreshness = this._freshness();
		if (tmpFreshness)
		{
			tmpFreshness.setState(pStore, pEntity, pState, pReason || null);
		}
		let tmpRecord = this._record(pStore, pEntity);
		if (tmpRecord && tmpRecord.Attached && this._Started)
		{
			this._writeStateSoon(tmpRecord);
		}
	}

	/**
	 * Fields of the state row other services own (the Rebuilder's LastRebuild, the Reconciler's
	 * SweepWatermark / ScrubCursor / ScrubbedThrough / LastBisect), merged and written now.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pFields
	 * @param {(pError?: Error|null) => void} [fCallback]
	 */
	updateState(pStore, pEntity, pFields, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord || !tmpRecord.Attached)
		{
			return fDone(null);
		}
		let tmpFields = isPlainObject(pFields) ? pFields : {};
		STATE_FIELDS.forEach((pField) => { if (Object.prototype.hasOwnProperty.call(tmpFields, pField)) { tmpRecord.Persisted[pField] = tmpFields[pField]; } });
		return this._writeState(tmpRecord, {}, fDone);
	}

	/**
	 * Write the state row on the next tick (coalesced).
	 *
	 * @param {Record<string, any>} pRecord
	 */
	_writeStateSoon(pRecord)
	{
		if (pRecord.StateSoon)
		{
			return;
		}
		pRecord.StateSoon = true;
		setImmediate(
			() =>
			{
				pRecord.StateSoon = false;
				if (this._Started && (this._record(pRecord.Store, pRecord.Entity) === pRecord))
				{
					this._writeState(pRecord, {}, () => {});
				}
			});
	}

	/**
	 * The spec the live tables follow (for the snapshot).
	 *
	 * @param {Record<string, any>} pRecord
	 * @return {Record<string, any>|null}
	 */
	_liveSpec(pRecord)
	{
		return pRecord.Attached ? pRecord.WriterLoop.specFor(libStoreBase.TARGET_LIVE) : pRecord.Spec;
	}

	/**
	 * Columns still being filled, plus (during a SpecChange rebuild) every column of the new spec the live
	 * tables do not hold with the same type: the engine treats all of them as not mirrored.
	 *
	 * @param {Record<string, any>} pRecord
	 * @return {Array<string>}
	 */
	_fillingColumns(pRecord)
	{
		let tmpFilling = pRecord.FillingColumns.slice();
		let tmpLive = pRecord.Attached ? pRecord.WriterLoop.specFor(libStoreBase.TARGET_LIVE) : null;
		if (tmpLive && pRecord.Spec && (tmpLive !== pRecord.Spec) && Array.isArray(tmpLive.Columns))
		{
			let tmpLiveTypes = {};
			tmpLive.Columns.forEach((pColumn) => { tmpLiveTypes[pColumn.Column] = pColumn.Mirror; });
			pRecord.Spec.Columns.forEach(
				(pColumn) =>
				{
					if ((tmpLiveTypes[pColumn.Column] !== pColumn.Mirror) && (tmpFilling.indexOf(pColumn.Column) < 0))
					{
						tmpFilling.push(pColumn.Column);
					}
				});
		}
		return tmpFilling.sort();
	}

	/**
	 * The full state row (§56.2): the latest state object, every field.
	 *
	 * @param {Record<string, any>} pRecord
	 * @return {Record<string, any>}
	 */
	_stateRow(pRecord)
	{
		let tmpFreshness = this._freshness();
		let tmpState = tmpFreshness ? tmpFreshness.state(pRecord.Store, pRecord.Entity) : { State: 'Absent', UnverifiedSince: null };
		let tmpFields = Object.assign({}, pRecord.Persisted);
		[ this.fable.RetoldFacetingRebuilder, this.fable.RetoldFacetingReconciler ].forEach(
			(pService) =>
			{
				if (pService && (typeof(pService.stateFields) === 'function'))
				{
					try
					{
						let tmpPulled = pService.stateFields(pRecord.Store, pRecord.Entity) || {};
						STATE_FIELDS.forEach((pField) => { if ((tmpPulled[pField] !== undefined) && (tmpPulled[pField] !== null)) { tmpFields[pField] = tmpPulled[pField]; } });
					}
					catch (pError)
					{
						// A pull seam must never fail a state write.
					}
				}
			});
		let tmpSnapshot = null;
		let tmpLiveSpec = this._liveSpec(pRecord);
		if (tmpLiveSpec)
		{
			tmpSnapshot = {};
			SNAPSHOT_KEYS.forEach((pKey) => { if (tmpLiveSpec[pKey] !== undefined) { tmpSnapshot[pKey] = tmpLiveSpec[pKey]; } });
		}
		return (
			{
				Store: pRecord.Store,
				Entity: pRecord.Entity,
				State: (tmpState.State === 'Lagging') ? 'Live' : tmpState.State,
				Epoch: pRecord.Epoch,
				SpecHash: pRecord.PersistSpecHash || (pRecord.Spec ? pRecord.Spec.SpecHash : ''),
				AppliedSeq: tmpFreshness ? tmpFreshness.appliedSeq(pRecord.Store, pRecord.Entity) : {},
				CleanShutdown: pRecord.CleanShutdown ? 1 : 0,
				LossyColumns: pRecord.Attached ? pRecord.WriterLoop.lossy() : {},
				FillingColumns: pRecord.FillingColumns.slice(),
				SweepWatermark: (tmpFields.SweepWatermark !== undefined) ? tmpFields.SweepWatermark : null,
				ScrubCursor: (tmpFields.ScrubCursor !== undefined) ? tmpFields.ScrubCursor : null,
				ScrubbedThrough: (tmpFields.ScrubbedThrough !== undefined) ? tmpFields.ScrubbedThrough : null,
				LastRebuild: (tmpFields.LastRebuild !== undefined) ? tmpFields.LastRebuild : null,
				LastBisect: (tmpFields.LastBisect !== undefined) ? tmpFields.LastBisect : null,
				UnverifiedSince: formatUTC(tmpState.UnverifiedSince),
				Detail:
					{
						Quarantined: pRecord.Attached ? pRecord.WriterLoop.quarantined() : 0,
						LastErrorCode: pRecord.Attached ? (pRecord.WriterLoop.stats().LastErrorCode || null) : null,
						Spec: tmpSnapshot
					}
			});
	}

	/**
	 * The lifecycle part of a state row: what a restart, a request admission or a takeover depends on
	 * (written at once when it changes; the rest — AppliedSeq, counters, cursors, watermarks — is
	 * coalesced).
	 *
	 * @param {Record<string, any>} pRow
	 * @return {string}
	 */
	_lifecycleText(pRow)
	{
		return libFacetClauses.canonicalJSON(
			{
				State: pRow.State, Epoch: pRow.Epoch, SpecHash: pRow.SpecHash, CleanShutdown: pRow.CleanShutdown,
				LossyColumns: pRow.LossyColumns, FillingColumns: pRow.FillingColumns, UnverifiedSince: pRow.UnverifiedSince,
				Spec: (pRow.Detail && pRow.Detail.Spec) ? pRow.Detail.Spec.SpecHash || null : null
			});
	}

	/**
	 * Write the state row (one writer; skipped when nothing it carries changed unless Force).  A change of
	 * its lifecycle part is written at once; a change of anything else (AppliedSeq after a flush, a Scrub
	 * cursor, a watermark) is coalesced into the store's next periodic write (StateWriteIntervalMS, one
	 * multi-row INSERT for every changed entity) — the shared state table gets about one part per interval,
	 * not several per flush.  Only the lease holder writes.  A wipe error starts recoverWipe.
	 *
	 * @param {Record<string, any>} pRecord
	 * @param {{ Force?: boolean }} pOptions
	 * @param {(pError?: Error|null) => void} fCallback
	 */
	_writeState(pRecord, pOptions, fCallback)
	{
		let tmpStoreRecord = this._Stores[pRecord.Store];
		let tmpStore = this.store(pRecord.Store);
		if (!tmpStoreRecord || !tmpStoreRecord.Available || !tmpStore || !pRecord.Attached || !this.leaseValid(pRecord.Store))
		{
			return fCallback(null);
		}
		let tmpForce = !!(pOptions && pOptions.Force);
		let tmpRow = this._stateRow(pRecord);
		let tmpText = libFacetClauses.canonicalJSON(tmpRow);
		if (!tmpForce && (tmpText === pRecord.LastStateText))
		{
			return fCallback(null);
		}
		if (!tmpForce && (this._lifecycleText(tmpRow) === pRecord.LastLifecycleText))
		{
			// Only informational fields changed: the store's next periodic write carries them.
			tmpStoreRecord.StateDirty.add(pRecord);
			this._scheduleStateFlush(pRecord.Store);
			return fCallback(null);
		}
		return this._writeStatesNow(pRecord.Store, [ pRecord ], { Force: tmpForce }, fCallback);
	}

	/**
	 * The store's periodic coalesced state write (unref'd, every StateWriteIntervalMS while something is
	 * dirty).
	 *
	 * @param {string} pStore
	 */
	_scheduleStateFlush(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || tmpStoreRecord.StateTimer || this._Stopping)
		{
			return;
		}
		let tmpInterval = ((this.options.Materializer || {}).StateWriteIntervalMS >= 0) ? this.options.Materializer.StateWriteIntervalMS : 5000;
		tmpStoreRecord.StateTimer = setTimeout(
			() =>
			{
				tmpStoreRecord.StateTimer = null;
				if ((this._Stores[pStore] !== tmpStoreRecord) || !this._Started || this._Stopping)
				{
					return;
				}
				let tmpDirty = Array.from(tmpStoreRecord.StateDirty);
				tmpStoreRecord.StateDirty.clear();
				this._writeStatesNow(pStore, tmpDirty, {},
					() =>
					{
						if (tmpStoreRecord.StateDirty.size > 0)
						{
							this._scheduleStateFlush(pStore);
						}
					});
			}, Math.max(1, tmpInterval));
		if (typeof(tmpStoreRecord.StateTimer.unref) === 'function')
		{
			tmpStoreRecord.StateTimer.unref();
		}
	}

	/**
	 * Run the store's coalesced state write now instead of at its interval (quiesce).
	 *
	 * @param {string} pStore
	 */
	_flushStatesSoon(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || tmpStoreRecord.StateFlushing)
		{
			return;
		}
		if (tmpStoreRecord.StateTimer)
		{
			clearTimeout(tmpStoreRecord.StateTimer);
			tmpStoreRecord.StateTimer = null;
		}
		let tmpDirty = Array.from(tmpStoreRecord.StateDirty);
		tmpStoreRecord.StateDirty.clear();
		tmpStoreRecord.StateFlushing = true;
		this._writeStatesNow(pStore, tmpDirty, {},
			() =>
			{
				tmpStoreRecord.StateFlushing = false;
				if (tmpStoreRecord.StateDirty.size > 0)
				{
					this._scheduleStateFlush(pStore);
				}
			});
	}

	/**
	 * Write the state rows of these entities now: ONE insert for all of them (Store.writeStates), else one
	 * writeState each.  pOptions.TimeoutMS bounds the write (a shutdown's last one).
	 *
	 * @param {string} pStore
	 * @param {Array<Record<string, any>>} pRecords
	 * @param {{ Force?: boolean, TimeoutMS?: number }} pOptions
	 * @param {(pError?: Error|null) => void} fCallback
	 */
	_writeStatesNow(pStore, pRecords, pOptions, fCallback)
	{
		let tmpStoreRecord = this._Stores[pStore];
		let tmpStore = this.store(pStore);
		let tmpOptions = pOptions || {};
		if (!tmpStoreRecord || !tmpStore || !this.leaseValid(pStore))
		{
			return fCallback(null);
		}
		let tmpWrites = [];
		(pRecords || []).forEach(
			(pRecord) =>
			{
				if (!pRecord.Attached || (this._record(pStore, pRecord.Entity) !== pRecord))
				{
					return;
				}
				let tmpRow = this._stateRow(pRecord);
				let tmpText = libFacetClauses.canonicalJSON(tmpRow);
				if (!tmpOptions.Force && (tmpText === pRecord.LastStateText))
				{
					return;
				}
				let tmpVersion = tmpStoreRecord.Clock.next();
				tmpRow.Version = tmpVersion;
				tmpRow._Version = tmpVersion;
				tmpStoreRecord.StateDirty.delete(pRecord);
				tmpWrites.push({ Record: pRecord, Row: tmpRow, Text: tmpText, Lifecycle: this._lifecycleText(tmpRow) });
			});
		if (tmpWrites.length < 1)
		{
			return fCallback(null);
		}
		let tmpCallOptions = (Number.isFinite(tmpOptions.TimeoutMS) && (tmpOptions.TimeoutMS > 0)) ? { TimeoutMS: tmpOptions.TimeoutMS } : undefined;
		let fWritten = (pError) =>
		{
			tmpWrites.forEach(
				(pWrite) =>
				{
					pWrite.Record.StateWrites++;
					if (!pError)
					{
						pWrite.Record.LastStateText = pWrite.Text;
						pWrite.Record.LastLifecycleText = pWrite.Lifecycle;
					}
				});
			if (pError)
			{
				this.fable.log.warn(`RetoldFaceting Materializer: the state of ${pStore} (${tmpWrites.map((pWrite) => { return pWrite.Record.Entity; }).join(', ')}) could not be written (${pError.message}).`);
				let tmpCodes = (tmpStore.constructor && Array.isArray(tmpStore.constructor.WIPE_ERROR_CODES)) ? tmpStore.constructor.WIPE_ERROR_CODES : [ 60, 81 ];
				if ((pError.Code !== undefined) && (tmpCodes.indexOf(Number(pError.Code)) >= 0))
				{
					setImmediate(() => { this.recoverWipe(pStore); });
				}
				else if (!this._Stopping)
				{
					// Not written: carried by the next periodic write.
					tmpWrites.forEach((pWrite) => { tmpStoreRecord.StateDirty.add(pWrite.Record); });
					this._scheduleStateFlush(pStore);
				}
			}
			return fCallback(pError || null);
		};
		if (typeof(tmpStore.writeStates) === 'function')
		{
			return tmpStore.writeStates(tmpWrites.map((pWrite) => { return { Entity: pWrite.Record.Entity, State: pWrite.Row }; }), (pError) => { return fWritten(pError); }, tmpCallOptions);
		}
		let tmpFirstError = null;
		series(tmpWrites.map(
			(pWrite) =>
			{
				return (fNext) =>
				{
					tmpStore.writeState(pWrite.Record.Entity, pWrite.Row, (pError) => { tmpFirstError = tmpFirstError || pError || null; return fNext(); }, tmpCallOptions);
				};
			}), () => { return fWritten(tmpFirstError); });
	}

	// ---- wipe ---------------------------------------------------------------------------------

	/**
	 * A read noticed a missing database or table (the request path): confirm it — at most once per
	 * WIPE_CHECK_MS per store — and recover only what is really gone.  A request never starts a rebuild
	 * by itself.
	 *
	 * @param {string} pStore
	 */
	suspectWipe(pStore)
	{
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || !this._Started || this._Stopping || tmpStoreRecord.Recovering || !tmpStoreRecord.Available)
		{
			return;
		}
		let tmpCooldown = Math.min(WIPE_CHECK_MS, ((this.options.Admin || {}).RebuildCooldownMS > 0) ? this.options.Admin.RebuildCooldownMS : WIPE_CHECK_MS);
		let tmpNow = Date.now();
		if ((tmpNow - tmpStoreRecord.WipeCheckAt) < tmpCooldown)
		{
			return;
		}
		tmpStoreRecord.WipeCheckAt = tmpNow;
		this.recoverWipe(pStore);
	}

	/**
	 * A wiped store (§59.3), confirmed first: Store.tablesExist says which entities lost their live mirror
	 * or keymap (all of them when the database is gone).  Only those go Absent and are backfilled (Reason
	 * 'Wipe'); entities whose tables are intact keep running (their state rows are rewritten).  A false
	 * alarm changes nothing.  One recovery at a time per store.
	 *
	 * @param {string} pStore
	 * @param {(pError?: Error) => void} [fCallback]
	 */
	recoverWipe(pStore, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpStoreRecord = this._Stores[pStore];
		if (!tmpStoreRecord || !this._Started || this._Stopping || tmpStoreRecord.Recovering || !tmpStoreRecord.Available)
		{
			return fDone();
		}
		tmpStoreRecord.Recovering = true;
		let tmpStore = this.store(pStore);
		let tmpAll = Object.keys(tmpStoreRecord.Entities).map((pEntity) => { return tmpStoreRecord.Entities[pEntity]; });
		let fRecover = (pMissing) =>
		{
			let tmpRecords = tmpAll.filter((pRecord) => { return pMissing.indexOf(pRecord.Entity) >= 0; });
			let tmpIntact = tmpAll.filter((pRecord) => { return pMissing.indexOf(pRecord.Entity) < 0; });
			if (tmpRecords.length < 1)
			{
				this.fable.log.info(`RetoldFaceting Materializer: a missing-table error on ${pStore} was not confirmed (every live table exists); nothing to recover.`);
			}
			else
			{
				this.fable.log.warn(`RetoldFaceting Materializer: the ${pStore} store lost the tables of ${tmpRecords.map((pRecord) => { return pRecord.Entity; }).join(', ')} (wiped); rebuilding ${(tmpRecords.length === 1) ? 'it' : 'them'} (answering Live meanwhile).`);
			}
			tmpRecords.forEach(
				(pRecord) =>
				{
					let tmpFreshness = this._freshness();
					if (tmpFreshness)
					{
						tmpFreshness.setState(pStore, pRecord.Entity, 'Absent', 'Wipe');
					}
					pRecord.FillingColumns = [];
					pRecord.Filling = false;
				});
			// Every state row is rewritten (a lost state table loses them all).
			tmpAll.forEach((pRecord) => { pRecord.LastStateText = null; pRecord.LastLifecycleText = null; });
			series(tmpRecords.map((pRecord) => { return (fNext) => { return pRecord.WriterLoop.reset('Wipe', () => { return fNext(); }); }; }),
				() =>
				{
					let tmpSpecs = {};
					tmpAll.forEach((pRecord) => { if (pRecord.Spec) { tmpSpecs[pRecord.Entity] = pRecord.Spec; } });
					let fEnd = () =>
					{
						tmpStoreRecord.Recovering = false;
						return fDone();
					};
					tmpStore.ensureSchema(tmpSpecs,
						(pError) =>
						{
							if (pError)
							{
								this.fable.log.error(`RetoldFaceting Materializer: the ${pStore} schema could not be recreated after a wipe (${pError.message}); retrying.`);
								tmpStoreRecord.Recovering = false;
								tmpStoreRecord.Available = false;
								this._unavailable(pStore, 'SchemaError', true);
								return fDone();
							}
							tmpIntact.forEach((pRecord) => { if (pRecord.Attached) { this._writeStateSoon(pRecord); } });
							series(tmpRecords.map(
								(pRecord) =>
								{
									return (fNext) =>
									{
										pRecord.WriterLoop.setSpec(pRecord.Spec, { LiveChanged: true });
										pRecord.LiveSpec = null;
										pRecord.PersistSpecHash = pRecord.Spec ? pRecord.Spec.SpecHash : null;
										pRecord.CleanShutdown = 0;
										return this._backfill(pStore, pRecord.Entity, 'Wipe', fNext, null);
									};
								}), fEnd);
						});
				});
		};
		if (!tmpStore || (typeof(tmpStore.tablesExist) !== 'function'))
		{
			return fRecover(tmpAll.map((pRecord) => { return pRecord.Entity; }));
		}
		tmpStore.tablesExist(tmpAll.map((pRecord) => { return pRecord.Entity; }),
			(pError, pResult) =>
			{
				if (pError || !pResult)
				{
					// Unconfirmed (the store did not answer): nothing is rebuilt now; the next error asks again.
					this.fable.log.warn(`RetoldFaceting Materializer: could not confirm a wipe of ${pStore} (${pError ? pError.message : 'no answer'}); nothing rebuilt.`);
					tmpStoreRecord.Recovering = false;
					return fDone();
				}
				let tmpMissing = tmpAll.map((pRecord) => { return pRecord.Entity; }).filter((pEntity) => { return !pResult.Database || (pResult.Entities[pEntity] !== true); });
				// An entity still building has no live table yet: not a loss.
				let tmpFreshness = this._freshness();
				tmpMissing = tmpMissing.filter(
					(pEntity) =>
					{
						if (!pResult.Database)
						{
							return true;
						}
						let tmpState = tmpFreshness ? tmpFreshness.state(pStore, pEntity).State : 'Absent';
						return (tmpState !== 'Building') && (tmpState !== 'Absent');
					});
				return fRecover(tmpMissing);
			});
	}

	// ---- read side ----------------------------------------------------------------------------

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {any|null} the entity's RetoldFacetingWriterLoop
	 */
	loop(pStore, pEntity)
	{
		let tmpRecord = this._record(pStore, pEntity);
		return tmpRecord ? tmpRecord.WriterLoop : null;
	}

	/**
	 * Flush an entity's buffered cycles now.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {(pError?: Error) => void} fCallback
	 */
	flushNow(pStore, pEntity, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord || !tmpRecord.Attached)
		{
			return fDone();
		}
		return tmpRecord.WriterLoop.flush(fDone);
	}

	/**
	 * Is an entity quiet: nothing pending, in flight, buffered, Dirty, resolving, queued, building,
	 * catching up or reconciling?
	 *
	 * @param {Record<string, any>} pRecord
	 * @return {{ Quiet: boolean, Why: string|null }}
	 */
	_quiet(pRecord)
	{
		if (!pRecord.Attached)
		{
			return { Quiet: false, Why: 'NotAttached' };
		}
		let tmpFreshness = this._freshness();
		let tmpState = tmpFreshness ? tmpFreshness.state(pRecord.Store, pRecord.Entity).State : 'Live';
		if (UNSETTLED_STATES.indexOf(tmpState) >= 0)
		{
			return { Quiet: false, Why: `State:${tmpState}` };
		}
		if (tmpState === 'Degraded')
		{
			return { Quiet: false, Why: 'State:Degraded' };
		}
		if (!pRecord.WriterLoop.quiet())
		{
			return { Quiet: false, Why: 'Loop' };
		}
		if ((pRecord.Resolving > 0) || pRecord.Filling || (pRecord.CatchUpHold > 0))
		{
			return { Quiet: false, Why: 'Resolving' };
		}
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		if (tmpIntake && (typeof(tmpIntake.settling) === 'function') && tmpIntake.settling(pRecord.Entity))
		{
			// A notify's settle re-delivery is still armed: that hint is known, not yet observed.
			return { Quiet: false, Why: 'Settle' };
		}
		let tmpStoreRecord = this._Stores[pRecord.Store];
		if (tmpStoreRecord && tmpStoreRecord.StateDirty.has(pRecord))
		{
			// A coalesced state write is due: quiescence includes it (write it now).
			this._flushStatesSoon(pRecord.Store);
			return { Quiet: false, Why: 'State' };
		}
		let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
		if (tmpRebuilder && (typeof(tmpRebuilder.status) === 'function') && tmpRebuilder.status(pRecord.Store, pRecord.Entity))
		{
			return { Quiet: false, Why: 'Rebuild' };
		}
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		if (tmpReconciler && (typeof(tmpReconciler.status) === 'function'))
		{
			let tmpStatus = tmpReconciler.status(pRecord.Store, pRecord.Entity);
			if (tmpStatus && Array.isArray(tmpStatus.Running) && (tmpStatus.Running.length > 0))
			{
				return { Quiet: false, Why: `Reconcile:${tmpStatus.Running.join(',')}` };
			}
		}
		return { Quiet: true, Why: null };
	}

	/**
	 * Wait until no pending, in-flight, buffered, Dirty or resolving work remains for the entities (all
	 * of the store's when pEntities is null), every build finished and the last flush acked; buffered
	 * cycles are flushed at once instead of waiting for the interval.  An error after pTimeoutMS.
	 *
	 * @param {string} pStore
	 * @param {Array<string>|null} pEntities
	 * @param {number} pTimeoutMS
	 * @param {(pError?: Error) => void} fCallback
	 */
	quiesce(pStore, pEntities, pTimeoutMS, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : ((typeof(pTimeoutMS) === 'function') ? pTimeoutMS : () => {});
		let tmpTimeout = ((typeof(pTimeoutMS) === 'number') && (pTimeoutMS > 0)) ? pTimeoutMS : 30000;
		let tmpDeadline = Date.now() + tmpTimeout;
		let tmpStreak = 0;
		let tmpTick = Math.max(5, Math.min(50, ((this.options.Materializer || {}).IdleTickMS) || 50));
		let fCheck = () =>
		{
			let tmpStoreRecord = this._Stores[pStore];
			if (!this._Started || !tmpStoreRecord)
			{
				return fDone(new Error(`RetoldFaceting Materializer.quiesce: the ${pStore} store is not materializing.`));
			}
			let tmpEntities = Array.isArray(pEntities) ? pEntities : Object.keys(tmpStoreRecord.Entities);
			let tmpBusy = null;
			for (let i = 0; i < tmpEntities.length; i++)
			{
				let tmpRecord = tmpStoreRecord.Entities[tmpEntities[i]];
				if (!tmpRecord)
				{
					return fDone(new Error(`RetoldFaceting Materializer.quiesce: ${pStore}.${tmpEntities[i]} is not materialized.`));
				}
				let tmpQuiet = this._quiet(tmpRecord);
				if (!tmpQuiet.Quiet)
				{
					tmpBusy = `${tmpEntities[i]} (${tmpQuiet.Why})`;
					// Do not wait for the flush interval (nor for batched hints to find company).
					if (tmpRecord.Attached && ((tmpRecord.FlushBuffer.size() > 0) || (tmpRecord.PendingSet.available() > 0)))
					{
						tmpRecord.WriterLoop.requestFlush();
					}
					break;
				}
			}
			if (!tmpStoreRecord.Available)
			{
				tmpBusy = tmpBusy || `the store (${tmpStoreRecord.Reason || 'Unavailable'})`;
			}
			if (tmpBusy === null)
			{
				tmpStreak++;
				if (tmpStreak >= 2)
				{
					return fDone();
				}
			}
			else
			{
				tmpStreak = 0;
			}
			if (Date.now() >= tmpDeadline)
			{
				return fDone(new Error(`RetoldFaceting Materializer.quiesce: ${pStore} did not quiesce within ${tmpTimeout} ms (busy: ${tmpBusy || 'unknown'}).`));
			}
			let tmpTimer = setTimeout(fCheck, tmpTick);
			if (typeof(tmpTimer.unref) === 'function')
			{
				tmpTimer.unref();
			}
		};
		setImmediate(fCheck);
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {{ Light?: boolean }} [pOptions] - Light: no MinSeqN (O(1); the request path)
	 * @return {Record<string, any>|null}
	 */
	pendingInfo(pStore, pEntity, pOptions)
	{
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord)
		{
			return null;
		}
		let tmpInfo = tmpRecord.PendingSet.info(pOptions);
		let tmpTasks = tmpRecord.WriterLoop.taskInfo();
		return Object.assign(tmpInfo,
			{
				Buffered: tmpRecord.FlushBuffer.size(),
				Resolving: tmpRecord.Resolving,
				ResolvingSince: tmpRecord.ResolvingSince,
				Tasks: tmpTasks.Total,
				Resync: tmpTasks.ResyncRunning
			});
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	entityInfo(pStore, pEntity)
	{
		let tmpRecord = this._record(pStore, pEntity);
		if (!tmpRecord)
		{
			return null;
		}
		let tmpFreshness = this._freshness();
		let tmpState = tmpFreshness ? tmpFreshness.state(pStore, pEntity) : { State: 'Absent' };
		let tmpStoreRecord = this._Stores[pStore];
		return (
			{
				Spec: tmpRecord.Spec,
				LiveSpec: tmpRecord.Attached ? tmpRecord.WriterLoop.specFor(libStoreBase.TARGET_LIVE) : null,
				State: tmpState.State,
				Epoch: tmpRecord.Epoch,
				Lossy: tmpRecord.WriterLoop.lossy(),
				FillingColumns: this._fillingColumns(tmpRecord),
				Quarantined: tmpRecord.WriterLoop.quarantined(),
				Available: !!(tmpStoreRecord && tmpStoreRecord.Available && tmpRecord.Attached)
			});
	}

	/**
	 * @return {{ Stores: Record<string, any> }}
	 */
	status()
	{
		let tmpStatus = { Stores: {} };
		let tmpFreshness = this._freshness();
		Object.keys(this._Stores).forEach(
			(pStore) =>
			{
				let tmpStoreRecord = this._Stores[pStore];
				let tmpEntities = {};
				Object.keys(tmpStoreRecord.Entities).forEach(
					(pEntity) =>
					{
						let tmpRecord = tmpStoreRecord.Entities[pEntity];
						let tmpInfo = tmpRecord.PendingSet.info({ Light: true });
						let tmpStats = tmpRecord.WriterLoop.stats();
						let tmpFresh = tmpFreshness ? tmpFreshness.entityFreshness(pStore, pEntity, Date.now()) : { State: 'Absent', LagMS: Infinity, AppliedSeq: {} };
						tmpEntities[pEntity] = (
							{
								State: tmpFresh.State,
								Pending: tmpInfo.Pending,
								InFlight: tmpInfo.InFlight,
								Buffered: tmpRecord.FlushBuffer.size(),
								LagMS: tmpFresh.LagMS,
								AppliedSeq: tmpFresh.AppliedSeq,
								Cycles: tmpStats.Cycles,
								Flushes: tmpStats.Flushes,
								FlushErrors: tmpStats.FlushErrors,
								Rows: tmpStats.Rows,
								Tombstones: tmpStats.Tombstones,
								Quarantined: tmpStats.Quarantined,
								Lossy: tmpRecord.WriterLoop.lossy(),
								Dirty: !!tmpInfo.Dirty,
								Epoch: tmpRecord.Epoch
							});
					});
				tmpStatus.Stores[pStore] = { Available: tmpStoreRecord.Available, Reason: tmpStoreRecord.Reason, Leader: !!tmpStoreRecord.Lease, Builds: { Running: tmpStoreRecord.Builds.Running, Queued: tmpStoreRecord.Builds.Queue.length }, Stretch: tmpStoreRecord.Stretch, Entities: tmpEntities };
			});
		return tmpStatus;
	}

	/**
	 * A full Scrub rotation of (S, E) that started at pPassStartMS completed: the Lossy flags known only
	 * as 'sticky' (seeded at boot) are now known row by row and clear.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} pPassStartMS
	 */
	scrubWrapped(pStore, pEntity, pPassStartMS)
	{
		let tmpRecord = this._record(pStore, pEntity);
		if (tmpRecord && tmpRecord.Attached && tmpRecord.WriterLoop.clearStickyLossy(pPassStartMS))
		{
			this._writeStateSoon(tmpRecord);
		}
	}

	/**
	 * @return {boolean}
	 */
	started()
	{
		return this._Started;
	}
}

module.exports = RetoldFacetingMaterializer;
module.exports.serviceType = 'RetoldFacetingMaterializer';
module.exports.HINT_SOURCES = HINT_SOURCES;
module.exports.SETTLE_SUFFIX = SETTLE_SUFFIX;
module.exports.formatUTC = formatUTC;
