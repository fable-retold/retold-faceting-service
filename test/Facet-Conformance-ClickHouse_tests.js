/**
 * Facet-Conformance-ClickHouse (internal-contracts §66.2, owner: wiring, port 19146) — O3 through the
 * whole pipeline: the harness Store option boots each domain with the real materializer (backfill,
 * quiesce), and every request runs three times in-process with the same principal and pinned clock:
 * on the store (PreferEngine 'ClickHouse': every Agg the store engine is capable of, no freshness
 * admission), on Live (PreferEngine 'Live') and through the Reference.
 *
 *   ClickHouse == Live == Reference          normalizeForComparison (minus Engine / AsOf / LagMS /
 *                                            Store …), for every request of Bookstore-Conformance-
 *                                            Fixtures (Bookstore; Bookstore-Tenant as tenants 1 and 2),
 *                                            the motivating bodies E1, E2, E3A, E3B and the per-kind
 *                                            coverage (every facet and named scope Describe lists) of
 *                                            ProjectTrack and LabTrack, as every principal of the domain;
 *   the store really answers                 every facet the capability matrix supports reports
 *                                            Store.Facets[k].Engine 'ClickHouse' (a refusal must carry one
 *                                            of the reasons the domain's data explains: a suite that
 *                                            silently fell back everywhere fails);
 *   refusal, never a wrong number            Show-deleted (DeletedRowsNotMirrored), a trusted Opaque hop
 *                                            (OpaqueScope), a non-mirrored entity / column (NotMirrored), the
 *                                            Lossy Bookstore columns on SQLite, a SQLite day-only GT date
 *                                            literal (DateLiteral) — each answers Live with its reason and
 *                                            the Reference's numbers;
 *   isolation                                tenant-2 rows never count on the store, cross-tenant references
 *                                            land in Missing (equal to the Reference), per-tenant totals;
 *   decimal parity                           '=' / IN / NOT IN / range edges on decimal values the 24.8
 *                                            Float64 parameter parser would land one ulp off (§68 #22).
 *
 * ClickHouse-gated (RFS_TEST_CLICKHOUSE=1 / npm run test:ch); the PostgreSQL half runs when both gates
 * are on (RFS_TEST_POSTGRES=1 RFS_TEST_CLICKHOUSE=1).  Every harness gets its own rfs_<pid>_<n>
 * database, dropped on stop.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libConformanceFixtures = require('./fixtures/Bookstore-Conformance-Fixtures.js');
const libFoldCompiler = require('../source/store/clickhouse/ClickHouse-FoldCompiler.js');

const PORT = 19146;
const STORE = 'ClickHouse';

const CH_GATE = libSupport.available();
const PG_GATE = libProviders.available('PostgreSQL');

// The providers the O3 suites run on.
const PROVIDERS = PG_GATE.Available ? [ 'SQLite', 'PostgreSQL' ] : [ 'SQLite' ];

// The domain principals (internal-contracts §31.4).
const PRINCIPALS = Object.freeze({ ProjectTrack: [ 'Lead', 'Member', 'Outsider', 'OtherLead' ], LabTrack: [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ] });

// The refusals each domain's data explains (anything else answered Live is a failure).
const ALLOWED_REFUSALS = Object.freeze(
	{
		// SQLite Bookstore: text in typed columns (non-canonical SaleDate / EndDate texts, '' book counts)
		// and the Show-deleted fixtures.
		'Bookstore:SQLite': [ 'LossyColumn:BookStoreSale.SaleDate', 'LossyColumn:BookPrice.EndDate', 'LossyColumn:BookStoreInventory.BookCount', 'DeletedRowsNotMirrored' ],
		'Bookstore:PostgreSQL': [ 'DeletedRowsNotMirrored' ],
		'Domain': [ 'DeletedRowsNotMirrored' ]
	});

// The pinned request clock of the M2 domains (TestNow), and the motivating queries' constants.
const E1_ROLES = [ 'Owner', 'Lead' ];
const E1_STATUSES = [ 'Active', 'AtRisk' ];

/**
 * countsOf for the fixtures' own Check functions.
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
 * The first differing facet of two normalized envelopes (a readable deep-equal message).
 *
 * @param {Record<string, any>} pA
 * @param {Record<string, any>} pB
 * @return {string}
 */
