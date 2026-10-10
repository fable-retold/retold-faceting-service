/**
 * Facet-Persistence-Chaos — the O10 subset (internal-contracts §66.2; design 10 §5.1 O10; owner:
 * builder D, port 19145).  ClickHouse-gated (RFS_TEST_CLICKHOUSE=1 / npm run test:ch); with the gate
 * off the whole suite is pending, so plain npm test stays docker-free.
 *
 * Every scenario ends with Materializer.quiesce and assertMirrorEqualsSource for every mirrored
 * entity (the invariant: the mirror's FINAL live rows equal the source's live rows, row for row, and
 * the keymap's live keys equal the mirror's):
 *
 *   duplicate events (the same notify ×5 + its settle)          → one row per ID, flushes ≤ cycles
 *   out-of-order events (Bus Seqs delivered reversed)           → identical
 *   INSERT 5xx 'Before' and 'After' then retry                  → no loss, no duplicated version
 *   ONE flush: update + soft delete + hard delete + tenant move + owner move (LabTrack.LabForm)
 *                                                               → FINAL counts per tenant / owner = source
 *   FK move (Task.IDProject 5 → 9) through CRUD, then back through raw SQL + notify (no before-image)
 *                                                               → K12 / K10 on ClickHouse == Live
 *   raw SQL without notify                                      → Sweep / Scrub / Bisect repair it
 *   a rebuild under ~50 CRUD writes/s for its whole duration    → identical
 *   a crash between flush and ack (afterFlushBeforeAck → crash() → start()) → Unverified (Exact Live,
 *                                                                 Fast store), verify → Live, identical
 *   a volume wipe (dropDatabase under a running materializer)   → Live meanwhile → backfill → identical
 *
 * Harness: the wiring's Store option (internal-contracts §62.6): members store / materializer /
 * quiesce / storeQuery / compareStore; the database rfs_<pid>_<n> is dropped by stop().  Until the
 * wiring exists (no RetoldFacetingService.installStores) the suite wires the store itself the way
 * §54.2 describes (configure → intake subscriptions 'Freshness' then 'Materializer' → start), so every
 * write-side scenario runs on the real Materializer / WriterLoop / store / source; the checks that need
 * the Router (Exact vs Fast admission, ClickHouse == Live answers) run only once the wiring is there.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libDDL = require('../source/store/clickhouse/ClickHouse-DDL.js');

const PORT = 19145;
const STORE = 'ClickHouse';

// The wiring (installStores, the Router, the harness Store option) is present.
const libRetoldFacetingService = require('../source/Retold-Faceting-Service.js');
const WIRED = (typeof(libRetoldFacetingService.prototype.installStores) === 'function');

// What the ProjectTrack harness materializes (Task with a declared watermark: the Sweep needs one).
const PROJECTTRACK_MATERIALIZE = Object.freeze(
	{
		Project: { Store: [ STORE ] },
		Task: { Store: [ STORE ], Watermark: 'UpdateDate' },
		ProjectMembership: { Store: [ STORE ] },
		Issue: { Store: [ STORE ] }
	});

// The K12 (ChildRollup) + K10 (PathSemiJoin scope) body of the FK-move scenario.
const FK_BODY = Object.freeze(
	{
		Scopes: [ { Scope: 'Project.HasMyOverdue' } ],
		Facets: [ { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' }, { Key: 'Status', Facet: 'Project.Status' } ],
		Total: true
	});

/**
 * Wait until a predicate holds (polling every 10 ms, up to pTimeoutMS).
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
		let tmpHolds = false;
		try
		{
			tmpHolds = fPredicate();
		}
		catch (pError)
		{
			tmpHolds = false;
		}
		if (tmpHolds)
		{
			return fCallback();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fCallback(new Error('waitFor: timed out'));
		}
		setTimeout(fCheck, 10);
	};
	fCheck();
};

/**
 * Does Freshness admit a request mode for one entity (internal-contracts §61.3)?
 *
 * @param {Record<string, any>} pKit
 * @param {string} pEntity
 * @param {string} pMode
 * @return {boolean}
 */
const fable_state_admits = (pKit, pEntity, pMode) =>
{
	let tmpDepSet = {};
	tmpDepSet[pEntity] = [];
	return pKit.fable().RetoldFacetingFreshness.admits(STORE, tmpDepSet, { Mode: pMode, MaxLagMS: 5000, MinSeq: null }, Date.now()).Admit;
};

/**
 * Run fStep over every element in sequence.
 *
 * @param {Array<any>} pItems
 * @param {(pItem: any, fNext: (pError?: Error) => void) => void} fStep
 * @param {(pError?: Error|null) => void} fDone
 */
const eachSeries = (pItems, fStep, fDone) =>
{
	let tmpIndex = 0;
	let fNext = (pError) =>
	{
		if (pError)
		{
			return fDone(pError);
		}
		if (tmpIndex >= pItems.length)
		{
			return fDone(null);
		}
		let tmpItem = pItems[tmpIndex];
		tmpIndex++;
		return fStep(tmpItem, fNext);
	};
	fNext();
};

