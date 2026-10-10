/**
 * Facet-ClickHouse-Support — what every ClickHouse-gated suite shares (internal-contracts §66.1).
 *
 *   available()                                  → { Available, Reason }  (RFS_TEST_CLICKHOUSE=1 or RFS_TEST_CLICKHOUSE_URL)
 *   ensure(fCallback)                            → (pError, pConnectionInfo): the container (or URL server), once per process
 *   connectionInfo()                             → { URL, Host, Port, User, Password, Source }
 *   freshDatabase()                              → 'rfs_<pid>_<n>' (kept out of the leftover sweep while in use)
 *   storeOptions(pDatabase, pExtra)              → a Stores.ClickHouse object for the test server
 *   release(pDatabase, fCallback)                → DROP DATABASE IF EXISTS … SYNC (only rfs_<pid>_<n> names)
 *   loadMirrors(pHarness, { Database, Entities?, Materialize?, StoreOptions? }, fCallback)
 *                                                the static loader: MirrorSpec → ensureSchema → createLive →
 *                                                trusted source rows → writeBatch('Live') → state row
 *   assertMirrorEqualsSource(pHarness, pStoreName, pEntity, fCallback)   the O10 invariant (IDs only in the Report)
 *   readSourceRows(pHarness, pSpec, fCallback)   every source row (trusted DAL read, soft-deleted included)
 *   expectedRows(pHarness, pSpec, fCallback)     { Rows: Map(ID → store row), Lossy, Quarantined, Source }
 *   sourceDialect(pHarness, pEntity)             'SQLite' | 'PostgreSQL'
 *
 * The gate/ensure/database helpers were implemented by the M5 contracts pass; builder A owns the file.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libDockerClickHouse = require('./Facet-Docker-ClickHouse.js');
const libTypeMap = require('../../source/store/clickhouse/ClickHouse-TypeMap.js');

// Database names this process created and has not dropped yet.
const ACTIVE_DATABASES = new Set();

let _DatabaseCounter = 0;
let _EnsuredInfo = null;
let _EnsureWaiters = null;

/**
 * @return {{ Available: boolean, Reason: string|null }}
 */
const available = () =>
{
	if (!libDockerClickHouse.gateOn())
	{
		return { Available: false, Reason: 'ClickHouse suites are gated: set RFS_TEST_CLICKHOUSE=1 (npm run test:ch) or RFS_TEST_CLICKHOUSE_URL.' };
	}
	return { Available: true, Reason: null };
};

/**
 * Start (or reuse) the server once per process; concurrent callers wait for the same ensure().
 *
 * @param {(pError?: Error, pInfo?: Record<string, any>) => void} fCallback
 */
const ensure = (fCallback) =>
{
	if (_EnsuredInfo)
	{
		return fCallback(null, _EnsuredInfo);
	}
	if (_EnsureWaiters)
	{
		_EnsureWaiters.push(fCallback);
		return;
	}
	_EnsureWaiters = [ fCallback ];
	libDockerClickHouse.ensure({ Keep: Array.from(ACTIVE_DATABASES) },
		(pError, pInfo) =>
		{
			if (!pError)
			{
				_EnsuredInfo = pInfo;
			}
			let tmpWaiters = _EnsureWaiters;
			_EnsureWaiters = null;
			tmpWaiters.forEach((fWaiter) => { fWaiter(pError || null, pInfo); });
		});
};

/**
 * @return {Record<string, any>}
 */
const connectionInfo = () =>
{
	return libDockerClickHouse.connectionInfo();
};

/**
 * @return {string} a fresh rfs_<pid>_<n> database name (not yet created: the store creates it)
 */
const freshDatabase = () =>
{
	_DatabaseCounter++;
	let tmpName = `rfs_${process.pid}_${_DatabaseCounter}`;
	ACTIVE_DATABASES.add(tmpName);
	return tmpName;
};