const firstDifference = (pA, pB) =>
{
	let tmpKeys = Object.keys(Object.assign({}, (pA && pA.Facets) || {}, (pB && pB.Facets) || {}));
	for (let i = 0; i < tmpKeys.length; i++)
	{
		let tmpLeft = JSON.stringify(((pA && pA.Facets) || {})[tmpKeys[i]]);
		let tmpRight = JSON.stringify(((pB && pB.Facets) || {})[tmpKeys[i]]);
		if (tmpLeft !== tmpRight)
		{
			return `facet ${tmpKeys[i]}\n  A: ${String(tmpLeft).slice(0, 1200)}\n  B: ${String(tmpRight).slice(0, 1200)}`;
		}
	}
	let tmpA = Object.assign({}, pA || {}, { Facets: null });
	let tmpB = Object.assign({}, pB || {}, { Facets: null });
	return `envelope fields differ\n  A: ${JSON.stringify(tmpA).slice(0, 1200)}\n  B: ${JSON.stringify(tmpB).slice(0, 1200)}`;
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

/**
 * O3 for one request: ClickHouse == Live == Reference, and every facet either on the store or refused
 * with an allowed reason (recorded in pTally).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pOptions - principal / Now
 * @param {{ Allowed: Array<string>, Name: string }} pExpect
 * @param {{ Answered: number, Refused: Record<string, number>, Requests: number }} pTally
 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
 */
const assertO3 = (pHarness, pEntity, pBody, pOptions, pExpect, pTally, fCallback) =>
{
	pHarness.compareStore(pEntity, pBody, pOptions,
		(pError, pResult) =>
		{
			if (pError)
			{
				// Every engine refuses the same request the same way (a 4xx before execution): fine, as long
				// as Live refuses it too.
				return pHarness.query(pEntity, pBody, Object.assign({ Now: pHarness.traps.TestNow }, pOptions),
					(pLiveError) =>
					{
						try
						{
							Expect(pLiveError, `${pExpect.Name}: the store run failed (${pError.Code || pError.message}) but Live did not`).to.be.an('error');
							Expect(pError.Code, pExpect.Name).to.equal(pLiveError.Code);
						}
						catch (pAssertion)
						{
							return fCallback(pAssertion);
						}
						return fCallback(null, null);
					});
			}
			try
			{
				pTally.Requests++;
				if (JSON.stringify(pResult.StoreNormalized) !== JSON.stringify(pResult.LiveNormalized))
				{
					Expect(pResult.StoreNormalized, `${pExpect.Name}: ClickHouse == Live\n${firstDifference(pResult.StoreNormalized, pResult.LiveNormalized)}`).to.deep.equal(pResult.LiveNormalized);
				}
				if (JSON.stringify(pResult.LiveNormalized) !== JSON.stringify(pResult.ReferenceNormalized))
				{
					Expect(pResult.LiveNormalized, `${pExpect.Name}: Live == Reference\n${firstDifference(pResult.LiveNormalized, pResult.ReferenceNormalized)}`).to.deep.equal(pResult.ReferenceNormalized);
				}
				Expect(pResult.Store.Store, `${pExpect.Name}: the Store block`).to.be.an('object');
				Expect(pResult.Store.Store.Available, `${pExpect.Name}: the store is available`).to.equal(true);
				Expect(pResult.Live.Engine, `${pExpect.Name}: the Live run`).to.equal('Live');
				let tmpRefused = (pResult.StoreMeta && pResult.StoreMeta.Refused) ? pResult.StoreMeta.Refused : {};
				Object.keys(pResult.Engines).forEach(
					(pKey) =>
					{
						if (pResult.Engines[pKey] === STORE)
						{
							pTally.Answered++;
							let tmpFacet = (pResult.Store.Facets || {})[pKey];
							if (tmpFacet)
							{
								Expect(tmpFacet.Engine, `${pExpect.Name} / ${pKey}`).to.equal(STORE);
							}
							return;
						}
						let tmpReason = tmpRefused[pKey] || 'none';
						pTally.Refused[tmpReason] = (pTally.Refused[tmpReason] || 0) + 1;
						Expect(pExpect.Allowed, `${pExpect.Name} / ${pKey}: answered Live (${tmpReason})`).to.include(tmpReason);
					});
				if (pExpect.Check)
				{
					pExpect.Check(pResult.Store, pHarness);
				}
			}
			catch (pAssertion)
			{
				return fCallback(pAssertion);
			}
			return fCallback(null, pResult);
		});
};

/**
 * A fresh tally.
 *
 * @return {{ Answered: number, Refused: Record<string, number>, Requests: number }}
 */
const newTally = () =>
{
	return { Answered: 0, Refused: {}, Requests: 0 };
};

/**
 * Start a store-enabled harness (fDone gets the harness; a skipped provider is reported as .Skip).
 *
 * @param {Record<string, any>} pOptions
 * @param {Function} fDone - (pError, pHarness)
 * @return {Record<string, any>}
 */
const startStore = (pOptions, fDone) =>
{
	let tmpHarness = libHarness.start(Object.assign({ Port: PORT, Store: STORE }, pOptions), (pError) => { return fDone(pError || null, tmpHarness); });
	return tmpHarness;
};

/**
 * The Describe-driven coverage bodies of one entity for one principal: every facet Describe lists
 * (auto and declared; chunks of at most 20), and each named scope with the entity's first facets.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pPrincipal
 * @param {(pError?: Error|null, pBodies?: Array<{ Name: string, Body: Record<string, any> }>) => void} fCallback
 */
const coverageBodies = (pHarness, pEntity, pPrincipal, fCallback) =>
{
	pHarness.request('GET', `/1.0/Facet/Describe/${pEntity}`, null, pPrincipal,
		(pError, pResponse) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			if (pResponse.Status !== 200)
			{
				// Not facetable for this principal: nothing to cover.
				return fCallback(null, []);
			}
			let tmpBlock = pResponse.Body.Entities[pEntity];
			let tmpFacets = (tmpBlock && Array.isArray(tmpBlock.Facets)) ? tmpBlock.Facets : [];
			let tmpBodies = [];
			for (let i = 0; i < tmpFacets.length; i += 20)
			{
				tmpBodies.push(
					{
						Name: `${pEntity} coverage ${i / 20}`,
						Body: { Facets: tmpFacets.slice(i, i + 20).map((pDescriptor, pIndex) => { return { Key: `F${i + pIndex}`, Facet: pDescriptor.Facet }; }), Total: true }
					});
			}
			let tmpScopes = (tmpBlock && Array.isArray(tmpBlock.Scopes)) ? tmpBlock.Scopes : [];
			tmpScopes.forEach(
				(pScope) =>
				{
					let tmpRequired = Object.keys(pScope.Params || {}).some((pName) => { return pScope.Params[pName] && (pScope.Params[pName].Required === true) && !Object.prototype.hasOwnProperty.call(pScope.Params[pName], 'Default'); });
					if (tmpRequired)
					{
						return;
					}
					tmpBodies.push(
						{
							Name: `${pEntity} scope ${pScope.Scope}`,
							Body: { Scopes: [ { Scope: pScope.Scope } ], Facets: tmpFacets.slice(0, 6).map((pDescriptor, pIndex) => { return { Key: `S${pIndex}`, Facet: pDescriptor.Facet }; }), Total: true }
						});
				});
			return fCallback(null, tmpBodies);
		});
};