/**
 * The shared helpers of one store-enabled harness.
 *
 * @param {Record<string, any>} pHarness
 * @param {Array<string>} pEntities - the mirrored entities
 * @return {Record<string, any>}
 */
const kit = (pHarness, pEntities) =>
{
	let tmpKit = {};
	tmpKit.H = pHarness;
	tmpKit.fable = () => { return pHarness.faceting.fable; };
	tmpKit.materializer = () => { return pHarness.materializer || pHarness.faceting.fable.RetoldFacetingMaterializer; };
	tmpKit.store = () => { return pHarness.store || pHarness.faceting.fable.RetoldFacetingStoreClickHouse; };
	tmpKit.loop = (pEntity) => { return tmpKit.materializer().loop(STORE, pEntity); };
	tmpKit.state = (pEntity) => { return tmpKit.fable().RetoldFacetingFreshness.state(STORE, pEntity).State; };
	tmpKit.raw = (pSQL, pParams) => { return pHarness.db.prepare(pSQL).run(...(pParams || [])); };
	tmpKit.get = (pSQL, pParams) => { return pHarness.db.prepare(pSQL).get(...(pParams || [])); };
	tmpKit.all = (pSQL, pParams) => { return pHarness.db.prepare(pSQL).all(...(pParams || [])); };
	tmpKit.notify = (pEntity, pChange) => { return pHarness.faceting.notify(pEntity, pChange); };
	tmpKit.quiesce = (fCallback) =>
	{
		if (typeof(pHarness.quiesce) === 'function')
		{
			return pHarness.quiesce(fCallback);
		}
		return tmpKit.materializer().quiesce(STORE, null, 30000, fCallback);
	};
	/**
	 * quiesce, then the O10 invariant for every mirrored entity.
	 */
	tmpKit.assertAll = (fCallback) =>
	{
		tmpKit.quiesce(
			(pQuiesceError) =>
			{
				if (pQuiesceError)
				{
					return fCallback(pQuiesceError);
				}
				eachSeries(pEntities,
					(pEntity, fNext) =>
					{
						libSupport.assertMirrorEqualsSource(pHarness, STORE, pEntity,
							(pError) =>
							{
								if (pError)
								{
									pError.message = `${pEntity}: ${pError.message} ${JSON.stringify(pError.Report || {})}`;
								}
								return fNext(pError || null);
							});
					}, fCallback);
			});
	};
	/**
	 * A read of the store (FINAL counts, raw version counts).
	 */
	tmpKit.storeRows = (pSQL, pParams, fCallback) =>
	{
		tmpKit.store().queryRows(pSQL, pParams || {}, null, null, fCallback);
	};
	tmpKit.table = (pTable) => { return libDDL.qualified(tmpKit.store().Database, pTable); };
	return tmpKit;
};

/**
 * Start a store-enabled harness.
 *
 * @param {string} pFixture
 * @param {Record<string, any>} pMaterialize
 * @param {Record<string, any>} pFaceting
 * @param {Function} fCallback - (pError, pHarness)
 */
const startHarness = (pFixture, pMaterialize, pFaceting, fCallback) =>
{
	const libHarness = require('./support/Facet-Test-Harness.js');
	if (WIRED)
	{
		let tmpHarness = libHarness.start(
			{
				Port: PORT, Fixture: pFixture, Store: STORE,
				StoreOptions: { Materialize: pMaterialize, Reconcile: { AutoStart: false } },
				Faceting: pFaceting
			},
			(pError) => { return fCallback(pError || null, tmpHarness); });
		return;
	}
	// Before the wiring: the store section and the declaration go into the service options, and the
	// store is wired here as internal-contracts §54.2 describes.
	let tmpDatabase = libSupport.freshDatabase();
	let tmpFaceting = Object.assign({}, pFaceting, { Stores: { ClickHouse: libSupport.storeOptions(tmpDatabase, { RetryConnectMS: 500 }) }, Materialize: pMaterialize });
	let tmpHarness = libHarness.start({ Port: PORT, Fixture: pFixture, Faceting: tmpFaceting },
		(pError) =>
		{
			if (pError)
			{
				return fCallback(pError, tmpHarness);
			}
			let tmpFable = tmpHarness.faceting.fable;
			let tmpStop = tmpHarness.stop;
			tmpHarness.stop = (fStopDone) =>
			{
				tmpFable.RetoldFacetingMaterializer.stop(
					() =>
					{
						tmpStop(() => { libSupport.release(tmpDatabase, () => { return fStopDone(); }); });
					});
			};
			let tmpConfigured = tmpFable.RetoldFacetingStoreClickHouse.configure(tmpHarness.faceting.options.Stores.ClickHouse);
			if (!tmpConfigured.Configured)
			{
				return fCallback(new Error(`the store did not configure (${tmpConfigured.Reason})`), tmpHarness);
			}
			let tmpIntake = tmpFable.RetoldFacetingChangeIntake;
			tmpIntake.subscribe('Freshness', (pEvent) => { tmpFable.RetoldFacetingFreshness.observe(pEvent); });
			tmpIntake.subscribe('Materializer', (pEvent) => { tmpFable.RetoldFacetingMaterializer.onChange(pEvent); });
			tmpFable.RetoldFacetingMaterializer.start(
				() =>
				{
					tmpFable.RetoldFacetingMaterializer.quiesce(STORE, null, 60000, (pQuiesceError) => { return fCallback(pQuiesceError || null, tmpHarness); });
				});
		});
};