/**
 * A Stores.ClickHouse section for the test server.
 *
 * @param {string} pDatabase
 * @param {Record<string, any>} [pExtra] - merged over the defaults (e.g. { RetryConnectMS: 200 })
 * @return {Record<string, any>}
 */
const storeOptions = (pDatabase, pExtra) =>
{
	let tmpInfo = connectionInfo();
	return Object.assign(
		{
			URL: tmpInfo.URL,
			User: tmpInfo.User,
			Password: tmpInfo.Password,
			Database: pDatabase,
			TimeoutMS: 20000,
			PingTimeoutMS: 2000,
			RetryConnectMS: 1000,
			// The suites assert the per-facet freshness and the Describe detail (the test hosts have a scope
			// policy, so 'Auto' would hide them); the gating itself is tested with ExposeFreshness false.
			ExposeFreshness: true
		}, pExtra || {});
};

/**
 * Drop a test database (only names this module hands out).
 *
 * @param {string} pDatabase
 * @param {(pError?: Error) => void} fCallback
 */
const release = (pDatabase, fCallback) =>
{
	if (!libDockerClickHouse.DATABASE_NAME_PATTERN.test(String(pDatabase)))
	{
		return fCallback(new Error('Facet-ClickHouse-Support: release only drops rfs_<pid>_<n> databases.'));
	}
	libDockerClickHouse.query(connectionInfo(), `DROP DATABASE IF EXISTS \`${pDatabase}\` SYNC`,
		(pError) =>
		{
			ACTIVE_DATABASES.delete(pDatabase);
			return fCallback(pError || null);
		});
};

// Rows per trusted source page (loadMirrors / assertMirrorEqualsSource).
const SOURCE_PAGE = 5000;

/**
 * The harness's services (the faceting service, its host, the MirrorSpec and the ClickHouse store).
 *
 * @param {Record<string, any>} pHarness
 * @return {{ Fable: any, Host: any, MirrorSpec: any, Store: any }}
 */
const services = (pHarness) =>
{
	let tmpFable = pHarness.fable;
	let tmpService = pHarness.faceting || tmpFable.RetoldFacetingService;
	return (
		{
			Fable: tmpFable,
			Host: tmpService ? tmpService.Host : null,
			MirrorSpec: tmpFable.RetoldFacetingMirrorSpec,
			Store: tmpFable.RetoldFacetingStoreClickHouse
		});
};

/**
 * The SourceDialect of an entity ('SQLite' | 'PostgreSQL').
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @return {string}
 */
const sourceDialect = (pHarness, pEntity) =>
{
	let tmpHost = services(pHarness).Host;
	let tmpProfile = (tmpHost && (typeof(tmpHost.getDialectProfile) === 'function')) ? tmpHost.getDialectProfile(pEntity) : null;
	return (tmpProfile && tmpProfile.Name) ? tmpProfile.Name : 'SQLite';
};

/**
 * Every source row of an entity through a trusted DAL read (MaterializeSource-equivalent: the DAL,
 * delete tracking off so soft-deleted rows are seen, an explicit projection of the spec's
 * SourceColumns, provider.Read with no behaviors, keyset pages by identity), as plain objects.
 *
 * @param {Record<string, any>} pHarness
 * @param {Record<string, any>} pSpec
 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
 */
