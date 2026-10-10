/**
 * Facet-Store-Routing (internal-contracts §66.2, owner: wiring, port 19147) — the Router and the envelope
 * with a ClickHouse store registered (§62), through the real pipeline and the real materializer:
 *
 *   Freshness Exact (the default)   the store only when every DepSet entity is caught up; a write that is
 *                                   observed but not flushed → Live ('NotExact:<E>'), and that Live answer
 *                                   is the current one (Exact never stale); after the flush → the store
 *   Bounded                         within MaxLagMS → the store (Exact false, LagMS); beyond → Live 'Lagging'
 *   Fast                            the store while Unverified / CatchingUp (Exact refuses both)
 *   Engine: 'Live'                  every facet Live, Reason 'Requested'
 *   read-your-writes                the writer's next Fast read is upgraded to Exact (Live while its write is
 *                                   unflushed); another principal's Fast read uses the store
 *   a store error                   the same request answers Live with FACET_STORE_FALLBACK (Fallback
 *                                   'Error' / 'Timeout'); five failures open the breaker ('Breaker:<E>', no
 *                                   statement sent), half-open after BreakerOpenMS, a success closes it
 *   per-facet engines               a store facet next to a non-mirrored one in one envelope
 *   the Store block                 only with a store; ExposeReasons off → reason classes only
 *   the cache                       store answers never stored (Bypass 'Store', digest Version); Live answers
 *                                   cache as in M4
 *   Records / Count / Keys          never touch the store
 *   feature-not-boot                a dead ClickHouse URL boots and answers Live (Describe Available false),
 *                                   then the store is used once it comes up (RetryConnectMS); a misconfigured
 *                                   section boots too
 *
 * ClickHouse-gated (RFS_TEST_CLICKHOUSE=1 / npm run test:ch).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libNet = require('net');

const libHarness = require('./support/Facet-Test-Harness.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');

const PORT = 19147;
const STORE = 'ClickHouse';

const CH_GATE = libSupport.available();

// ProjectTrack without Issue (so Project.HasOpenIssues stays Live: NotMirrored:Issue).
const MATERIALIZE = Object.freeze(
	{
		Customer: { Store: [ STORE ] }, User: { Store: [ STORE ] }, Client: { Store: [ STORE ] }, Project: { Store: [ STORE ] },
		ProjectMembership: { Store: [ STORE ] }, Task: { Store: [ STORE ] }, FormType: { Store: [ STORE ] }, Document: { Store: [ STORE ] }
	});

// Flushes are held (FlushIntervalMS) so a write stays observed-but-unapplied until quiesce flushes it.
const FACETING = Object.freeze(
	{
		Materializer: { FlushIntervalMS: 600000, IdleTickMS: 10, RebuildPageSize: 100 },
		ChangeCapture: { NotifySettleMS: 40 },
		Freshness: { BreakerFailures: 5, BreakerWindowMS: 30000, BreakerOpenMS: 300 }
	});

const TASK_BODY = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Total: true });

/**
 * Wait until a predicate holds (polling every 20 ms, up to pTimeoutMS).
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
		setTimeout(fCheck, 20);
	};
	fCheck();
};

/**
 * The counts of a facet's buckets.
 *
 * @param {Record<string, any>} pFacet
 * @return {Record<string, number>}
 */
const countsOf = (pFacet) =>
{
	let tmpCounts = {};
	pFacet.Buckets.forEach((pBucket) => { tmpCounts[String(pBucket.Key)] = pBucket.Count; });
	return tmpCounts;
};