const FACETING = Object.freeze(
	{
		Materializer: { FlushIntervalMS: 100, IdleTickMS: 10, RebuildPageSize: 40, BatchIDs: 500 },
		Reconcile: { AutoStart: false, LeafRange: 100, SweepCap: 50, MaxTxnMS: 5000 },
		ChangeCapture: { NotifySettleMS: 150 },
		// The admission checks (Exact vs Fast on an Unverified / rebuilt entity) query as Lead, who writes
		// in the scenarios before them: read-your-writes would (correctly) upgrade Lead's Fast reads to
		// Exact for ReadYourWritesMS, so it is off here (Facet-Store-Routing tests the upgrade itself).
		Freshness: { ReadYourWritesMS: 0 }
	});

suite
(
	'Facet-Persistence-Chaos',
	function ()
	{
		let tmpAvailable = libSupport.available();
		if (!tmpAvailable.Available)
		{
			test.skip(`O10 (ClickHouse-gated: ${tmpAvailable.Reason})`, () => {});
			return;
		}
		this.timeout(180000);

		let P = null;
		let L = null;
		let tmpLead = null;
		let tmpNow = null;

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
						startHarness('ProjectTrack', PROJECTTRACK_MATERIALIZE, FACETING,
							(pStartError, pHarness) =>
							{
								if (pStartError)
								{
									return fDone(pStartError);
								}
								P = kit(pHarness, Object.keys(PROJECTTRACK_MATERIALIZE));
								tmpLead = pHarness.as('Lead');
								tmpNow = pHarness.traps.TestNow;
								startHarness('LabTrack', { LabForm: { Store: [ STORE ] } }, FACETING,
									(pLabError, pLabHarness) =>
									{
										if (pLabError)
										{
											return fDone(pLabError);
										}
										L = kit(pLabHarness, [ 'LabForm' ]);
										return fDone();
									});
							});
					});
			});

		suiteTeardown(
			(fDone) =>
			{
				let tmpHarnesses = [ P, L ].filter((pKit) => { return !!pKit; });
				eachSeries(tmpHarnesses, (pKit, fNext) => { pKit.H.stop(() => { fNext(); }); }, () => { fDone(); });
			});

		test('boot: every declared entity was backfilled, is Live, and its mirror equals the source',
			(fDone) =>
			{
				Object.keys(PROJECTTRACK_MATERIALIZE).forEach((pEntity) => { Expect(P.state(pEntity), pEntity).to.equal('Live'); });
				Expect(L.state('LabForm')).to.equal('Live');
				P.assertAll((pError) => { if (pError) { return fDone(pError); } L.assertAll(fDone); });
			});

		test('duplicate events: the same notify ×5 and its settle re-delivery → one row per ID, never more flushes than cycles',
			(fDone) =>
			{
				P.quiesce(
					() =>
					{
						let tmpLoop = P.loop('Task');
						let tmpBefore = tmpLoop.stats();
						let tmpID = P.get('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 1').IDTask;
						P.raw("UPDATE Task SET Status = 'dup' WHERE IDTask = ?", [ tmpID ]);
						for (let i = 0; i < 5; i++)
						{
							P.notify('Task', { IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: [ 'Status' ] });
						}
						// Past the settle window: the settle re-delivery is a harmless re-hint.
						setTimeout(
							() =>
							{
								P.quiesce(
									(pError) =>
									{
										Expect(pError || null).to.equal(null);
										let tmpAfter = tmpLoop.stats();
										let tmpCycles = tmpAfter.Cycles - tmpBefore.Cycles;
										let tmpFlushes = tmpAfter.Flushes - tmpBefore.Flushes;
										Expect(tmpCycles).to.be.within(1, 3);
										Expect(tmpFlushes).to.be.at.most(tmpCycles);
										P.storeRows(`SELECT count() AS N FROM ${P.table('Task')} FINAL WHERE \`_IsDeleted\` = 0 AND \`IDTask\` = {id:Int64}`, { id: tmpID },
											(pCountError, pRows) =>
											{
												Expect(pCountError || null).to.equal(null);
												Expect(Number(pRows[0].N)).to.equal(1);
												P.assertAll(fDone);
											});
									});
							}, 400);
					});
			});

		test('out-of-order events: Bus Seqs delivered in reverse order converge to the source',
			(fDone) =>
			{
				let tmpIntake = P.fable().RetoldFacetingChangeIntake;
				let tmpIDs = P.all('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 5 OFFSET 10').map((pRow) => { return pRow.IDTask; });
				// Several committed states per row; the hints arrive newest-first.
				for (let tmpRound = 1; tmpRound <= 3; tmpRound++)
				{
					tmpIDs.forEach((pID) => { P.raw('UPDATE Task SET Status = ? WHERE IDTask = ?', [ `r${tmpRound}`, pID ]); });
				}
				P.raw("UPDATE Task SET Status = 'last' WHERE IDTask = ?", [ tmpIDs[0] ]);
				for (let tmpSeq = 15; tmpSeq >= 1; tmpSeq--)
				{
					let tmpEvent = tmpIntake.ingest({ Source: 'Bus', Seq: `e:0badf00d:${tmpSeq}`, Entity: 'Task', Operation: 'Update', IDs: [ tmpIDs[tmpSeq % tmpIDs.length] ], Tenants: [ 1 ] });
					Expect(tmpEvent, `ingest #${tmpSeq}`).to.not.equal(null);
				}
				P.assertAll(fDone);
			});

		test('an INSERT that fails with a 5xx (before it lands, and after it landed) is retried under its token: no loss, no duplicated version',
			(fDone) =>
			{
				let tmpClient = P.store().Client;
				let tmpIDs = P.all('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 2 OFFSET 20').map((pRow) => { return pRow.IDTask; });
				let tmpInjected = [];
				let fInjectOnce = (pWhen) =>
				{
					let tmpDone = false;
					tmpClient.setFaultInjector(
						(pRequest) =>
						{
							if (!tmpDone && (pRequest.Kind === 'Insert') && (String(pRequest.Table || '').indexOf('`Task`') >= 0) && (pRequest.Attempt === 1))
							{
								tmpDone = true;
								tmpInjected.push(pWhen);
								return { Status: 500, Text: `injected (${pWhen})`, When: pWhen };
							}
							return null;
						});
				};
				let fOne = (pWhen, pID, fNext) =>
				{
					P.quiesce(
						() =>
						{
							fInjectOnce(pWhen);
							P.raw('UPDATE Task SET Status = ? WHERE IDTask = ?', [ `fault-${pWhen}`, pID ]);
							P.notify('Task', { IDs: [ pID ], Tenants: [ 1 ] });
							P.quiesce(
								(pError) =>
								{
									tmpClient.setFaultInjector(null);
									if (pError)
									{
										return fNext(pError);
									}
									P.storeRows(`SELECT \`_Version\` AS V, count() AS N FROM ${P.table('Task')} WHERE \`IDTask\` = {id:Int64} GROUP BY V HAVING N > 1`, { id: pID },
										(pDupError, pDuplicates) =>
										{
											if (pDupError)
											{
												return fNext(pDupError);
											}
											Expect(pDuplicates, `no duplicated version of ${pID} (${pWhen})`).to.deep.equal([]);
											return fNext();
										});
								});
						});
				};
				fOne('Before', tmpIDs[0],
					(pError) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						fOne('After', tmpIDs[1],
							(pAfterError) =>
							{
								if (pAfterError)
								{
									return fDone(pAfterError);
								}
								Expect(tmpInjected).to.deep.equal([ 'Before', 'After' ]);
								P.assertAll(fDone);
							});
					});
			});

		test('ONE flush carrying an update, a soft delete, a hard delete, a tenant move and an owner move: FINAL counts per tenant and per owner equal the source',
			(fDone) =>
			{
				L.quiesce(
					() =>
					{
						let tmpRows = L.all('SELECT IDLabForm, OwnerIDUser FROM LabForm WHERE IDCustomer = 1 AND Deleted = 0 AND OwnerIDUser IS NOT NULL ORDER BY IDLabForm LIMIT 5');
						Expect(tmpRows.length).to.equal(5);
						let tmpOtherOwner = L.get('SELECT OwnerIDUser FROM LabForm WHERE IDCustomer = 1 AND OwnerIDUser IS NOT NULL AND OwnerIDUser <> ? LIMIT 1', [ tmpRows[4].OwnerIDUser ]).OwnerIDUser;
						let tmpIDs = tmpRows.map((pRow) => { return pRow.IDLabForm; });
						L.raw("UPDATE LabForm SET Status = 'chaos-updated' WHERE IDLabForm = ?", [ tmpIDs[0] ]);
						L.raw('UPDATE LabForm SET Deleted = 1 WHERE IDLabForm = ?', [ tmpIDs[1] ]);
						L.raw('DELETE FROM LabForm WHERE IDLabForm = ?', [ tmpIDs[2] ]);
						L.raw('UPDATE LabForm SET IDCustomer = 2 WHERE IDLabForm = ?', [ tmpIDs[3] ]);
						L.raw('UPDATE LabForm SET OwnerIDUser = ? WHERE IDLabForm = ?', [ tmpOtherOwner, tmpIDs[4] ]);
						let tmpLoop = L.loop('LabForm');
						let tmpFlushes = [];
						tmpLoop.setTestHook('afterFlushBeforeAck', (pInfo) => { tmpFlushes.push(pInfo); });
						L.notify('LabForm', { IDs: tmpIDs, Tenants: [ 1, 2 ] });
						L.quiesce(
							(pError) =>
							{
								tmpLoop.setTestHook('afterFlushBeforeAck', null);
								Expect(pError || null).to.equal(null);
								// The first flush after the notify carried all five changes: 3 rows (update,
								// new tenant key, new owner key) and 4 tombstones (soft, hard, old tenant key,
								// old owner key).
								let fCount = (pValue) => { return Array.isArray(pValue) ? pValue.length : Number(pValue); };
								Expect(tmpFlushes.length).to.be.at.least(1);
								Expect(fCount(tmpFlushes[0].Rows), 'rows of the one flush').to.equal(3);
								Expect(fCount(tmpFlushes[0].Tombstones), 'tombstones of the one flush').to.equal(4);
								let tmpSourceTenants = {};
								L.all("SELECT IDCustomer AS T, COUNT(*) AS N FROM LabForm WHERE Deleted = 0 AND IDCustomer IS NOT NULL AND IDCustomer <> 0 GROUP BY IDCustomer")
									.forEach((pRow) => { tmpSourceTenants[String(pRow.T)] = pRow.N; });
								let tmpSourceOwners = {};
								L.all("SELECT IDCustomer AS T, OwnerIDUser AS O, COUNT(*) AS N FROM LabForm WHERE Deleted = 0 AND IDCustomer IS NOT NULL AND IDCustomer <> 0 GROUP BY IDCustomer, OwnerIDUser")
									.forEach((pRow) => { tmpSourceOwners[`${pRow.T}/${pRow.O}`] = pRow.N; });
								L.storeRows(`SELECT \`IDCustomer\` AS T, count() AS N FROM ${L.table('LabForm')} FINAL WHERE \`_IsDeleted\` = 0 GROUP BY T`, {},
									(pTenantError, pTenants) =>
									{
										Expect(pTenantError || null).to.equal(null);
										let tmpStoreTenants = {};
										pTenants.forEach((pRow) => { tmpStoreTenants[String(pRow.T)] = Number(pRow.N); });
										Expect(tmpStoreTenants).to.deep.equal(tmpSourceTenants);
										L.storeRows(`SELECT \`IDCustomer\` AS T, \`OwnerIDUser\` AS O, count() AS N FROM ${L.table('LabForm')} FINAL WHERE \`_IsDeleted\` = 0 GROUP BY T, O`, {},
											(pOwnerError, pOwners) =>
											{
												Expect(pOwnerError || null).to.equal(null);
												let tmpStoreOwners = {};
												pOwners.forEach((pRow) => { tmpStoreOwners[`${pRow.T}/${pRow.O}`] = Number(pRow.N); });
												Expect(tmpStoreOwners).to.deep.equal(tmpSourceOwners);
												L.assertAll(fDone);
											});
									});
							});
					});
			});

		test('an FK move (Task.IDProject 5 → 9) through CRUD, and back through raw SQL + notify with no before-image: K12 / K10 on ClickHouse equal Live',
			(fDone) =>
			{
				let tmpTask = P.get("SELECT IDTask FROM Task WHERE IDProject = 5 AND AssignedIDUser = ? AND Deleted = 0 AND DueDate < ? AND Status IN ('Open', 'InProgress') ORDER BY IDTask LIMIT 1", [ tmpLead.User, tmpNow ]);
				Expect(tmpTask, 'an overdue open task of Lead on project 5').to.not.equal(undefined);
				let tmpOptions = Object.assign({ Now: tmpNow }, tmpLead);
				let fCompare = (pWhy, fNext) =>
				{
					P.quiesce(
						(pQuiesceError) =>
						{
							if (pQuiesceError)
							{
								return fNext(pQuiesceError);
							}
							if (!WIRED)
							{
								// Before the wiring there is no engine to ask: the store half — the moved row
								// sits under its new parent in the mirror, nothing stale under the old one.
								return libSupport.assertMirrorEqualsSource(P.H, STORE, 'Task',
									(pMirrorError) =>
									{
										if (pMirrorError)
										{
											return fNext(pMirrorError);
										}
										P.storeRows(`SELECT \`IDProject\` AS P FROM ${P.table('Task')} FINAL WHERE \`_IsDeleted\` = 0 AND \`IDTask\` = {id:Int64}`, { id: tmpTask.IDTask },
											(pReadError, pRows) =>
											{
												if (pReadError)
												{
													return fNext(pReadError);
												}
												let tmpSource = P.get('SELECT IDProject FROM Task WHERE IDTask = ?', [ tmpTask.IDTask ]).IDProject;
												Expect(pRows.length, `${pWhy}: one live mirror row`).to.equal(1);
												Expect(Number(pRows[0].P), `${pWhy}: the mirror row's parent`).to.equal(tmpSource);
												return fNext(null, { LiveNormalized: { Project: tmpSource } });
											});
									});
							}
							P.H.compareStore('Project', FK_BODY, tmpOptions,
								(pError, pResult) =>
								{
									if (pError)
									{
										return fNext(pError);
									}
									Expect(pResult.StoreNormalized, `${pWhy}: ClickHouse == Live`).to.deep.equal(pResult.LiveNormalized);
									Expect(pResult.LiveNormalized, `${pWhy}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
									let tmpStoreBlock = (pResult.Store && pResult.Store.Store) ? pResult.Store.Store.Facets : {};
									let tmpEngine = (pResult.Engines && pResult.Engines.MyOverdue) || (tmpStoreBlock.MyOverdue && tmpStoreBlock.MyOverdue.Engine);
									Expect(tmpEngine, `${pWhy}: K12 answered by the store`).to.equal('ClickHouse');
									return fNext(null, pResult);
								});
						});
				};
				fCompare('before',
					(pError, pBefore) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						P.H.request('PUT', '/1.0/Task', { IDTask: tmpTask.IDTask, IDProject: 9 }, tmpLead,
							(pPutError, pResponse) =>
							{
								Expect(pPutError || null).to.equal(null);
								Expect(pResponse.Status).to.equal(200);
								fCompare('after the CRUD move',
									(pMovedError, pMoved) =>
									{
										if (pMovedError)
										{
											return fDone(pMovedError);
										}
										Expect(pMoved.LiveNormalized, 'the move changed the answer').to.not.deep.equal(pBefore.LiveNormalized);
										// Back through raw SQL: no before-image, the keymap is the before-image of record.
										P.raw('UPDATE Task SET IDProject = 5 WHERE IDTask = ?', [ tmpTask.IDTask ]);
										P.notify('Task', { IDs: [ tmpTask.IDTask ], Tenants: [ 1 ] });
										fCompare('after the raw move back',
											(pBackError, pBack) =>
											{
												if (pBackError)
												{
													return fDone(pBackError);
												}
												Expect(pBack.LiveNormalized).to.deep.equal(pBefore.LiveNormalized);
												P.assertAll(fDone);
											});
									});
							});
					});
			});

		test('raw SQL without notify: a stamped update is repaired by the Sweep, an unstamped in-place update by the Scrub, a raw insert and a raw hard delete by Bisect',
			(fDone) =>
			{
				let tmpReconciler = P.fable().RetoldFacetingReconciler;
				P.quiesce(
					() =>
					{
						let tmpIDs = P.all('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 3 OFFSET 40').map((pRow) => { return pRow.IDTask; });
						P.raw("UPDATE Task SET Status = 'swept', UpdateDate = datetime('now') WHERE IDTask = ?", [ tmpIDs[0] ]);
						tmpReconciler.sweep(STORE, 'Task', {},
							(pSweepError, pSweep) =>
							{
								Expect(pSweepError || null).to.equal(null);
								Expect(pSweep.Enqueued).to.be.at.least(1);
								P.quiesce(
									() =>
									{
										P.storeRows(`SELECT \`Status\` AS S FROM ${P.table('Task')} FINAL WHERE \`_IsDeleted\` = 0 AND \`IDTask\` = {id:Int64}`, { id: tmpIDs[0] },
											(pReadError, pRows) =>
											{
												Expect(pReadError || null).to.equal(null);
												Expect(pRows[0].S, 'the Sweep repaired the stamped update').to.equal('swept');
												// Unstamped, in place: invisible to the Sweep and to Bisect.
												P.raw("UPDATE Task SET Status = 'scrubbed' WHERE IDTask = ?", [ tmpIDs[1] ]);
												tmpReconciler.scrub(STORE, 'Task', { Full: true },
													(pScrubError, pScrub) =>
													{
														Expect(pScrubError || null).to.equal(null);
														Expect(pScrub.Wrapped).to.equal(true);
														let tmpMax = P.get('SELECT MAX(IDTask) AS M FROM Task').M;
														let tmpTemplate = P.get('SELECT * FROM Task WHERE IDTask = ?', [ tmpIDs[2] ]);
														tmpTemplate.IDTask = tmpMax + 1;
														tmpTemplate.GUIDTask = `chaos-${tmpMax + 1}`;
														let tmpColumns = Object.keys(tmpTemplate);
														P.raw(`INSERT INTO Task (${tmpColumns.join(', ')}) VALUES (${tmpColumns.map(() => { return '?'; }).join(', ')})`, tmpColumns.map((pColumn) => { return tmpTemplate[pColumn]; }));
														P.raw('DELETE FROM Task WHERE IDTask = ?', [ tmpIDs[2] ]);
														tmpReconciler.bisect(STORE, 'Task', { Escalate: false },
															(pBisectError, pBisect) =>
															{
																Expect(pBisectError || null).to.equal(null);
																Expect(pBisect.Enqueued).to.equal(2);
																P.assertAll(fDone);
															});
													});
											});
									});
							});
					});
			});

		test('a rebuild under a write stream (~50 CRUD writes/s for its whole duration) ends identical to the source',
			(fDone) =>
			{
				let tmpRebuilder = P.fable().RetoldFacetingRebuilder;
				let tmpIDs = P.all('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 40 OFFSET 60').map((pRow) => { return pRow.IDTask; });
				let tmpWrites = 0;
				let tmpInFlight = 0;
				let tmpErrors = [];
				let tmpStopped = false;
				let tmpTimer = setInterval(
					() =>
					{
						if (tmpStopped)
						{
							return;
						}
						tmpWrites++;
						tmpInFlight++;
						let tmpID = tmpIDs[tmpWrites % tmpIDs.length];
						let tmpBody = (tmpWrites % 7 === 0) ? { IDTask: tmpID, IDProject: (tmpWrites % 2) ? 5 : 9 } : { IDTask: tmpID, Status: `stream-${tmpWrites}` };
						P.H.request('PUT', '/1.0/Task', tmpBody, tmpLead,
							(pError, pResponse) =>
							{
								tmpInFlight--;
								if (pError || (pResponse.Status !== 200))
								{
									tmpErrors.push(pError ? pError.message : pResponse.Status);
								}
							});
					}, 20);
				let tmpStatesSeen = new Set();
				let tmpWatch = setInterval(() => { tmpStatesSeen.add(P.state('Task')); }, 5);
				// Let the stream run before the rebuild starts too.
				setTimeout(
					() =>
					{
						let tmpWritesAtStart = tmpWrites;
						tmpRebuilder.rebuild(STORE, 'Task', { Reason: 'Admin' },
							(pError, pResult) =>
							{
								let tmpWritesDuring = tmpWrites - tmpWritesAtStart;
								tmpStopped = true;
								clearInterval(tmpTimer);
								clearInterval(tmpWatch);
								Expect(pError || null).to.equal(null);
								Expect(pResult.State).to.equal('Live');
								Expect(pResult.Pages).to.be.at.least(2);
								Expect(tmpWritesDuring, 'writes landed during the rebuild').to.be.at.least(3);
								Expect(tmpStatesSeen.has('Rebuilding')).to.equal(true);
								waitFor(() => { return tmpInFlight === 0; }, 10000,
									() =>
									{
										Expect(tmpErrors).to.deep.equal([]);
										P.assertAll(fDone);
									});
							});
					}, 200);
			});

		test('a crash between flush and ack: the next start is Unverified (Exact answers Live, Fast may use the store), verify → Live, identical',
			(fDone) =>
			{
				let tmpMaterializer = P.materializer();
				let tmpReconciler = P.fable().RetoldFacetingReconciler;
				let tmpIDs = P.all('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 2 OFFSET 80').map((pRow) => { return pRow.IDTask; });
				P.quiesce(
					() =>
					{
						let tmpCrashed = false;
						let tmpLoop = P.loop('Task');
						tmpLoop.setTestHook('afterFlushBeforeAck',
							(pInfo, fNext) =>
							{
								// kill -9 between the landed inserts and the ack: never continue this cycle.
								tmpCrashed = true;
								tmpMaterializer.crash();
							});
						// Hold the verify a restart runs, so the Unverified window can be observed.
						let fVerify = tmpReconciler.verify;
						let tmpHeld = [];
						tmpReconciler.verify = (pStore, pEntity, pOptions, fCallback) =>
						{
							tmpHeld.push([ pStore, pEntity, (typeof(pOptions) === 'function') ? pOptions : fCallback ]);
						};
						P.raw("UPDATE Task SET Status = 'before-crash' WHERE IDTask = ?", [ tmpIDs[0] ]);
						P.notify('Task', { IDs: [ tmpIDs[0] ], Tenants: [ 1 ] });
						waitFor(() => { return tmpCrashed; }, 10000,
							(pWaitError) =>
							{
								Expect(pWaitError || null).to.equal(null);
								// A hint that dies with the process.
								P.raw("UPDATE Task SET Status = 'lost-hint' WHERE IDTask = ?", [ tmpIDs[1] ]);
								P.notify('Task', { IDs: [ tmpIDs[1] ], Tenants: [ 1 ] });
								// A restart on the same database (start may wait for the held verifies: do not wait for it).
								let tmpStarted = null;
								tmpMaterializer.start((pStartError) => { tmpStarted = pStartError || false; });
								waitFor(() => { return (tmpStarted !== null) || (P.state('Task') === 'Unverified'); }, 10000,
									() =>
									{
										Expect(tmpStarted || null, 'start never fails').to.equal(null);
										waitFor(() => { return P.state('Task') === 'Unverified'; }, 10000,
											(pStateError) =>
											{
												Expect(pStateError || null, 'the unclean boot is Unverified').to.equal(null);
												let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Total: true };
												let fQuery = (pQueryBody, pOptions, fQueried) =>
												{
													if (!WIRED)
													{
														// No Router before the wiring: the admission checks are the wiring's to run.
														return fQueried(null, { Store: { Facets: { Status: { Engine: (pQueryBody.Freshness.Mode === 'Exact') ? 'Live' : 'ClickHouse' } } } });
													}
													return P.H.query('Task', pQueryBody, pOptions, fQueried);
												};
												Expect(fable_state_admits(P, 'Task', 'Exact'), 'Freshness refuses Exact for an Unverified entity').to.equal(false);
												Expect(fable_state_admits(P, 'Task', 'Fast'), 'Freshness admits Fast for an Unverified entity').to.equal(true);
												Expect(fable_state_admits(P, 'Task', 'Bounded'), 'Freshness admits Bounded within MaxLagMS for an Unverified entity').to.equal(true);
												fQuery(Object.assign({ Freshness: { Mode: 'Exact' } }, tmpBody), tmpLead,
													(pExactError, pExact) =>
													{
														Expect(pExactError || null).to.equal(null);
														Expect(pExact.Store.Facets.Status.Engine, 'Exact never uses an Unverified store').to.equal('Live');
														fQuery(Object.assign({ Freshness: { Mode: 'Fast' } }, tmpBody), tmpLead,
															(pFastError, pFast) =>
															{
																Expect(pFastError || null).to.equal(null);
																Expect(pFast.Store.Facets.Status.Engine, 'Fast may use an Unverified store').to.equal('ClickHouse');
																tmpReconciler.verify = fVerify;
																Expect(tmpHeld.length).to.be.at.least(1);
																eachSeries(tmpHeld,
																	(pCall, fNext) =>
																	{
																		tmpReconciler.verify(pCall[0], pCall[1],
																			(pVerifyError, pVerified) =>
																			{
																				if (typeof(pCall[2]) === 'function')
																				{
																					pCall[2](pVerifyError, pVerified);
																				}
																				return fNext(pVerifyError || null);
																			});
																	},
																	(pVerifyError) =>
																	{
																		Expect(pVerifyError || null).to.equal(null);
																		waitFor(() => { return tmpStarted !== null; }, 10000,
																			() =>
																			{
																				Expect(tmpStarted || null).to.equal(null);
																				// The other entities' verifies were queued behind the held ones
																				// (Materializer.MaxConcurrentBuilds): they finish on their own.
																				waitFor(() => { return Object.keys(PROJECTTRACK_MATERIALIZE).every((pEntity) => { return P.state(pEntity) === 'Live'; }); }, 30000,
																					() =>
																					{
																						Object.keys(PROJECTTRACK_MATERIALIZE).forEach((pEntity) => { Expect(P.state(pEntity), pEntity).to.equal('Live'); });
																						P.assertAll(fDone);
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

		test('a volume wipe under a running materializer: Live answers meanwhile, then a backfill ends identical',
			(fDone) =>
			{
				let tmpID = P.get('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 1 OFFSET 90').IDTask;
				P.quiesce(
					() =>
					{
						P.store().dropDatabase(
							(pDropError) =>
							{
								Expect(pDropError || null).to.equal(null);
								let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Total: true, Freshness: { Mode: 'Fast' } };
								// The next write's flush meets UNKNOWN_DATABASE → recoverWipe → backfill.
								P.raw("UPDATE Task SET Status = 'after-wipe' WHERE IDTask = ?", [ tmpID ]);
								P.notify('Task', { IDs: [ tmpID ], Tenants: [ 1 ] });
								let fQuery = (fQueried) =>
								{
									if (!WIRED)
									{
										return fQueried(null, { Store: { Facets: { Status: { Engine: 'Live' } } } });
									}
									return P.H.query('Task', tmpBody, tmpLead, fQueried);
								};
								fQuery(
									(pQueryError, pEnvelope) =>
									{
										Expect(pQueryError || null).to.equal(null);
										Expect(pEnvelope.Store.Facets.Status.Engine, 'Live answers while the store is gone').to.equal('Live');
										waitFor(() => { return Object.keys(PROJECTTRACK_MATERIALIZE).every((pEntity) => { return P.state(pEntity) === 'Live'; }); }, 60000,
											(pWaitError) =>
											{
												Expect(pWaitError || null, 'every entity rebuilt and Live').to.equal(null);
												P.assertAll(
													(pError) =>
													{
														if (pError)
														{
															return fDone(pError);
														}
														if (!WIRED)
														{
															return fDone();
														}
														P.H.query('Task', tmpBody, tmpLead,
															(pAfterError, pAfter) =>
															{
																Expect(pAfterError || null).to.equal(null);
																Expect(pAfter.Store.Facets.Status.Engine, 'the store answers again').to.equal('ClickHouse');
																fDone();
															});
													});
											});
									});
							});
					});
			});
	}
);