const readSourceRows = (pHarness, pSpec, fCallback) =>
{
	let tmpHost = services(pHarness).Host;
	let tmpDAL = tmpHost ? tmpHost.getDAL(pSpec.Entity) : null;
	if (!tmpDAL)
	{
		return fCallback(new Error(`Facet-ClickHouse-Support: ${pSpec.Entity} has no DAL.`));
	}
	let tmpRows = [];
	let fPage = (pAfterID) =>
	{
		let tmpQuery = tmpDAL.query;
		tmpQuery.setDisableDeleteTracking(true);
		tmpQuery.setDataElements(pSpec.SourceColumns.slice());
		if (pAfterID !== null)
		{
			tmpQuery.addFilter(pSpec.Identity, pAfterID, '>');
		}
		tmpQuery.addSort({ Column: pSpec.Identity, Direction: 'Ascending' });
		tmpQuery.setCap(SOURCE_PAGE);
		let tmpDone = false;
		let fReadDone = () =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpDone = true;
			setImmediate(
				() =>
				{
					let tmpResult = tmpQuery.parameters.result || {};
					if (tmpResult.error)
					{
						return fCallback(tmpResult.error);
					}
					let tmpPage = (Array.isArray(tmpResult.value) ? tmpResult.value : []).map((pRow) => { return Object.assign({}, pRow); });
					tmpRows = tmpRows.concat(tmpPage);
					if (tmpPage.length < SOURCE_PAGE)
					{
						return fCallback(null, tmpRows);
					}
					return fPage(Number(tmpPage[tmpPage.length - 1][pSpec.Identity]));
				});
		};
		try
		{
			tmpDAL.provider.Read(tmpQuery, fReadDone);
		}
		catch (pReadError)
		{
			if (!tmpDone)
			{
				tmpDone = true;
				return fCallback(pReadError);
			}
		}
	};
	fPage(null);
};

/**
 * The store form of an entity's source: Map(ID → store row) of the live, non-quarantined rows
 * (TypeMap.toStoreRow), plus the Lossy flags and the quarantine count.
 *
 * @param {Record<string, any>} pHarness
 * @param {Record<string, any>} pSpec
 * @param {(pError?: Error, pResult?: { Rows: Map<number, Record<string, any>>, Lossy: Record<string, string>, Quarantined: number, Source: number }) => void} fCallback
 */
const expectedRows = (pHarness, pSpec, fCallback) =>
{
	let tmpDialect = sourceDialect(pHarness, pSpec.Entity);
	readSourceRows(pHarness, pSpec,
		(pError, pSourceRows) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpRows = new Map();
			let tmpLossy = {};
			let tmpQuarantined = 0;
			pSourceRows.forEach(
				(pSourceRow) =>
				{
					let tmpConverted = libTypeMap.toStoreRow(pSpec, pSourceRow, tmpDialect);
					Object.keys(tmpConverted.Lossy).forEach(
						(pColumn) =>
						{
							if (tmpLossy[pColumn] !== 'Value')
							{
								tmpLossy[pColumn] = tmpConverted.Lossy[pColumn];
							}
						});
					if (!libTypeMap.isLive(pSpec, pSourceRow))
					{
						return;
					}
					if (tmpConverted.Quarantined || !tmpConverted.Row)
					{
						tmpQuarantined++;
						return;
					}
					tmpRows.set(tmpConverted.Row[pSpec.Identity], tmpConverted.Row);
				});
			return fCallback(null, { Rows: tmpRows, Lossy: tmpLossy, Quarantined: tmpQuarantined, Source: pSourceRows.length });
		});
};

/**
 * Run tasks in order, stop at the first error.
 *
 * @param {Array<(fNext: (pError?: Error) => void) => void>} pTasks
 * @param {(pError?: Error) => void} fCallback
 */
const series = (pTasks, fCallback) =>
{
	let tmpIndex = 0;
	let fNext = (pError) =>
	{
		if (pError || (tmpIndex >= pTasks.length))
		{
			return fCallback(pError || null);
		}
		let tmpTask = pTasks[tmpIndex++];
		return tmpTask(fNext);
	};
	fNext(null);
};