/**
 * Run fStep over every item in sequence.
 *
 * @param {Array<any>} pItems
 * @param {(pItem: any, fNext: (pError?: Error|null) => void) => void} fStep
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
		return fStep(tmpItem, (pStepError) => { setImmediate(() => { fNext(pStepError || null); }); });
	};
	fNext(null);
};

suite
(
	'Facet-Store-Routing',
	function ()
	{
		if (!CH_GATE.Available)
		{
			test.skip(`Router + envelope with a store (ClickHouse-gated: ${CH_GATE.Reason})`, () => {});
			return;
		}
		this.timeout(120000);

		suiteSetup((fDone) => { libSupport.ensure((pError) => { return fDone(pError || undefined); }); });

		// ------------------------------------------------------------------ freshness admission and fallback
		suite
		(
			'ProjectTrack with the store: freshness modes, read-your-writes, fallback and the breaker',
			function ()
			{
				let H = null;
				let _Lead = null;
				let _Member = null;
				let _Task = null;

				suiteSetup(
					function (fDone)
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Materialize: MATERIALIZE }, Faceting: FACETING },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_Lead = H.as('Lead');
								_Member = H.as('Member');
								_Task = H.db.prepare('SELECT IDTask, Status FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 1').get();
								return fDone();
							});
					});

				suiteTeardown((fDone) => { H.stop(() => { return fDone(); }); });

				/**
				 * A raw write the intake cannot see, reported through notify() with no principal (so no
				 * read-your-writes upgrade): observed now, applied only when the held flush lands.
				 */
				let fRawWrite = (pStatus) =>
				{
					H.db.prepare('UPDATE Task SET Status = ? WHERE IDTask = ?').run(pStatus, _Task.IDTask);
					H.faceting.notify('Task', { Operation: 'Update', IDs: [ _Task.IDTask ], Tenants: [ 1 ] });
				};

				test('Exact (the default): the store when caught up; a write observed but not flushed → Live (NotExact), the current numbers; flushed → the store again',
					function (fDone)
					{
						H.query('Task', TASK_BODY, _Member,
							(pError, pBefore, pBeforeMeta) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pBefore.Store.Facets.Status).to.deep.equal({ Engine: STORE, Reason: null });
								Expect(pBefore.Engine).to.equal(STORE);
								Expect(pBefore.Exact).to.equal(true);
								Expect(pBefore.LagMS).to.equal(0);
								Expect(pBefore.Facets.Status.Engine).to.equal(STORE);
								Expect(pBeforeMeta.Store.Used).to.include('Status');
								fRawWrite('Routing-Exact');
								H.query('Task', TASK_BODY, _Member,
									(pPendingError, pPending, pPendingMeta) =>
									{
										Expect(pPendingError || null).to.equal(null);
										Expect(pPending.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'NotExact' });
										Expect(pPendingMeta.Store.Refused.Status).to.equal('NotExact:Task');
										Expect(pPending.Engine).to.equal('Live');
										Expect(pPending.Exact).to.equal(true);
										// Exact is never stale: the Live answer already counts the write.
										Expect(countsOf(pPending.Facets.Status)['Routing-Exact']).to.equal(1);
										H.reference('Task', TASK_BODY, _Member,
											(pReferenceError, pReference) =>
											{
												Expect(pReferenceError || null).to.equal(null);
												Expect(H.normalize(pPending)).to.deep.equal(H.normalize(pReference));
												// Fast: the store, which has not applied the write yet (Exact false, a lag).
												H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), _Member,
													(pFastError, pFast) =>
													{
														Expect(pFastError || null).to.equal(null);
														Expect(pFast.Store.Facets.Status.Engine).to.equal(STORE);
														Expect(pFast.Facets.Status.Exact).to.equal(false);
														Expect(pFast.Exact).to.equal(false);
														Expect(pFast.LagMS).to.be.a('number');
														Expect(countsOf(pFast.Facets.Status)['Routing-Exact']).to.equal(undefined);
														Expect(Date.parse(pFast.AsOf)).to.be.at.most(Date.now());
														H.quiesce(
															(pQuiesceError) =>
															{
																Expect(pQuiesceError || null).to.equal(null);
																H.query('Task', TASK_BODY, _Member,
																	(pAfterError, pAfter) =>
																	{
																		Expect(pAfterError || null).to.equal(null);
																		Expect(pAfter.Store.Facets.Status.Engine).to.equal(STORE);
																		Expect(pAfter.Exact).to.equal(true);
																		Expect(H.normalize(pAfter)).to.deep.equal(H.normalize(pPending));
																		return fDone();
																	});
															});
													});
											});
									});
							});
					});

				test('Bounded: within MaxLagMS the store (Exact false), beyond it Live (Lagging)',
					function (fDone)
					{
						fRawWrite('Routing-Bounded');
						H.query('Task', Object.assign({ Freshness: { Mode: 'Bounded', MaxLagMS: 600000 } }, TASK_BODY), _Member,
							(pError, pWithin) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pWithin.Store.Facets.Status.Engine).to.equal(STORE);
								Expect(pWithin.Facets.Status.Exact).to.equal(false);
								setTimeout(
									() =>
									{
										H.query('Task', Object.assign({ Freshness: { Mode: 'Bounded', MaxLagMS: 0 } }, TASK_BODY), _Member,
											(pBeyondError, pBeyond, pBeyondMeta) =>
											{
												Expect(pBeyondError || null).to.equal(null);
												Expect(pBeyond.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'Lagging' });
												Expect(pBeyondMeta.Store.Refused.Status).to.equal('Lagging:Task');
												Expect(countsOf(pBeyond.Facets.Status)['Routing-Bounded']).to.equal(1);
												H.quiesce((pQuiesceError) => { return fDone(pQuiesceError || undefined); });
											});
									}, 30);
							});
					});

				test('Fast uses an Unverified or CatchingUp entity; Exact refuses both (Unverified / State:CatchingUp)',
					function (fDone)
					{
						let tmpFreshness = H.fable.RetoldFacetingFreshness;
						let tmpCases = [ [ 'Unverified', 'Unverified', 'Unverified:Task' ], [ 'CatchingUp', 'State', 'State:CatchingUp:Task' ] ];
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								tmpFreshness.setState(STORE, 'Task', pCase[0], 'Test');
								H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), _Member,
									(pFastError, pFast) =>
									{
										Expect(pFastError || null).to.equal(null);
										Expect(pFast.Store.Facets.Status.Engine, pCase[0]).to.equal(STORE);
										H.query('Task', TASK_BODY, _Member,
											(pExactError, pExact, pExactMeta) =>
											{
												tmpFreshness.setState(STORE, 'Task', 'Live', 'Test');
												Expect(pExactError || null).to.equal(null);
												Expect(pExact.Store.Facets.Status, pCase[0]).to.deep.equal({ Engine: 'Live', Reason: pCase[1] });
												Expect(pExactMeta.Store.Refused.Status, pCase[0]).to.equal(pCase[2]);
												// The store answer says it is not Exact; the numbers are the same (nothing changed).
												Expect(pFast.Exact, pCase[0]).to.equal(false);
												Expect(pExact.Exact, pCase[0]).to.equal(true);
												Expect(countsOf(pFast.Facets.Status), pCase[0]).to.deep.equal(countsOf(pExact.Facets.Status));
												Expect(pFast.Total, pCase[0]).to.equal(pExact.Total);
												return fNext();
											});
									});
							}, (pError) => { return fDone(pError || undefined); });
					});

				test('Engine: \'Live\' — every facet Live with Reason Requested (any Freshness)',
					function (fDone)
					{
						H.query('Task', Object.assign({ Engine: 'Live', Freshness: { Mode: 'Fast' } }, TASK_BODY), _Member,
							(pError, pEnvelope, pMeta) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pEnvelope.Store.Facets).to.deep.equal({ Status: { Engine: 'Live', Reason: 'Requested' }, '#Total': { Engine: 'Live', Reason: 'Requested' } });
								Expect(pEnvelope.Engine).to.equal('Live');
								Expect(pMeta.Store.Prefer).to.equal('Live');
								Expect(pMeta.Store.Statements).to.equal(0);
								return fDone();
							});
					});

				test('read-your-writes: the writer\'s Fast read is Exact (Live while its write is unflushed); another principal\'s Fast read uses the store',
					function (fDone)
					{
						H.request('PUT', '/1.0/Task', { IDTask: _Task.IDTask, Status: 'Routing-RYW' }, _Lead,
							(pPutError, pPut) =>
							{
								Expect(pPutError || null).to.equal(null);
								Expect(pPut.Status).to.equal(200);
								H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), _Lead,
									(pLeadError, pLeadEnvelope, pLeadMeta) =>
									{
										Expect(pLeadError || null).to.equal(null);
										Expect(pLeadMeta.Freshness).to.include({ Mode: 'Exact', Requested: 'Fast' });
										Expect(pLeadEnvelope.Store.Facets.Status.Engine).to.equal('Live');
										Expect(countsOf(pLeadEnvelope.Facets.Status)['Routing-RYW']).to.equal(1);
										H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), _Member,
											(pMemberError, pMemberEnvelope) =>
											{
												Expect(pMemberError || null).to.equal(null);
												Expect(pMemberEnvelope.Store.Facets.Status.Engine).to.equal(STORE);
												H.quiesce((pQuiesceError) => { return fDone(pQuiesceError || undefined); });
											});
									});
							});
					});

				test('per-facet engines in one envelope: a store facet next to a non-mirrored one (Issue); ExposeReasons off → reason classes',
					function (fDone)
					{
						let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Open', Facet: 'Project.HasOpenIssues' } ], Total: true };
						H.query('Project', tmpBody, _Lead,
							(pError, pEnvelope, pMeta) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: STORE, Reason: null });
								Expect(pEnvelope.Store.Facets.Open).to.deep.equal({ Engine: 'Live', Reason: 'NotMirrored' });
								Expect(pMeta.Store.Refused.Open).to.equal('NotMirrored:Issue');
								Expect(pEnvelope.Facets.Status.Engine).to.equal(STORE);
								Expect(pEnvelope.Facets.Open.Engine).to.equal('Live');
								Expect(pEnvelope.Store.Facets['#Total'].Engine).to.equal(STORE);
								Expect(pEnvelope.Engine, 'the Total\'s engine').to.equal(STORE);
								Expect(pEnvelope.Store).to.include({ Name: STORE, Available: true, Fallback: null });
								H.reference('Project', tmpBody, _Lead,
									(pReferenceError, pReference) =>
									{
										Expect(pReferenceError || null).to.equal(null);
										Expect(H.normalize(pEnvelope)).to.deep.equal(H.normalize(pReference));
										return fDone();
									});
							});
					});

				test('a store error: the same request answers Live with FACET_STORE_FALLBACK; Timeout is told apart; five failures open the breaker (no statement sent); half-open after BreakerOpenMS; a success closes it',
					function (fDone)
					{
						let tmpClient = H.store;
						let tmpEngineStatements = 0;
						let tmpFault = { Status: 500, Text: 'Code: 210. DB::Exception: Connection refused (NETWORK_ERROR)', When: 'Before' };
						tmpClient.setFaultInjector(
							(pRequest) =>
							{
								// Only the engine's reads (never the materializer's keymap / state statements).
								if ((pRequest.Kind === 'Query') && !/_rfs_/.test(String(pRequest.SQL || '')))
								{
									tmpEngineStatements++;
									return tmpFault;
								}
								return null;
							});
						let fFallback = (pIndex, fNext) =>
						{
							H.query('Task', TASK_BODY, _Member,
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError || null, `attempt ${pIndex}`).to.equal(null);
									Expect(pEnvelope.Store.Facets.Status, `attempt ${pIndex}`).to.deep.equal({ Engine: 'Live', Reason: 'StoreError' });
									Expect(pEnvelope.Store.Fallback, `attempt ${pIndex}`).to.deep.equal({ Reason: (pIndex === 0) ? 'Timeout' : 'Error' });
									Expect(pEnvelope.Warnings.filter((pWarning) => { return pWarning.Code === 'FACET_STORE_FALLBACK'; }), `attempt ${pIndex}`).to.deep.equal([ { Code: 'FACET_STORE_FALLBACK', Detail: { Store: STORE, Reason: (pIndex === 0) ? 'Timeout' : 'Error' } } ]);
									Expect(pEnvelope.Engine).to.equal('Live');
									Expect(pMeta.Store.Fallback.Reason).to.equal((pIndex === 0) ? 'Timeout' : 'Error');
									return fNext(pEnvelope);
								});
						};
						// The first failure is a statement timeout (TIMEOUT_EXCEEDED), the others errors.
						tmpFault = { Status: 500, Text: 'Code: 159. DB::Exception: Timeout exceeded: elapsed 1 seconds (TIMEOUT_EXCEEDED)', When: 'Before' };
						let tmpLiveAnswer = null;
						let fRound = (pIndex) =>
						{
							if (pIndex >= 5)
							{
								return fOpen();
							}
							fFallback(pIndex,
								(pEnvelope) =>
								{
									tmpLiveAnswer = tmpLiveAnswer || pEnvelope;
									// The same Live numbers every time (the warnings differ: Timeout, then Error).
									Expect(H.normalize(pEnvelope).Facets).to.deep.equal(H.normalize(tmpLiveAnswer).Facets);
									Expect(pEnvelope.Total).to.equal(tmpLiveAnswer.Total);
									tmpFault = { Status: 500, Text: 'Code: 210. DB::Exception: Connection refused (NETWORK_ERROR)', When: 'Before' };
									return fRound(pIndex + 1);
								});
						};
						let fOpen = () =>
						{
							let tmpBreakers = H.fable.RetoldFacetingFreshness.stats().Breakers;
							Expect(tmpBreakers[`${STORE}:Task:Read`]).to.include({ Open: true, Opens: 1 });
							let tmpSent = tmpEngineStatements;
							H.query('Task', TASK_BODY, _Member,
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError || null).to.equal(null);
									Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'Breaker' });
									Expect(pMeta.Store.Refused.Status).to.equal('Breaker:Task');
									Expect(pEnvelope.Store.Fallback).to.equal(null);
									Expect(pEnvelope.Warnings.filter((pWarning) => { return pWarning.Code === 'FACET_STORE_FALLBACK'; })).to.deep.equal([]);
									Expect(tmpEngineStatements, 'an open breaker sends nothing').to.equal(tmpSent);
									// Half-open after BreakerOpenMS: the store is healthy again; one success closes it.
									tmpClient.setFaultInjector(null);
									setTimeout(
										() =>
										{
											H.query('Task', TASK_BODY, _Member,
												(pHalfError, pHalf) =>
												{
													Expect(pHalfError || null).to.equal(null);
													Expect(pHalf.Store.Facets.Status).to.deep.equal({ Engine: STORE, Reason: null });
													Expect(H.normalize(pHalf).Facets).to.deep.equal(H.normalize(tmpLiveAnswer).Facets);
													Expect(pHalf.Warnings).to.deep.equal([]);
													let tmpAfter = H.fable.RetoldFacetingFreshness.stats().Breakers[`${STORE}:Task:Read`];
													Expect(tmpAfter).to.include({ Open: false, HalfOpen: false, Failures: 0 });
													return fDone();
												});
										}, 350);
								});
						};
						fRound(0);
					});

				test('Records / Count / Keys never touch the store; a Query\'s Records stay Live next to store facets',
					function (fDone)
					{
						let tmpEngine = H.fable.RetoldFacetingEngineClickHouse;
						let fExecute = tmpEngine.execute;
						let tmpExecutions = 0;
						tmpEngine.execute = function (...pArguments) { tmpExecutions++; return fExecute.apply(this, pArguments); };
						let tmpStatements = 0;
						H.store.setFaultInjector((pRequest) => { if ((pRequest.Kind === 'Query') && !/_rfs_/.test(String(pRequest.SQL || ''))) { tmpStatements++; } return null; });
						let fRestore = () => { tmpEngine.execute = fExecute; H.store.setFaultInjector(null); };
						let tmpBody = { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Open', 'InProgress' ] } ] };
						H.records('Task', Object.assign({ Records: { Begin: 0, Cap: 10 } }, tmpBody), _Member,
							(pRecordsError, pRecords) =>
							{
								Expect(pRecordsError || null).to.equal(null);
								Expect(pRecords.Status).to.equal(200);
								H.recordsCount('Task', tmpBody, _Member,
									(pCountError, pCount) =>
									{
										Expect(pCountError || null).to.equal(null);
										Expect(pCount.Status).to.equal(200);
										H.keys('Task', tmpBody, _Member,
											(pKeysError, pKeys) =>
											{
												Expect(pKeysError || null).to.equal(null);
												Expect(pKeys.Status).to.equal(200);
												Expect(tmpExecutions, 'Records / Count / Keys').to.equal(0);
												Expect(tmpStatements, 'Records / Count / Keys').to.equal(0);
												H.query('Task', Object.assign({ Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Records: { Begin: 0, Cap: 5 } }, tmpBody), _Member,
													(pQueryError, pEnvelope) =>
													{
														fRestore();
														Expect(pQueryError || null).to.equal(null);
														Expect(pEnvelope.Store.Facets.Status.Engine).to.equal(STORE);
														Expect(pEnvelope.Records).to.have.length(5);
														Expect(tmpExecutions).to.equal(1);
														Expect(pEnvelope.Records.length).to.be.at.most(pCount.Body.Count);
														return fDone();
													});
											});
									});
							});
					});

				test('Describe and status report the store; the Store block carries Available',
					function (fDone)
					{
						H.request('GET', '/1.0/Facet/Describe/Task', null, _Member,
							(pError, pResponse) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Body.Engines.ClickHouse).to.include({ Configured: true, Available: true, Reason: null });
								Expect(pResponse.Body.Engines.ClickHouse.Entities.Task).to.deep.equal({ State: 'Live', LagMS: 0, Exact: true });
								Expect(pResponse.Body.Entities.Task.Store.ClickHouse).to.include({ Materialized: true, State: 'Live', Reason: null });
								let tmpStatus = H.faceting.status();
								Expect(tmpStatus.Engines.ClickHouse).to.deep.equal({ Configured: true, Available: true, Reason: null });
								Expect(tmpStatus.Stores.Stores.ClickHouse.Available).to.equal(true);
								Expect(tmpStatus.StoreClickHouse).to.include({ Configured: true, Available: true });
								Expect(tmpStatus.Freshness.Entities[`${STORE}:Task`]).to.include({ State: 'Live', Exact: true });
								return fDone();
							});
					});
			}
		);

		// ------------------------------------------------------------------ the cache
		suite
		(
			'ProjectTrack with the store and the result cache',
			function ()
			{
				let H = null;

				suiteSetup(
					function (fDone)
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, Faceting: { Cache: { Enabled: true, ExposeStatus: true } } }, (pError) => { return fDone(pError || undefined); });
					});

				suiteTeardown((fDone) => { H.stop(() => { return fDone(); }); });

				test('store answers are never stored (Bypass \'Store\', the digest Version, a 304 only on that digest); Live answers cache as in M4',
					function (fDone)
					{
						let tmpLead = H.as('Lead');
						let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 10 } ], Total: true };
						let tmpEntries = H.fable.RetoldFacetingResultCache.stats().Entries;
						H.query('Project', tmpBody, tmpLead,
							(pError, pFirst, pFirstMeta) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pFirst.Store.Facets.Status.Engine).to.equal(STORE);
								Expect(pFirstMeta.Cache).to.include({ Status: 'Bypass', Reason: 'Store' });
								H.query('Project', tmpBody, tmpLead,
									(pSecondError, pSecond, pSecondMeta) =>
									{
										Expect(pSecondError || null).to.equal(null);
										Expect(pSecondMeta.Cache).to.include({ Status: 'Bypass', Reason: 'Store' });
										Expect(pSecond.Version, 'the digest of the same representation').to.equal(pFirst.Version);
										Expect(H.fable.RetoldFacetingResultCache.stats().Entries, 'nothing stored').to.equal(tmpEntries);
										// Over HTTP: the digest ETag → 304 (computed, never served from an entry).
										H.facetQuery('Project', tmpBody, Object.assign({ Headers: { 'if-none-match': `W/"${pFirst.Version}"` } }, tmpLead),
											(pHTTPError, pResponse) =>
											{
												Expect(pHTTPError || null).to.equal(null);
												Expect(pResponse.Status).to.equal(304);
												Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Bypass');
												// Engine 'Live': cacheable exactly as in M4 (Miss, then Hit).
												let tmpLiveBody = Object.assign({ Engine: 'Live' }, tmpBody);
												H.query('Project', tmpLiveBody, tmpLead,
													(pLiveError, pLive, pLiveMeta) =>
													{
														Expect(pLiveError || null).to.equal(null);
														Expect(pLiveMeta.Cache.Status).to.equal('Miss');
														Expect(pLive.Version).to.not.equal(pFirst.Version);
														H.query('Project', tmpLiveBody, tmpLead,
															(pHitError, pHit, pHitMeta) =>
															{
																Expect(pHitError || null).to.equal(null);
																Expect(pHitMeta.Cache.Status).to.equal('Hit');
																Expect(pHit.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: null });
																Expect(H.normalize(pHit)).to.deep.equal(H.normalize(pFirst));
																return fDone();
															});
													});
											});
									});
							});
					});
			}
		);

		// ------------------------------------------------------------------ the Store block without a store
		test('without a store section the envelope has no Store block (M4 envelopes unchanged) and Describe says Configured false',
			function (fDone)
			{
				let H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack' },
					(pError) =>
					{
						Expect(pError || null).to.equal(null);
						H.query('Project', { Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] }, H.as('Lead'),
							(pQueryError, pEnvelope, pMeta) =>
							{
								Expect(pQueryError || null).to.equal(null);
								Expect(pEnvelope).to.not.have.property('Store');
								Expect(pMeta).to.not.have.property('Store');
								Expect(pEnvelope.Engine).to.equal('Live');
								H.request('GET', '/1.0/Facet/Describe/Project', null, H.as('Lead'),
									(pDescribeError, pResponse) =>
									{
										Expect(pDescribeError || null).to.equal(null);
										Expect(pResponse.Body.Engines.ClickHouse).to.deep.equal({ Available: false, Configured: false });
										Expect(pResponse.Body.Entities.Project).to.not.have.property('Store');
										H.stop(() => { return fDone(); });
									});
							});
					});
			});

		// ------------------------------------------------------------------ feature-not-boot
		suite
		(
			'feature-not-boot',
			function ()
			{
				let _Proxy = null;
				let _Sockets = new Set();

				suiteTeardown(
					function (fDone)
					{
						_Sockets.forEach((pSocket) => { pSocket.destroy(); });
						if (!_Proxy)
						{
							return fDone();
						}
						_Proxy.close(() => { return fDone(); });
					});

				test('a dead ClickHouse URL: the service boots and answers Live (Describe Available false); once the server answers, the store is used',
					function (fDone)
					{
						// A free port with nothing listening yet: ClickHouse "down".
						let tmpProbe = libNet.createServer();
						tmpProbe.listen(0, '127.0.0.1',
							() =>
							{
								let tmpPort = tmpProbe.address().port;
								tmpProbe.close(
									() =>
									{
										let tmpUpstream = libSupport.connectionInfo();
										let H = libHarness.start(
											{
												Port: PORT, Fixture: 'ProjectTrack', Store: STORE,
												StoreOptions: { Store: { URL: `http://127.0.0.1:${tmpPort}`, RetryConnectMS: 150, PingTimeoutMS: 500 }, Quiesce: false }
											},
											(pError) =>
											{
												Expect(pError || null, 'boots without ClickHouse').to.equal(null);
												H.query('Task', TASK_BODY, H.as('Member'),
													(pQueryError, pEnvelope, pMeta) =>
													{
														Expect(pQueryError || null).to.equal(null);
														Expect(pEnvelope.Store).to.include({ Available: false });
														Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'StoreUnavailable' });
														Expect(pMeta.Store.Used).to.deep.equal([]);
														H.request('GET', '/1.0/Facet/Describe/Task', null, H.as('Member'),
															(pDescribeError, pDescribe) =>
															{
																Expect(pDescribeError || null).to.equal(null);
																Expect(pDescribe.Body.Engines.ClickHouse).to.include({ Configured: true, Available: false });
																Expect(pDescribe.Body.Engines.ClickHouse.Reason).to.be.a('string');
																// ClickHouse comes up (a proxy to the test server on that port).
																_Proxy = libNet.createServer(
																	(pSocket) =>
																	{
																		_Sockets.add(pSocket);
																		let tmpUpstreamSocket = libNet.connect(tmpUpstream.Port, tmpUpstream.Host);
																		_Sockets.add(tmpUpstreamSocket);
																		pSocket.pipe(tmpUpstreamSocket);
																		tmpUpstreamSocket.pipe(pSocket);
																		let fClose = () => { pSocket.destroy(); tmpUpstreamSocket.destroy(); _Sockets.delete(pSocket); _Sockets.delete(tmpUpstreamSocket); };
																		pSocket.on('error', fClose);
																		tmpUpstreamSocket.on('error', fClose);
																		pSocket.on('close', fClose);
																		tmpUpstreamSocket.on('close', fClose);
																	});
																_Proxy.listen(tmpPort, '127.0.0.1',
																	() =>
																	{
																		waitFor(() => { return H.faceting.storeAvailability().Available; }, 30000,
																			(pWaitError) =>
																			{
																				Expect(pWaitError || null, 'the store came up').to.equal(null);
																				H.quiesce(
																					(pQuiesceError) =>
																					{
																						Expect(pQuiesceError || null).to.equal(null);
																						H.query('Task', TASK_BODY, H.as('Member'),
																							(pUpError, pUp) =>
																							{
																								Expect(pUpError || null).to.equal(null);
																								Expect(pUp.Store.Facets.Status).to.deep.equal({ Engine: STORE, Reason: null });
																								Expect(H.normalize(pUp)).to.deep.equal(H.normalize(pEnvelope));
																								H.stop(() => { return fDone(); });
																							});
																					}, 60000);
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('a misconfigured section (no URL) boots, answers Live, and Describe says Misconfigured',
					function (fDone)
					{
						let H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Store: { URL: '' }, Quiesce: false } },
							(pError) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(H.faceting.storeAvailability()).to.deep.equal({ Configured: true, Available: false, Reason: 'Misconfigured' });
								H.query('Task', TASK_BODY, H.as('Member'),
									(pQueryError, pEnvelope) =>
									{
										Expect(pQueryError || null).to.equal(null);
										Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'StoreUnavailable' });
										H.reference('Task', TASK_BODY, H.as('Member'),
											(pReferenceError, pReference) =>
											{
												Expect(pReferenceError || null).to.equal(null);
												Expect(H.normalize(pEnvelope)).to.deep.equal(H.normalize(pReference));
												H.stop(() => { return fDone(); });
											});
									});
							});
					});

				test('Materializer.Enabled false: the store is configured but never used (Reason NoMaterializer)',
					function (fDone)
					{
						let H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Quiesce: false }, Faceting: { Materializer: { Enabled: false } } },
							(pError) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(H.faceting.storeAvailability()).to.deep.equal({ Configured: true, Available: false, Reason: 'NoMaterializer' });
								H.query('Task', TASK_BODY, H.as('Member'),
									(pQueryError, pEnvelope) =>
									{
										Expect(pQueryError || null).to.equal(null);
										Expect(pEnvelope.Engine).to.equal('Live');
										Expect(pEnvelope).to.not.have.property('Store');
										H.stop(() => { return fDone(); });
									});
							});
					});
			}
		);
	}
);