suite
(
	'Facet-Conformance-ClickHouse',
	function ()
	{
		if (!CH_GATE.Available)
		{
			test.skip(`O3 (ClickHouse-gated: ${CH_GATE.Reason})`, () => {});
			return;
		}
		this.timeout(240000);

		suiteSetup((fDone) => { libSupport.ensure((pError) => { return fDone(pError || undefined); }); });

		PROVIDERS.forEach(
			(pProvider) =>
			{
				// ------------------------------------------------------------ Bookstore and Bookstore-Tenant
				suite
				(
					`${pProvider}: Bookstore conformance list — ClickHouse == Live == Reference`,
					function ()
					{
						this.timeout(240000);
						let _Harnesses = {};
						let _Tally = { Bookstore: newTally(), 'Bookstore-Tenant': newTally() };

						suiteSetup(
							function (fDone)
							{
								startStore({ Fixture: 'Bookstore', Provider: pProvider },
									(pError, pHarness) =>
									{
										_Harnesses.Bookstore = pHarness;
										if (pError)
										{
											return fDone(pError);
										}
										startStore({ Fixture: 'Bookstore-Tenant', Provider: pProvider, StoreOptions: { Store: { ExposeReasons: true } } },
											(pTenantError, pTenantHarness) =>
											{
												_Harnesses['Bookstore-Tenant'] = pTenantHarness;
												return fDone(pTenantError || undefined);
											});
									});
							});

						suiteTeardown(
							function (fDone)
							{
								let tmpHarnesses = Object.keys(_Harnesses).map((pKey) => { return _Harnesses[pKey]; }).filter((pHarness) => { return !!pHarness; });
								eachSeries(tmpHarnesses, (pHarness, fNext) => { pHarness.stop(() => { return fNext(); }); }, () => { return fDone(); });
							});

						let tmpAllowed = ALLOWED_REFUSALS[`Bookstore:${pProvider}`];
						[ [ 'Bookstore', {} ], [ 'Bookstore-Tenant', { Tenant: 1 } ], [ 'Bookstore-Tenant', { Tenant: 2 } ] ].forEach(
							(pCase) =>
							{
								test(`${pCase[0]} ${JSON.stringify(pCase[1])}: every fixture, the store answering what it supports`,
									function (fDone)
									{
										let H = _Harnesses[pCase[0]];
										let tmpFixtures = libConformanceFixtures.build(Expect, countsOf, libHarness).Fixtures;
										eachSeries(tmpFixtures,
											(pFixture, fNext) =>
											{
												// The fixtures' own checks are written for the SQLite seed's text (Facet-Conformance-PostgreSQL
												// applies its deltas to them); on PostgreSQL the three-way equality is the check.
												let tmpCheck = ((pProvider === 'SQLite') && (pCase[0] === 'Bookstore') && (typeof(pFixture.Check) === 'function')) ? pFixture.Check : null;
												assertO3(H, pFixture.Entity, pFixture.Body, Object.assign({}, pFixture.Session || {}, pCase[1]), { Name: pFixture.Name, Allowed: tmpAllowed, Check: tmpCheck }, _Tally[pCase[0]], fNext);
											},
											(pError) =>
											{
												if (pError)
												{
													return fDone(pError);
												}
												let tmpTally = _Tally[pCase[0]];
												// A suite that silently fell back everywhere fails here.
												Expect(tmpTally.Answered, JSON.stringify(tmpTally.Refused)).to.be.above(60);
												return fDone();
											});
									});
							});

						test('every refusal the data explains was seen (and nothing else): Lossy columns on SQLite, Show-deleted',
							function ()
							{
								let tmpSeen = Object.keys(_Tally.Bookstore.Refused).sort();
								Expect(tmpSeen).to.deep.equal(tmpAllowed.slice().sort());
							});

						test('two-tenant isolation on the store: each tenant counts its own live rows; tenant 2 never in tenant 1',
							function (fDone)
							{
								let H = _Harnesses['Bookstore-Tenant'];
								let tmpBody = { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Missing: true }, { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 50 } ], Total: true };
								let tmpTotals = {};
								eachSeries([ 1, 2 ],
									(pTenant, fNext) =>
									{
										H.storeQuery('BookStoreSale', tmpBody, { Tenant: pTenant },
											(pError, pEnvelope) =>
											{
												Expect(pError || null).to.equal(null);
												Expect(pEnvelope.Store.Facets.Pay).to.deep.equal({ Engine: STORE, Reason: null });
												Expect(pEnvelope.Store.Facets['#Total'].Engine).to.equal(STORE);
												Expect(pEnvelope.Total).to.equal(H.seed.TenantLiveCounts[pTenant].BookStoreSale);
												let tmpSQLite = !!H.db && (typeof(H.db.prepare) === 'function');
												let tmpStores = new Set(tmpSQLite ? H.db.prepare('SELECT DISTINCT IDBookStore AS S FROM BookStoreSale WHERE IDTenant = ? AND Deleted = 0').all(pTenant).map((pRow) => { return pRow.S; }) : []);
												if (tmpSQLite)
												{
													pEnvelope.Facets.Store.Buckets.forEach((pBucket) => { Expect(tmpStores.has(pBucket.Key), `tenant ${pTenant} store ${pBucket.Key}`).to.equal(true); });
												}
												tmpTotals[pTenant] = pEnvelope.Total;
												return fNext();
											});
									},
									() =>
									{
										Expect(tmpTotals[1] + tmpTotals[2]).to.equal(H.seed.LiveCounts.BookStoreSale);
										Expect(tmpTotals[1]).to.not.equal(tmpTotals[2]);
										return fDone();
									});
							});

						test('ExposeReasons: the envelope carries the full reason (on), else only its class (off)',
							function (fDone)
							{
								let tmpBody = { FilterString: 'FBV~Deleted~EQ~1', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };
								_Harnesses['Bookstore-Tenant'].storeQuery('BookStoreSale', tmpBody, { Tenant: 1 },
									(pError, pExposed) =>
									{
										Expect(pError || null).to.equal(null);
										Expect(pExposed.Store.Facets.Pay).to.deep.equal({ Engine: 'Live', Reason: 'DeletedRowsNotMirrored' });
										// A predicate on SaleDate (Compare-lossy on SQLite: non-canonical date texts) next to a
										// DateHistogram of it (bucketing is exact, so the store keeps it when nothing filters it).
										let tmpLossyBody = { FilterString: 'FBV~SaleDate~GE~2015-01-01', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };
										_Harnesses.Bookstore.storeQuery('BookStoreSale', tmpLossyBody, {},
											(pClassError, pClassOnly, pMeta) =>
											{
												Expect(pClassError || null).to.equal(null);
												if (pProvider === 'SQLite')
												{
													// The column name stays out of the envelope; pMeta (in-process) has it.
													Expect(pClassOnly.Store.Facets.Pay).to.deep.equal({ Engine: 'Live', Reason: 'LossyColumn' });
													Expect(pMeta.Store.Refused.Pay).to.equal('LossyColumn:BookStoreSale.SaleDate');
												}
												else
												{
													Expect(pClassOnly.Store.Facets.Pay).to.deep.equal({ Engine: STORE, Reason: null });
												}
												_Harnesses.Bookstore.storeQuery('BookStoreSale', { Facets: [ { Key: 'Sold', Facet: 'BookStoreSale.SaleDate', Interval: 'year' } ] }, {},
													(pHistogramError, pHistogram) =>
													{
														Expect(pHistogramError || null).to.equal(null);
														Expect(pHistogram.Store.Facets.Sold).to.deep.equal({ Engine: STORE, Reason: null });
														return fDone();
													});
											});
									});
							});

						test('decimal parity: = / IN / NOT IN / range edges at decimals the 24.8 Float64 parameter parser lands one ulp off (toFloat64 of the text, §68 #22)',
							function (fDone)
							{
								let H = _Harnesses.Bookstore;
								// Amounts whose {p:Float64} text ClickHouse 24.8 parses one ulp off (5.94 → 5.9399999999999995,
								// 7.56 → 7.5600000000000005, …): written through the CRUD route (the intake → the materializer
								// → toFloat64 of the text on insert), then filtered and bucketed on exactly those values.
								const AMOUNTS = [ 5.94, 7.56, 1.14, 4.69, 6.81, 5.56 ];
								eachSeries(AMOUNTS,
									(pAmount, fNext) =>
									{
										H.request('POST', '/1.0/BookStoreSale', { TotalAmount: pAmount, PaymentMethod: 'Decimal-Parity', IDBookStore: 1, SaleDate: '2026-01-15 10:00:00' }, {},
											(pError, pResponse) =>
											{
												Expect(pError || null).to.equal(null);
												Expect(pResponse.Status, JSON.stringify(pResponse.Body)).to.equal(200);
												return fNext();
											});
									},
									() =>
									{
										H.quiesce(
											(pQuiesceError) =>
											{
												Expect(pQuiesceError || null).to.equal(null);
												let tmpFacets = [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ];
												let tmpBodies =
													[
														{ Name: '= 5.94', Body: { FilterString: 'FBV~TotalAmount~EQ~5.94', Facets: tmpFacets, Total: true }, Total: 1 },
														{ Name: '= 7.56', Body: { FilterString: 'FBV~TotalAmount~EQ~7.56', Facets: tmpFacets, Total: true }, Total: 1 },
														{ Name: 'IN 1.14, 4.69, 6.81', Body: { FilterString: 'FBL~TotalAmount~INN~1.14,4.69,6.81', Facets: tmpFacets, Total: true }, Total: 3 },
														{ Name: '>= 5.56 and < 7.56 (the parity rows only)', Body: { FilterString: 'FBV~TotalAmount~GE~5.56~FBV~TotalAmount~LT~7.56~FBV~PaymentMethod~EQ~Decimal-Parity', Facets: tmpFacets, Total: true }, Total: 3 },
														{ Name: 'NOT IN on the parity rows', Body: { FilterString: 'FBV~PaymentMethod~EQ~Decimal-Parity', Clauses: [ { Type: 'RawFilter', Value: 'FBV~TotalAmount~NE~5.94' } ], Facets: tmpFacets, Total: true }, Total: 5 },
														{ Name: 'Ranges / Edges at 5.56 and 7.56', Body: { FilterString: 'FBV~PaymentMethod~EQ~Decimal-Parity', Facets: [ { Key: 'R', Facet: 'BookStoreSale.TotalAmount', Fold: 'Ranges', Ranges: [ { Key: 'lo', To: 5.56 }, { Key: 'mid', From: 5.56, To: 7.56 }, { Key: 'hi', From: 7.56 } ] }, { Key: 'E', Facet: 'BookStoreSale.TotalAmount', Mode: 'Edges', Edges: [ 0, 5.56, 7.56 ], OpenEnded: true } ], Total: true }, Total: 6 }
													];
												let tmpTally = newTally();
												eachSeries(tmpBodies,
													(pCase, fNext) =>
													{
														assertO3(H, 'BookStoreSale', pCase.Body, {}, { Name: pCase.Name, Allowed: [] }, tmpTally,
															(pError, pResult) =>
															{
																if (!pError)
																{
																	Expect(pResult.Store.Total, pCase.Name).to.equal(pCase.Total);
																	Object.keys(pResult.Engines).forEach((pKey) => { Expect(pResult.Engines[pKey], `${pCase.Name} / ${pKey}`).to.equal(STORE); });
																}
																return fNext(pError || null);
															});
													},
													(pCaseError) =>
													{
														if (pCaseError)
														{
															return fDone(pCaseError);
														}
														let tmpRanges = null;
														// The bucket counts themselves (the Ranges / Edges body): 1.14 and 4.69 below 5.56; 5.56, 5.94
														// and 6.81 in [5.56, 7.56); 7.56 from 7.56.
														H.storeQuery('BookStoreSale', tmpBodies[5].Body, {},
															(pRangesError, pEnvelope) =>
															{
																Expect(pRangesError || null).to.equal(null);
																tmpRanges = {};
																pEnvelope.Facets.R.Buckets.forEach((pBucket) => { tmpRanges[pBucket.Key] = pBucket.Count; });
																Expect(tmpRanges).to.deep.equal({ lo: 2, mid: 3, hi: 1 });
																return fDone();
															});
													});
											});
									});
							});
					}
				);

				// ------------------------------------------------------------ ProjectTrack and LabTrack
				suite
				(
					`${pProvider}: ProjectTrack and LabTrack — the motivating queries and the per-kind coverage, every principal`,
					function ()
					{
						this.timeout(240000);
						let _Harnesses = {};
						let _Tally = { ProjectTrack: newTally(), LabTrack: newTally() };

						suiteSetup(
							function (fDone)
							{
								startStore({ Fixture: 'ProjectTrack', Provider: pProvider },
									(pError, pHarness) =>
									{
										_Harnesses.ProjectTrack = pHarness;
										if (pError)
										{
											return fDone(pError);
										}
										startStore({ Fixture: 'LabTrack', Provider: pProvider },
											(pLabError, pLabHarness) =>
											{
												_Harnesses.LabTrack = pLabHarness;
												return fDone(pLabError || undefined);
											});
									});
							});

						suiteTeardown(
							function (fDone)
							{
								let tmpHarnesses = Object.keys(_Harnesses).map((pKey) => { return _Harnesses[pKey]; }).filter((pHarness) => { return !!pHarness; });
								eachSeries(tmpHarnesses, (pHarness, fNext) => { pHarness.stop(() => { return fNext(); }); }, () => { return fDone(); });
							});

						/**
						 * The motivating bodies of a domain (internal-contracts §31.5).
						 */
						let fMotivating = (pDomain, pHarness) =>
						{
							let tmpTraps = pHarness.traps;
							if (pDomain === 'ProjectTrack')
							{
								return (
									[
										[ 'E1', 'Project',
											{
												Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: E1_ROLES.slice() } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
												Clauses:
													[
														{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: E1_STATUSES.slice(), FilterKey: 'Status', Hash: 'Status-DSVL-1' },
														{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpTraps.E1ClientIDs.slice(), FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
														{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
													],
												Facets:
													[
														{ Key: 'Status', Facet: 'Project.Status' },
														{ Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
														{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
														{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
														{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
													],
												Total: true
											} ],
										[ 'E1 without the Status clause (the cube over every member)', 'Project',
											{
												Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: E1_ROLES.slice() } } ],
												Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 }, { Key: 'Started', Facet: 'Project.StartDate', Interval: 'quarter' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' } ],
												Total: true
											} ],
										[ 'E2', 'Document',
											{
												Clauses:
													[
														{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ tmpTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
														{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
													],
												Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
												Total: true
											} ]
									]);
							}
							return (
								[
									[ 'E3A', 'MaterialIntakeRequirement',
										{
											Facets:
												[
													{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' },
													{ Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
													{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' },
													{ Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
													{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
												],
											Total: true
										} ],
									[ 'E3B', 'MaterialIntake',
										{
											Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ],
											Total: true
										} ]
								]);
						};

						[ 'ProjectTrack', 'LabTrack' ].forEach(
							(pDomain) =>
							{
								test(`${pDomain}: the motivating queries, every principal — ClickHouse == Live == Reference, every facet on the store`,
									function (fDone)
									{
										let H = _Harnesses[pDomain];
										let tmpWork = [];
										PRINCIPALS[pDomain].forEach((pPrincipal) => { fMotivating(pDomain, H).forEach((pCase) => { tmpWork.push([ pPrincipal, pCase ]); }); });
										let tmpTally = newTally();
										eachSeries(tmpWork,
											(pItem, fNext) =>
											{
												assertO3(H, pItem[1][1], pItem[1][2], H.as(pItem[0]), { Name: `${pItem[1][0]} as ${pItem[0]}`, Allowed: [] }, tmpTally, fNext);
											},
											(pError) =>
											{
												if (pError)
												{
													return fDone(pError);
												}
												Expect(tmpTally.Refused, 'no motivating facet falls back').to.deep.equal({});
												Expect(tmpTally.Answered).to.be.at.least(tmpWork.length * 2);
												_Tally[pDomain].Answered += tmpTally.Answered;
												return fDone();
											});
									});

								test(`${pDomain}: the per-kind coverage (every facet and scope Describe lists, every entity), every principal`,
									function (fDone)
									{
										let H = _Harnesses[pDomain];
										let tmpEntities = H.faceting.fable.RetoldFacetingCatalog.entities();
										let tmpWork = [];
										eachSeries(PRINCIPALS[pDomain],
											(pPrincipal, fNextPrincipal) =>
											{
												eachSeries(tmpEntities,
													(pEntity, fNextEntity) =>
													{
														coverageBodies(H, pEntity, H.as(pPrincipal),
															(pError, pBodies) =>
															{
																(pBodies || []).forEach((pCase) => { tmpWork.push([ pPrincipal, pEntity, pCase ]); });
																return fNextEntity(pError || null);
															});
													}, fNextPrincipal);
											},
											(pDescribeError) =>
											{
												if (pDescribeError)
												{
													return fDone(pDescribeError);
												}
												Expect(tmpWork.length).to.be.above(10);
												let tmpTally = newTally();
												eachSeries(tmpWork,
													(pItem, fNext) =>
													{
														assertO3(H, pItem[1], pItem[2].Body, H.as(pItem[0]), { Name: `${pItem[2].Name} as ${pItem[0]}`, Allowed: ALLOWED_REFUSALS.Domain }, tmpTally, fNext);
													},
													(pError) =>
													{
														if (pError)
														{
															return fDone(pError);
														}
														Expect(tmpTally.Answered, JSON.stringify(tmpTally.Refused)).to.be.above(tmpWork.length);
														_Tally[pDomain].Answered += tmpTally.Answered;
														return fDone();
													});
											});
									});
							});

						test('cross-tenant isolation on the store: OtherLead / OtherTech see only tenant 2, and the totals differ from tenant 1',
							function (fDone)
							{
								let H = _Harnesses.ProjectTrack;
								let tmpBody = { Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 50 } ], Total: true };
								H.storeQuery('Project', tmpBody, H.as('Lead'),
									(pError, pLead) =>
									{
										Expect(pError || null).to.equal(null);
										H.storeQuery('Project', tmpBody, H.as('OtherLead'),
											(pOtherError, pOther) =>
											{
												Expect(pOtherError || null).to.equal(null);
												Expect(pLead.Store.Facets.Status.Engine).to.equal(STORE);
												Expect(pOther.Store.Facets.Status.Engine).to.equal(STORE);
												Expect(pLead.Total).to.equal(H.visibleRows('Project', H.as('Lead')).length);
												Expect(pOther.Total).to.equal(H.visibleRows('Project', H.as('OtherLead')).length);
												Expect(pLead.Total).to.not.equal(pOther.Total);
												// A tenant-1 project referencing a tenant-2 client (the seed's trap) keeps its key, but the
												// label read is scoped: never resolved, never the other tenant's name.
												let tmpTenant2Clients = new Map(H.visibleRows('Client', H.as('OtherLead')).map((pRow) => { return [ pRow.IDClient, pRow.Name ]; }));
												pLead.Facets.Client.Buckets.forEach(
													(pBucket) =>
													{
														if (tmpTenant2Clients.has(pBucket.Key))
														{
															Expect(pBucket.LabelResolved, `tenant-1 bucket ${pBucket.Key}`).to.not.equal(true);
															Expect(pBucket.Label, `tenant-1 bucket ${pBucket.Key}`).to.not.equal(tmpTenant2Clients.get(pBucket.Key));
														}
													});
												return fDone();
											});
									});
							});
					}
				);
			});

		// -------------------------------------------------------------------- the refusals (SQLite)
		suite
		(
			'SQLite: unsupported cases answer Live with their reason and the Reference\'s numbers',
			function ()
			{
				this.timeout(240000);
				let _ProjectTrack = null;
				let _LabTrack = null;

				suiteSetup(
					function (fDone)
					{
						// Issue is not mirrored; Project.Name is excluded from the Project mirror.
						startStore(
							{
								Fixture: 'ProjectTrack',
								StoreOptions:
									{
										Materialize:
											{
												Customer: { Store: [ STORE ] }, User: { Store: [ STORE ] }, Client: { Store: [ STORE ] },
												Project: { Store: [ STORE ], ExcludeColumns: [ 'Name' ] },
												ProjectMembership: { Store: [ STORE ] }, Task: { Store: [ STORE ] }, FormType: { Store: [ STORE ] }, Document: { Store: [ STORE ] }
											},
										Store: { ExposeReasons: true }
									}
							},
							(pError, pHarness) =>
							{
								_ProjectTrack = pHarness;
								if (pError)
								{
									return fDone(pError);
								}
								startStore({ Fixture: 'LabTrack' },
									(pLabError, pLabHarness) =>
									{
										_LabTrack = pLabHarness;
										return fDone(pLabError || undefined);
									});
							});
					});

				suiteTeardown(
					function (fDone)
					{
						eachSeries([ _ProjectTrack, _LabTrack ].filter((pHarness) => { return !!pHarness; }), (pHarness, fNext) => { pHarness.stop(() => { return fNext(); }); }, () => { return fDone(); });
					});

				/**
				 * One refused case: equal across the three engines, the facet answered Live with this reason.
				 */
				let fRefused = (H, pEntity, pBody, pPrincipal, pExpected, fDone) =>
				{
					let tmpTally = newTally();
					assertO3(H, pEntity, pBody, pPrincipal, { Name: JSON.stringify(pExpected), Allowed: Object.keys(pExpected).map((pKey) => { return pExpected[pKey]; }) }, tmpTally,
						(pError, pResult) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							Object.keys(pExpected).forEach(
								(pKey) =>
								{
									Expect(pResult.Engines[pKey], pKey).to.equal('Live');
									Expect(pResult.StoreMeta.Refused[pKey], pKey).to.equal(pExpected[pKey]);
									Expect(pResult.Store.Store.Facets[pKey], pKey).to.deep.equal({ Engine: 'Live', Reason: pExpected[pKey] });
									Expect(libFoldCompiler.REASON_CLASSES, pKey).to.include(pExpected[pKey].split(':')[0]);
								});
							return fDone(null, pResult);
						});
				};

				test('a non-mirrored entity (Issue) and a non-mirrored column (Project.Name): NotMirrored; the rest of the request stays on the store',
					function (fDone)
					{
						let H = _ProjectTrack;
						fRefused(H, 'Project', { Facets: [ { Key: 'Open', Facet: 'Project.HasOpenIssues' }, { Key: 'Name', Facet: 'Project.Name', Top: 5 }, { Key: 'Status', Facet: 'Project.Status' } ], Total: true }, H.as('Lead'),
							{ Open: 'NotMirrored:Issue', Name: 'NotMirrored:Project.Name' },
							(pError, pResult) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								// Per-facet engines in one envelope.
								Expect(pResult.Engines.Status).to.equal(STORE);
								Expect(pResult.Engines['#Total']).to.equal(STORE);
								Expect(pResult.Store.Facets.Status.Engine).to.equal(STORE);
								Expect(pResult.Store.Facets.Open.Engine).to.equal('Live');
								Expect(pResult.Store.Engine, 'the envelope Engine is the Total\'s').to.equal(STORE);
								return fDone();
							});
					});

				test('Show-deleted: DeletedRowsNotMirrored (the Live answer counts the deleted rows)',
					function (fDone)
					{
						let H = _ProjectTrack;
						fRefused(H, 'Task', { Clauses: [ { Type: 'RawFilter', Value: 'FBL~Deleted~INN~0,1' } ], Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Total: true }, H.as('Lead'),
							{ Status: 'DeletedRowsNotMirrored', '#Total': 'DeletedRowsNotMirrored' },
							(pError, pResult) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								Expect(pResult.Store.IncludesDeleted).to.equal(true);
								return fDone();
							});
					});

				test('a SQLite day-only GT date literal: DateLiteral (SQLite compares the text, the mirror the instant)',
					function (fDone)
					{
						let H = _ProjectTrack;
						fRefused(H, 'Project', { FilterString: 'FBV~StartDate~GT~2026-03-01', Facets: [ { Key: 'Status', Facet: 'Project.Status' } ], Total: true }, H.as('Lead'),
							{ Status: 'DateLiteral:Project.StartDate', '#Total': 'DateLiteral:Project.StartDate' },
							(pError) => { return fDone(pError || undefined); });
					});

				test('a trusted Opaque hop (Scope.TrustedOpaque, a behavior replacing the query): OpaqueScope, never staged on the store',
					function (fDone)
					{
						let H = _LabTrack;
						let tmpController = H.fable.MeadowEndpoints.LabQueue.controller;
						let tmpInjection = tmpController.BehaviorInjection;
						let fOriginal = tmpInjection._BehaviorFunctions['Reads-QueryConfiguration'];
						let tmpScope = H.faceting.options.Scope;
						let tmpTrusted = tmpScope.TrustedOpaque;
						tmpScope.TrustedOpaque = [ 'LabQueue' ];
						tmpInjection.setBehavior('Reads-QueryConfiguration',
							function (pRequest, pRequestState, fCallback)
							{
								return fOriginal.call(this, pRequest, pRequestState,
									(pError) =>
									{
										pRequestState.Query.parameters.queryOverride = 'SELECT <%= FieldList %> FROM LabQueue<%= Where %>';
										return fCallback(pError);
									});
							});
						let fRestore = () =>
						{
							tmpInjection.setBehavior('Reads-QueryConfiguration', fOriginal);
							tmpScope.TrustedOpaque = tmpTrusted;
						};
						let tmpBody = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' } ] };
						H.compareStore('MaterialIntakeRequirement', tmpBody, H.as('Tech'),
							(pError, pResult) =>
							{
								fRestore();
								Expect(pError || null).to.equal(null);
								// The store refuses and the facets run Live, which answers exactly what it answers on its
								// own (here: its Staged path's own per-facet refusal of a non-leaf opaque hop).
								Expect(pResult.StoreNormalized, firstDifference(pResult.StoreNormalized, pResult.LiveNormalized)).to.deep.equal(pResult.LiveNormalized);
								[ 'ToDo', 'Queue' ].forEach(
									(pKey) =>
									{
										Expect(pResult.Engines[pKey], pKey).to.equal('Live');
										Expect(pResult.StoreMeta.Refused[pKey], pKey).to.equal('OpaqueScope:LabQueue');
										Expect(pResult.Store.Store.Facets[pKey], pKey).to.deep.equal({ Engine: 'Live', Reason: 'OpaqueScope' });
									});
								// The same request without the opaque behavior is the store's again, and equals the Reference.
								H.compareStore('MaterialIntakeRequirement', tmpBody, H.as('Tech'),
									(pAgainError, pAgain) =>
									{
										Expect(pAgainError || null).to.equal(null);
										Expect(pAgain.Engines.ToDo).to.equal(STORE);
										Expect(pAgain.StoreNormalized).to.deep.equal(pAgain.LiveNormalized);
										Expect(pAgain.StoreNormalized).to.deep.equal(pAgain.ReferenceNormalized);
										return fDone();
									});
							});
					});

				test('Describe: Engines.ClickHouse, the per-entity Store block (Materialized / NotDeclared) and the facet Engines',
					function (fDone)
					{
						let H = _ProjectTrack;
						H.request('GET', '/1.0/Facet/Describe', null, H.as('Lead'),
							(pError, pResponse) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(pResponse.Status).to.equal(200);
								let tmpDescribe = pResponse.Body;
								Expect(tmpDescribe.Engines.ClickHouse).to.include({ Configured: true, Available: true, Reason: null });
								Expect(tmpDescribe.Engines.ClickHouse.Entities.Project).to.include({ State: 'Live', Exact: true });
								Expect(tmpDescribe.Engines.ClickHouse.Entities).to.not.have.property('Issue');
								Expect(tmpDescribe.Entities.Project.Store.ClickHouse).to.include({ Materialized: true, State: 'Live', Reason: null });
								Expect(tmpDescribe.Entities.Issue.Store.ClickHouse).to.include({ Materialized: false, Reason: 'NotDeclared' });
								let tmpStatus = tmpDescribe.Entities.Project.Facets.find((pFacet) => { return pFacet.Facet === 'Project.Status'; });
								let tmpName = tmpDescribe.Entities.Project.Facets.find((pFacet) => { return pFacet.Facet === 'Project.Name'; });
								let tmpOpen = tmpDescribe.Entities.Project.Facets.find((pFacet) => { return pFacet.Facet === 'Project.HasOpenIssues'; });
								Expect(tmpStatus.Engines).to.deep.equal([ 'Live', STORE ]);
								if (tmpName)
								{
									Expect(tmpName.Engines).to.deep.equal([ 'Live' ]);
								}
								if (tmpOpen)
								{
									Expect(tmpOpen.Engines).to.deep.equal([ 'Live' ]);
								}
								return fDone();
							});
					});
			}
		);
	}
);