/**
 * The static mirror loader (§66.1) — what C's execution tests and A's own tests use before (or
 * instead of) the materializer: MirrorSpec compile (the harness's own service, so the engine sees the
 * specs) → Store.configure / connect / ensureSchema / createLive → every source row through trusted
 * DAL reads → TypeMap.toStoreRow → Store.writeBatch(…, 'Live') (rows + keymap intents) → a state row
 * (State 'Live', the spec's hash, the Lossy flags).
 *
 * @param {Record<string, any>} pHarness
 * @param {{ Database: string, Entities?: Array<string>, Materialize?: Record<string, any>, StoreOptions?: Record<string, any> }} pOptions
 * @param {(pError?: Error, pResult?: { Database: string, Specs: Record<string, any>, Entities: Record<string, { Rows: number, Quarantined: number, Lossy: Record<string, string> }>, Disabled: Array<any>, Warnings: Array<any> }) => void} fCallback
 */
const loadMirrors = (pHarness, pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	let tmpServices = services(pHarness);
	if (!tmpServices.MirrorSpec || !tmpServices.Store)
	{
		return fCallback(new Error('Facet-ClickHouse-Support.loadMirrors: the harness has no MirrorSpec / StoreClickHouse service.'));
	}
	if (!libDockerClickHouse.DATABASE_NAME_PATTERN.test(String(tmpOptions.Database)))
	{
		return fCallback(new Error('Facet-ClickHouse-Support.loadMirrors: Database must be a freshDatabase() name.'));
	}
	ensure(
		(pEnsureError) =>
		{
			if (pEnsureError)
			{
				return fCallback(pEnsureError);
			}
			let tmpDeclaration = tmpOptions.Materialize || tmpServices.MirrorSpec.declareAll([ 'ClickHouse' ]);
			if (Array.isArray(tmpOptions.Entities))
			{
				let tmpFiltered = {};
				tmpOptions.Entities.forEach(
					(pEntity) =>
					{
						tmpFiltered[pEntity] = Object.prototype.hasOwnProperty.call(tmpDeclaration, pEntity) ? tmpDeclaration[pEntity] : { Store: [ 'ClickHouse' ] };
					});
				tmpDeclaration = tmpFiltered;
			}
			let tmpCompiled = tmpServices.MirrorSpec.compile(tmpDeclaration, { Stores: [ 'ClickHouse' ] });
			let tmpSpecs = tmpCompiled.Specs.ClickHouse || {};
			let tmpStore = tmpServices.Store;
			let tmpConfigured = tmpStore.configure(storeOptions(tmpOptions.Database, tmpOptions.StoreOptions));
			if (!tmpConfigured.Configured || (tmpConfigured.Reason === 'Misconfigured'))
			{
				return fCallback(new Error(`Facet-ClickHouse-Support.loadMirrors: the store did not configure (${tmpConfigured.Reason}).`));
			}
			let tmpResult = { Database: tmpOptions.Database, Specs: tmpSpecs, Entities: {}, Disabled: tmpCompiled.Disabled, Warnings: tmpCompiled.Warnings };
			let tmpVersion = Date.now() * 1000;
			series(
				[
					(fNext) =>
					{
						tmpStore.connect(
							(pError, pConnected) =>
							{
								if (pError || !pConnected || !pConnected.Up)
								{
									return fNext(pError || new Error('Facet-ClickHouse-Support.loadMirrors: ClickHouse is not reachable.'));
								}
								return fNext();
							});
					},
					(fNext) => { tmpStore.ensureSchema(tmpSpecs, (pError) => { return fNext(pError); }); }
				].concat(Object.keys(tmpSpecs).sort().map(
					(pEntity) =>
					{
						return (fNext) =>
						{
							let tmpSpec = tmpSpecs[pEntity];
							tmpStore.createLive(pEntity, tmpSpec,
								(pCreateError) =>
								{
									if (pCreateError)
									{
										return fNext(pCreateError);
									}
									expectedRows(pHarness, tmpSpec,
										(pReadError, pExpected) =>
										{
											if (pReadError)
											{
												return fNext(pReadError);
											}
											tmpVersion++;
											let tmpBatch = { Rows: [], Tombstones: [], KeyIntents: [], KeyRetires: [] };
											pExpected.Rows.forEach(
												(pRow, pID) =>
												{
													tmpBatch.Rows.push(Object.assign({}, pRow, { _Version: tmpVersion }));
													tmpBatch.KeyIntents.push({ ID: pID, Key: libTypeMap.keyOf(tmpSpec, pRow), Tracked: libTypeMap.trackedOf(tmpSpec, pRow), UpdateDate: Object.prototype.hasOwnProperty.call(pRow, 'UpdateDate') ? pRow.UpdateDate : null, Version: tmpVersion });
												});
											tmpStore.writeBatch(pEntity, tmpBatch, `${pEntity}:${tmpVersion}:Live`, 'Live',
												(pWriteError) =>
												{
													if (pWriteError)
													{
														return fNext(pWriteError);
													}
													tmpResult.Entities[pEntity] = { Rows: pExpected.Rows.size, Quarantined: pExpected.Quarantined, Lossy: pExpected.Lossy, Source: pExpected.Source };
													tmpStore.writeState(pEntity, { State: 'Live', Epoch: 1, SpecHash: tmpSpec.SpecHash, LossyColumns: pExpected.Lossy, CleanShutdown: 0, Detail: { Quarantined: pExpected.Quarantined, Loader: 'Static' }, Version: tmpVersion }, (pStateError) => { return fNext(pStateError); });
												});
										});
								});
						};
					})),
				(pError) =>
				{
					return fCallback(pError || null, pError ? undefined : tmpResult);
				});
		});
};

/**
 * Compare two store values (Float64 within the same double; everything else ===).
 *
 * @param {any} pA
 * @param {any} pB
 * @return {boolean}
 */
const sameValue = (pA, pB) =>
{
	if ((pA === null) || (typeof(pA) === 'undefined'))
	{
		return (pB === null) || (typeof(pB) === 'undefined');
	}
	if ((typeof(pA) === 'number') && (typeof(pB) === 'string'))
	{
		return String(pA) === pB;
	}
	if ((typeof(pB) === 'number') && (typeof(pA) === 'string'))
	{
		return String(pB) === pA;
	}
	return pA === pB;
};

/**
 * The O10 invariant (§66.1): the live, non-quarantined source rows converted by TypeMap.toStoreRow
 * equal the mirror's FINAL rows (Store.readLeafRows over the whole range), row for row and column for
 * column (meta columns excluded), and the keymap's live keys equal the mirror's (one key per ID, with
 * the mirror row's tracked values).  A mismatch calls back an Error with .Report = { Missing, Extra,
 * Different, Columns, KeymapMissing, KeymapExtra, KeymapDifferent } — IDs and column names only,
 * never values.  Success calls back (null, { Rows, Quarantined }).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pStoreName - 'ClickHouse'
 * @param {string} pEntity
 * @param {(pError?: Error, pReport?: Record<string, any>) => void} fCallback
 */
const assertMirrorEqualsSource = (pHarness, pStoreName, pEntity, fCallback) =>
{
	let tmpServices = services(pHarness);
	let tmpSpec = tmpServices.MirrorSpec ? tmpServices.MirrorSpec.spec(pStoreName, pEntity) : null;
	let tmpStore = tmpServices.Store;
	if (!tmpSpec || !tmpStore)
	{
		return fCallback(new Error(`Facet-ClickHouse-Support.assertMirrorEqualsSource: no ${pStoreName} spec for ${pEntity}.`));
	}
	expectedRows(pHarness, tmpSpec,
		(pReadError, pExpected) =>
		{
			if (pReadError)
			{
				return fCallback(pReadError);
			}
			tmpStore.readLeafRows(pEntity, null, null, null,
				(pLeafError, pMirrorRows) =>
				{
					if (pLeafError)
					{
						return fCallback(pLeafError);
					}
					tmpStore.readKeyRange(pEntity, null, null, 'Live',
						(pKeyError, pKeys) =>
						{
							if (pKeyError)
							{
								return fCallback(pKeyError);
							}
							let tmpReport = { Missing: [], Extra: [], Different: [], Columns: {}, KeymapMissing: [], KeymapExtra: [], KeymapDifferent: [] };
							let tmpMirror = new Map();
							pMirrorRows.forEach(
								(pRow) =>
								{
									let tmpID = pRow[tmpSpec.Identity];
									if (tmpMirror.has(tmpID))
									{
										// Two live mirror rows of one ID (a moved row whose old key was never tombstoned).
										if (tmpReport.Different.indexOf(tmpID) < 0)
										{
											tmpReport.Different.push(tmpID);
										}
										tmpReport.Columns[tmpID] = [ '#duplicate' ];
										return;
									}
									tmpMirror.set(tmpID, pRow);
								});
							pExpected.Rows.forEach(
								(pRow, pID) =>
								{
									if (!tmpMirror.has(pID))
									{
										tmpReport.Missing.push(pID);
										return;
									}
									let tmpMirrorRow = tmpMirror.get(pID);
									let tmpDiffering = tmpSpec.SourceColumns.filter((pColumn) => { return !sameValue(pRow[pColumn], tmpMirrorRow[pColumn]); });
									if ((tmpDiffering.length > 0) && (tmpReport.Different.indexOf(pID) < 0))
									{
										tmpReport.Different.push(pID);
										tmpReport.Columns[pID] = tmpDiffering;
									}
								});
							tmpMirror.forEach(
								(pRow, pID) =>
								{
									if (!pExpected.Rows.has(pID))
									{
										tmpReport.Extra.push(pID);
									}
								});
							tmpMirror.forEach(
								(pRow, pID) =>
								{
									let tmpEntries = pKeys.get(pID) || [];
									if (tmpEntries.length < 1)
									{
										tmpReport.KeymapMissing.push(pID);
										return;
									}
									let tmpKey = libTypeMap.keyString(tmpSpec, libTypeMap.keyOf(tmpSpec, pRow));
									let tmpTracked = JSON.stringify(libTypeMap.trackedOf(tmpSpec, pRow));
									if ((tmpEntries.length !== 1) || (libTypeMap.keyString(tmpSpec, tmpEntries[0].Key) !== tmpKey)
										|| (JSON.stringify(tmpEntries[0].Tracked) !== tmpTracked)
										|| ((tmpSpec.ColumnNames.indexOf('UpdateDate') >= 0) && !sameValue(tmpEntries[0].UpdateDate, pRow.UpdateDate)))
									{
										tmpReport.KeymapDifferent.push(pID);
									}
								});
							pKeys.forEach(
								(pEntries, pID) =>
								{
									if (!tmpMirror.has(pID))
									{
										tmpReport.KeymapExtra.push(pID);
									}
								});
							let tmpProblems = [ 'Missing', 'Extra', 'Different', 'KeymapMissing', 'KeymapExtra', 'KeymapDifferent' ].filter((pKey) => { return tmpReport[pKey].length > 0; });
							if (tmpProblems.length > 0)
							{
								let tmpError = new Error(`The ${pStoreName} mirror of ${pEntity} differs from the source: ${tmpProblems.map((pKey) => { return `${pKey} ${tmpReport[pKey].length}`; }).join(', ')}.`);
								tmpError.Report = tmpReport;
								return fCallback(tmpError, tmpReport);
							}
							return fCallback(null, { Rows: pExpected.Rows.size, Quarantined: pExpected.Quarantined, Lossy: pExpected.Lossy });
						});
				});
		});
};

module.exports = (
	{
		ACTIVE_DATABASES: ACTIVE_DATABASES,
		available: available,
		ensure: ensure,
		connectionInfo: connectionInfo,
		freshDatabase: freshDatabase,
		storeOptions: storeOptions,
		release: release,
		loadMirrors: loadMirrors,
		assertMirrorEqualsSource: assertMirrorEqualsSource,
		readSourceRows: readSourceRows,
		expectedRows: expectedRows,
		sourceDialect: sourceDialect
	});
