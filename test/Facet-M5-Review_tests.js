/**
 * Facet-M5-Review (port 19148) — a regression for every finding of the Milestone 5 review that needs the
 * real ClickHouse store (the pure-unit ones live with their services: Facet-Store-ClickHouse,
 * Facet-ClickHouse-Compiler, Facet-Materializer).
 *
 *   correctness   a column NOT IN drops NULL rows on the store too (String / Int64 / Float64, alone and in an
 *                 OR group); SQLite 'true' / 'false' text in an integer column is Value-lossy (answered Live,
 *                 the right numbers) and clears once corrected; scalar strings with backslashes, tabs and
 *                 `\N` compare exactly (= != LIKE NOT LIKE, and a behavior-appended != scope entry);
 *   security      a parameter over the HTTP field limit is refused (Live, no round trip); deterministic
 *                 store errors never trip the breaker; freshness is not exposed on a policy host unless
 *                 ExposeFreshness (Describe detail for Admin.authorize principals); the database owner
 *                 marker refuses another deployment; the materializer lease keeps a second process off;
 *   perf-ops      a hung store: same-request Live fallback inside the deadline, the whole store marked
 *                 Unreachable (O(1) refusals) and restored by a ping; a bounded shutdown; a swap whose
 *                 keymap EXCHANGE reports an error after landing completes; a single dropped table is
 *                 rebuilt alone; inserts and keymap reads per flush (not per write); a paced Scrub after a
 *                 restart; capable() stays cheap with a 90k backlog;
 *   PostgreSQL    timestamps are read as the naive text (never shifted by the process time zone).
 *
 * ClickHouse-gated (RFS_TEST_CLICKHOUSE=1, npm run test:ch); the PostgreSQL halves also need
 * RFS_TEST_POSTGRES=1.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libNet = require('net');

const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libClickHouseClient = require('../source/store/clickhouse/ClickHouse-Client.js');
const libDDL = require('../source/store/clickhouse/ClickHouse-DDL.js');

const PORT = 19148;
const STORE = 'ClickHouse';

const CH_GATE = libSupport.available();
const PG_GATE = libProviders.available('PostgreSQL');
const PROVIDERS = PG_GATE.Available ? [ 'SQLite', 'PostgreSQL' ] : [ 'SQLite' ];

const TASK_BODY = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Task.Status' } ], Total: true });

/**
 * Run (fNext) => … steps in order; the first error ends the run.
 *
 * @param {Array<Function>} pSteps
 * @param {(pError?: Error|null) => void} fDone
 */
const series = (pSteps, fDone) =>
{
	let tmpIndex = 0;
	let fNext = (pError) =>
	{
		if (pError || (tmpIndex >= pSteps.length))
		{
			return fDone(pError || null);
		}
		let tmpStep = pSteps[tmpIndex++];
		try
		{
			return tmpStep((pStepError) => { setImmediate(() => { fNext(pStepError || null); }); });
		}
		catch (pError2)
		{
			return fDone(pError2);
		}
	};
	fNext(null);
};

/**
 * Wait until a predicate holds (polling), or call back an error after pTimeoutMS.
 *
 * @param {() => boolean} fPredicate
 * @param {number} pTimeoutMS
 * @param {(pError?: Error|null) => void} fCallback
 */
const waitFor = (fPredicate, pTimeoutMS, fCallback) =>
{
	let tmpUntil = Date.now() + pTimeoutMS;
	let fCheck = () =>
	{
		let tmpOK = false;
		try
		{
			tmpOK = !!fPredicate();
		}
		catch (pError)
		{
			tmpOK = false;
		}
		if (tmpOK)
		{
			return fCallback(null);
		}
		if (Date.now() >= tmpUntil)
		{
			return fCallback(new Error(`waitFor: not true within ${pTimeoutMS} ms.`));
		}
		setTimeout(fCheck, 20);
	};
	fCheck();
};

/**
 * A raw write the intake cannot see (SQLite or PostgreSQL), then notify() as a raw writer must.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pTable
 * @param {string} pColumn
 * @param {any} pValue
 * @param {string} pIdentity
 * @param {Array<number>} pIDs
 * @param {Array<any>|null} pTenants - notify Tenants (null on a fixture without tenancy)
 * @param {(pError?: Error|null) => void} fCallback
 */
const rawSet = (pHarness, pTable, pColumn, pValue, pIdentity, pIDs, pTenants, fCallback) =>
{
	let fNotify = (pError) =>
	{
		if (pError)
		{
			return fCallback(pError);
		}
		let tmpChange = { Operation: 'Update', IDs: pIDs };
		if (Array.isArray(pTenants))
		{
			tmpChange.Tenants = pTenants;
		}
		pHarness.faceting.notify(pTable, tmpChange);
		return fCallback(null);
	};
	if (pHarness.db && (typeof(pHarness.db.prepare) === 'function'))
	{
		try
		{
			let tmpStatement = pHarness.db.prepare(`UPDATE "${pTable}" SET "${pColumn}" = ? WHERE "${pIdentity}" = ?`);
			pIDs.forEach((pID) => { tmpStatement.run(pValue, pID); });
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		return fNotify(null);
	}
	pHarness.connection.pool.query(`UPDATE "${pTable}" SET "${pColumn}" = $1 WHERE "${pIdentity}" = ANY($2::int[])`, [ pValue, pIDs ], (pError) => { return fNotify(pError || null); });
};

/**
 * Rows of a raw read (SQLite or PostgreSQL: the SQL is written for both with "quoted" names and ? / $n).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pSQLite
 * @param {string} pPostgreSQL
 * @param {(pError?: Error|null, pRows?: Array<Record<string, any>>) => void} fCallback
 */
const rawRows = (pHarness, pSQLite, pPostgreSQL, fCallback) =>
{
	if (pHarness.db && (typeof(pHarness.db.prepare) === 'function'))
	{
		try
		{
			return fCallback(null, pHarness.db.prepare(pSQLite).all());
		}
		catch (pError)
		{
			return fCallback(pError);
		}
	}
	pHarness.connection.pool.query(pPostgreSQL, [], (pError, pResult) => { return fCallback(pError || null, pResult ? pResult.rows : null); });
};

/**
 * O3 for one body: ClickHouse == Live == Reference; every facet on the store except the ones
 * pExpect.Refused names (Key → the full refusal reason), which must be answered Live for that reason.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pPrincipal
 * @param {{ Name: string, Refused?: Record<string, string> }} pExpect
 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
 */
const assertO3 = (pHarness, pEntity, pBody, pPrincipal, pExpect, fCallback) =>
{
	pHarness.compareStore(pEntity, pBody, pPrincipal || {},
		(pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			try
			{
				Expect(pResult.StoreNormalized, `${pExpect.Name}: ClickHouse == Live`).to.deep.equal(pResult.LiveNormalized);
				Expect(pResult.LiveNormalized, `${pExpect.Name}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
				let tmpRefused = (pResult.StoreMeta && pResult.StoreMeta.Refused) ? pResult.StoreMeta.Refused : {};
				let tmpExpected = pExpect.Refused || {};
				Expect(Object.keys(pResult.Engines).length, `${pExpect.Name}: facets`).to.be.above(0);
				Object.keys(pResult.Engines).forEach(
					(pKey) =>
					{
						if (Object.prototype.hasOwnProperty.call(tmpExpected, pKey))
						{
							Expect(tmpRefused[pKey], `${pExpect.Name} / ${pKey}: refused`).to.equal(tmpExpected[pKey]);
							Expect(pResult.Engines[pKey]).to.equal('Live');
						}
						else
						{
							Expect(pResult.Engines[pKey], `${pExpect.Name} / ${pKey}: on the store (${tmpRefused[pKey] || 'no reason'})`).to.equal(STORE);
						}
					});
			}
			catch (pAssertion)
			{
				return fCallback(pAssertion);
			}
			return fCallback(null, pResult);
		});
};

/**
 * A TCP proxy in front of rfs-test-clickhouse that can hang: while Hang is on it accepts connections and
 * swallows every byte both ways (a server that accepts and never answers).
 *
 * @param {(pError?: Error|null, pProxy?: { Port: number, Hang: boolean, close: Function }) => void} fCallback
 */
const hangingProxy = (fCallback) =>
{
	let tmpInfo = libSupport.connectionInfo();
	let tmpTarget = new URL(tmpInfo.URL);
	let tmpSockets = new Set();
	let tmpProxy = { Port: 0, Hang: false, Connections: 0 };
	let tmpServer = libNet.createServer(
		(pClient) =>
		{
			tmpProxy.Connections++;
			let tmpUpstream = libNet.connect(Number(tmpTarget.port), tmpTarget.hostname);
			tmpSockets.add(pClient);
			tmpSockets.add(tmpUpstream);
			let fClose = () => { pClient.destroy(); tmpUpstream.destroy(); tmpSockets.delete(pClient); tmpSockets.delete(tmpUpstream); };
			pClient.on('data', (pData) => { if (!tmpProxy.Hang) { tmpUpstream.write(pData); } });
			tmpUpstream.on('data', (pData) => { if (!tmpProxy.Hang) { pClient.write(pData); } });
			pClient.on('error', fClose);
			tmpUpstream.on('error', fClose);
			pClient.on('close', fClose);
			tmpUpstream.on('close', fClose);
		});
	tmpServer.listen(0, '127.0.0.1',
		() =>
		{
			tmpProxy.Port = tmpServer.address().port;
			tmpProxy.close = (fDone) => { tmpSockets.forEach((pSocket) => { pSocket.destroy(); }); tmpServer.close(() => { return fDone(); }); };
			return fCallback(null, tmpProxy);
		});
};

suite
(
	'Facet-M5-Review',
	function ()
	{
		if (!CH_GATE.Available)
		{
			test.skip(`M5 review regressions (ClickHouse-gated: ${CH_GATE.Reason})`, () => {});
			return;
		}
		this.timeout(240000);

		suiteSetup((fDone) => { libSupport.ensure((pError) => { return fDone(pError || undefined); }); });

		// ------------------------------------------------------------------ the client against the server
		suite
		(
			'client: scalar strings in the Escaped format round-trip exactly; arrays too; an over-long parameter is refused before sending',
			() =>
			{
				test('backslashes, a trailing backslash, TAB / LF / CR, `\\N`, quotes: {p:String} and Array(String) both read back exactly',
					function (fDone)
					{
						let tmpInfo = libSupport.connectionInfo();
						let tmpClient = new libClickHouseClient({ URL: tmpInfo.URL, User: tmpInfo.User, Password: tmpInfo.Password, Database: null });
						const VALUES = [ 'C:\\temp', 'x\\Ny', '\\N', 'trailing\\', 'a\tb', 'line\nbreak', 'cr\rlf', 'it\'s "quoted"', '\\\\double', 'tab\\there', '' ];
						let tmpIndex = 0;
						let fNext = () =>
						{
							if (tmpIndex >= VALUES.length)
							{
								tmpClient.query('SELECT {a:Array(String)} AS V, isNull({n:Nullable(String)}) AS N', { a: VALUES, n: '\\N' }, null,
									(pError, pRows) =>
									{
										Expect(pError || null).to.equal(null);
										Expect(pRows[0].V).to.deep.equal(VALUES);
										Expect(Number(pRows[0].N), 'the text \\N is a string, never NULL').to.equal(0);
										// An over-long parameter: refused client side (deterministic, nothing sent).
										let tmpRequests = tmpClient.stats().Requests;
										tmpClient.query('SELECT length({p:String}) AS L', { p: 'x'.repeat(libClickHouseClient.MAX_PARAM_TEXT + 1) }, null,
											(pLongError) =>
											{
												Expect(pLongError).to.be.an('error');
												Expect(pLongError).to.include({ Deterministic: true, ParameterSize: true });
												Expect(tmpClient.stats().Requests).to.equal(tmpRequests);
												tmpClient.close();
												return fDone();
											});
									});
								return;
							}
							let tmpValue = VALUES[tmpIndex++];
							tmpClient.query('SELECT {p:String} AS V, length({p:String}) AS L', { p: tmpValue }, null,
								(pError, pRows) =>
								{
									Expect(pError || null, JSON.stringify(tmpValue)).to.equal(null);
									Expect(pRows[0].V, JSON.stringify(tmpValue)).to.equal(tmpValue);
									Expect(Number(pRows[0].L), JSON.stringify(tmpValue)).to.equal(Buffer.byteLength(tmpValue, 'utf8'));
									return fNext();
								});
						};
						fNext();
					});
			}
		);

		// ------------------------------------------------------------------ O3 additions, per source dialect
		PROVIDERS.forEach(
			(pProvider) =>
			{
				suite
				(
					`${pProvider}: O3 additions — NOT IN over NULLs, boolean text, backslash values`,
					function ()
					{
						this.timeout(240000);
						let B = null;
						let P = null;
						let _Appended = { On: false };

						suiteSetup(
							function (fDone)
							{
								B = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Provider: pProvider, Store: STORE, StoreOptions: { Store: { ExposeReasons: true } } },
									(pError) =>
									{
										if (pError)
										{
											return fDone(pError);
										}
										P = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider, Store: STORE, StoreOptions: { Store: { ExposeReasons: true } } },
											(pProjectError) =>
											{
												if (pProjectError)
												{
													return fDone(pProjectError);
												}
												// A behavior-appended != scope entry whose value holds a backslash (06 §4.3: a Portable
												// appended predicate, compiled into the store's relation).
												P.installBehavior('Task', 'Reads-QueryConfiguration',
													function (pRequest, pRequestState, fCallback)
													{
														if (_Appended.On)
														{
															pRequestState.Query.addFilter('Status', 'HR\\Confidential', '!=', 'AND', 'TestHideHR');
														}
														return fCallback();
													});
												return fDone();
											});
									});
							});

						suiteTeardown(
							function (fDone)
							{
								series([ (fNext) => { return B ? B.stop(() => { return fNext(); }) : fNext(); }, (fNext) => { return P ? P.stop(() => { return fNext(); }) : fNext(); } ], () => { return fDone(); });
							});

						test('a column NOT IN drops NULL rows on the store as Live does — nullable String, Int64 and Float64 columns holding NULLs, alone and inside an OR group',
							function (fDone)
							{
								let tmpBooks = [ 21, 22, 23, 24, 25 ];
								let tmpSales = [ 31, 32, 33, 34, 35, 36 ];
								let tmpCounts = '(SELECT COUNT(*) FROM "Book" WHERE "Genre" IS NULL) AS "G", (SELECT COUNT(*) FROM "BookStoreSale" WHERE "IDBookStore" IS NULL) AS "S", (SELECT COUNT(*) FROM "BookStoreSale" WHERE "TotalAmount" IS NULL) AS "A"';
								series(
									[
										(fNext) => { rawSet(B, 'Book', 'Genre', null, 'IDBook', tmpBooks, null, fNext); },
										(fNext) => { rawSet(B, 'BookStoreSale', 'IDBookStore', null, 'IDBookStoreSale', tmpSales.slice(0, 3), null, fNext); },
										(fNext) => { rawSet(B, 'BookStoreSale', 'TotalAmount', null, 'IDBookStoreSale', tmpSales.slice(3), null, fNext); },
										(fNext) => { B.quiesce(fNext); },
										(fNext) =>
										{
											// The data really holds NULLs in each column.
											rawRows(B, `SELECT ${tmpCounts}`, `SELECT ${tmpCounts}`,
												(pError, pRows) =>
												{
													Expect(pError || null).to.equal(null);
													Expect(Number(pRows[0].G)).to.be.at.least(5);
													Expect(Number(pRows[0].S)).to.be.at.least(3);
													Expect(Number(pRows[0].A)).to.be.at.least(3);
													return fNext();
												});
										},
										(fNext) => { assertO3(B, 'Book', { FilterString: 'FBL~Genre~NIN~Fiction', Facets: [ { Key: 'Lang', Facet: 'Book.Language' } ], Total: true }, {}, { Name: 'String NOT IN' }, fNext); },
										(fNext) => { assertO3(B, 'BookStoreSale', { FilterString: 'FBL~IDBookStore~NIN~1,2', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ], Total: true }, {}, { Name: 'Int64 NOT IN' }, fNext); },
										(fNext) => { assertO3(B, 'BookStoreSale', { FilterString: 'FBL~TotalAmount~NIN~5.94,10', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ], Total: true }, {}, { Name: 'Float64 NOT IN' }, fNext); },
										(fNext) =>
										{
											assertO3(B, 'BookStoreSale', { FilterString: 'FOP~0~(~0~FBV~PaymentMethod~EQ~Credit~FBLOR~IDBookStore~NIN~1,2~FCP~0~)~0', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ], Total: true }, {}, { Name: 'NOT IN inside an OR group' },
												(pError, pResult) =>
												{
													if (pError)
													{
														return fNext(pError);
													}
													// The store counted exactly what Live counted (no NULL-store row slipped in).
													Expect(pResult.Store.Total).to.equal(pResult.Live.Total);
													return fNext();
												});
										}
									], fDone);
							});

						if (pProvider === 'SQLite')
						{
							test('SQLite \'true\' text in an integer column is Value-lossy: answered Live (LossyColumn); a corrected value clears the flag and the store answers again',
								function (fDone)
								{
									let tmpIDs = [ 3, 4, 5 ];
									let tmpBody = { Facets: [ { Key: 'Active', Facet: 'BookStoreEmployee.IsActive', Missing: true } ], Total: true };
									let tmpFiltered = { FilterString: 'FBV~IsActive~EQ~1', Facets: [ { Key: 'Store', Facet: 'BookStoreEmployee.IDBookStore', Top: 50 } ], Total: true };
									const LOSSY = 'LossyColumn:BookStoreEmployee.IsActive';
									series(
										[
											(fNext) => { rawSet(B, 'BookStoreEmployee', 'IsActive', 'true', 'IDBookStoreEmployee', tmpIDs, null, fNext); },
											(fNext) => { B.quiesce(fNext); },
											(fNext) =>
											{
												Expect(B.materializer.entityInfo(STORE, 'BookStoreEmployee').Lossy).to.deep.include({ IsActive: 'Value' });
												assertO3(B, 'BookStoreEmployee', tmpBody, {}, { Name: 'IsActive Terms (lossy)', Refused: { Active: LOSSY } }, fNext);
											},
											(fNext) => { assertO3(B, 'BookStoreEmployee', tmpFiltered, {}, { Name: 'IsActive = 1 (lossy)', Refused: { Store: LOSSY, '#Total': LOSSY } }, fNext); },
											(fNext) => { rawSet(B, 'BookStoreEmployee', 'IsActive', 1, 'IDBookStoreEmployee', tmpIDs, null, fNext); },
											(fNext) => { B.quiesce(fNext); },
											(fNext) =>
											{
												Expect(B.materializer.entityInfo(STORE, 'BookStoreEmployee').Lossy, 'the corrected rows clear the flag').to.not.have.property('IsActive');
												assertO3(B, 'BookStoreEmployee', tmpBody, {}, { Name: 'IsActive Terms (corrected)' },
													(pError) =>
													{
														if (pError)
														{
															return fNext(pError);
														}
														return assertO3(B, 'BookStoreEmployee', tmpFiltered, {}, { Name: 'IsActive = 1 (corrected)' }, fNext);
													});
											}
										], fDone);
								});
						}

						test('scalar strings with backslashes compare exactly on the store (= != LIKE NOT LIKE), and so does a behavior-appended != scope entry',
							function (fDone)
							{
								let tmpLead = P.as('Lead');
								let tmpTasks = null;
								let fCount = (pResult, pKey) =>
								{
									let tmpBucket = pResult.Store.Facets.Status.Buckets.find((pBucket) => { return pBucket.Key === pKey; });
									return tmpBucket ? tmpBucket.Count : 0;
								};
								series(
									[
										(fNext) =>
										{
											// Tasks the Lead can read (the list endpoint, with its scope).
											P.listRows('Task', '', tmpLead,
												(pError, pRows) =>
												{
													tmpTasks = (pRows || []).map((pRow) => { return Number(pRow.IDTask); }).sort((pA, pB) => { return pA - pB; }).slice(0, 8);
													if (!pError)
													{
														Expect(tmpTasks.length).to.equal(8);
													}
													return fNext(pError || null);
												});
										},
										(fNext) => { rawSet(P, 'Task', 'Status', 'C:\\temp', 'IDTask', tmpTasks.slice(0, 1), [ 1 ], fNext); },
										(fNext) => { rawSet(P, 'Task', 'Status', 'x\\Ny', 'IDTask', tmpTasks.slice(1, 2), [ 1 ], fNext); },
										(fNext) => { rawSet(P, 'Task', 'Status', 'tab\\there', 'IDTask', tmpTasks.slice(2, 3), [ 1 ], fNext); },
										(fNext) => { rawSet(P, 'Task', 'Status', 'HR\\Confidential', 'IDTask', tmpTasks.slice(3, 5), [ 1 ], fNext); },
										(fNext) => { P.quiesce(fNext); },
										(fNext) =>
										{
											assertO3(P, 'Task', { Facets: [ { Key: 'Status', Facet: 'Task.Status', Top: 100 } ], Total: true }, tmpLead, { Name: 'every status' },
												(pError, pResult) =>
												{
													if (pError)
													{
														return fNext(pError);
													}
													// The stored values come back exactly (the mirror's text and the result parsing).
													Expect(fCount(pResult, 'C:\\temp')).to.equal(1);
													Expect(fCount(pResult, 'x\\Ny')).to.equal(1);
													Expect(fCount(pResult, 'tab\\there')).to.equal(1);
													Expect(fCount(pResult, 'HR\\Confidential')).to.equal(2);
													return fNext();
												});
										},
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~EQ~C:\\temp' }, TASK_BODY), tmpLead, { Name: '= C:\\temp' }, (pError, pResult) => { if (!pError) { Expect(pResult.Store.Total).to.equal(1); } return fNext(pError || null); }); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~NE~C:\\temp' }, TASK_BODY), tmpLead, { Name: '!= C:\\temp' }, fNext); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~EQ~x\\Ny' }, TASK_BODY), tmpLead, { Name: '= x\\Ny' }, (pError, pResult) => { if (!pError) { Expect(pResult.Store.Total).to.equal(1); } return fNext(pError || null); }); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~EQ~tab\\there' }, TASK_BODY), tmpLead, { Name: '= tab\\there' }, (pError, pResult) => { if (!pError) { Expect(pResult.Store.Total).to.equal(1); } return fNext(pError || null); }); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBL~Status~INN~x\\Ny,tab\\there' }, TASK_BODY), tmpLead, { Name: 'IN (x\\Ny, tab\\there)' }, (pError, pResult) => { if (!pError) { Expect(pResult.Store.Total).to.equal(2); } return fNext(pError || null); }); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~LK~%25\\temp' }, TASK_BODY), tmpLead, { Name: 'LIKE %\\temp' }, fNext); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~LK~C:%25' }, TASK_BODY), tmpLead, { Name: 'LIKE C:%' }, (pError, pResult) => { if (!pError) { Expect(pResult.Store.Total).to.equal(1); } return fNext(pError || null); }); },
										(fNext) => { assertO3(P, 'Task', Object.assign({ FilterString: 'FBV~Status~NLK~HR%25' }, TASK_BODY), tmpLead, { Name: 'NOT LIKE HR%' }, fNext); },
										(fNext) =>
										{
											_Appended.On = true;
											assertO3(P, 'Task', { Facets: [ { Key: 'Status', Facet: 'Task.Status', Top: 100 } ], Total: true }, tmpLead, { Name: 'behavior-appended != HR\\Confidential' },
												(pError, pResult) =>
												{
													_Appended.On = false;
													if (pError)
													{
														return fNext(pError);
													}
													Expect(fCount(pResult, 'HR\\Confidential')).to.equal(0);
													Expect(fCount(pResult, 'C:\\temp')).to.equal(1);
													return fNext();
												});
										}
									], fDone);
							});
					}
				);
			});

		// ------------------------------------------------------------------ the breaker and refusals (security)
		suite
		(
			'refusals and the breaker: a parameter over the field limit never reaches the store; deterministic errors never trip the breaker; freshness gated on a policy host',
			function ()
			{
				this.timeout(240000);
				let H = null;

				suiteSetup(
					function (fDone)
					{
						H = libHarness.start(
							{
								Port: PORT, Fixture: 'ProjectTrack', Store: STORE,
								StoreOptions: { Store: { ExposeFreshness: false, ExposeReasons: false } },
								Faceting:
									{
										Materializer: { FlushIntervalMS: 600000 },
										Freshness: { ReadYourWritesMS: 0, BreakerFailures: 3 },
										Admin: { authorize: (pRequest) => { return !!(pRequest && pRequest.headers && (pRequest.headers['x-test-admin'] === 'yes')); } }
									}
							},
							(pError) => { return fDone(pError || undefined); });
					});

				suiteTeardown((fDone) => { return H ? H.stop(() => { return fDone(); }) : fDone(); });

				test('an IN list whose parameter would exceed the HTTP field limit: refused ParameterSize (answered Live, no store statement, the breaker untouched)',
					function (fDone)
					{
						let tmpValues = [];
						for (let i = 0; i < 1000; i++)
						{
							tmpValues.push(`${'v'.repeat(96)}-${i}`);
						}
						let tmpStatements = 0;
						H.store.setFaultInjector((pRequest) => { if ((pRequest.Kind === 'Query') && !/_rfs_/.test(String(pRequest.SQL || ''))) { tmpStatements++; } return null; });
						H.query('Task', Object.assign({ FilterString: `FBL~Status~INN~${tmpValues.join(',')}`, Freshness: { Mode: 'Fast' } }, TASK_BODY), H.as('Member'),
							(pError, pEnvelope, pMeta) =>
							{
								H.store.setFaultInjector(null);
								Expect(pError || null).to.equal(null);
								Expect(pMeta.Store.Refused.Status).to.equal('ParameterSize');
								Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'ParameterSize' });
								Expect(tmpStatements).to.equal(0);
								let tmpBreaker = H.fable.RetoldFacetingFreshness.stats().Breakers[`${STORE}:Task:Read`];
								Expect(!tmpBreaker || (tmpBreaker.Failures === 0)).to.equal(true);
								return fDone();
							});
					});

				test('deterministic store errors (a parameter the server cannot parse) fall back to Live but never open the breaker: another tenant keeps the store',
					function (fDone)
					{
						H.store.setFaultInjector((pRequest) => { return ((pRequest.Kind === 'Query') && !/_rfs_/.test(String(pRequest.SQL || ''))) ? { Status: 500, Text: 'Code: 457. DB::Exception: Value cannot be parsed for query parameter \'w_0\' (BAD_QUERY_PARAMETER)', When: 'Before' } : null; });
						let tmpRound = 0;
						let fRound = () =>
						{
							if (tmpRound >= 6)
							{
								H.store.setFaultInjector(null);
								let tmpBreaker = H.fable.RetoldFacetingFreshness.stats().Breakers[`${STORE}:Task:Read`];
								Expect(!tmpBreaker || ((tmpBreaker.Open === false) && (tmpBreaker.Opens === 0))).to.equal(true);
								H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), H.as('OtherLead'),
									(pError, pEnvelope) =>
									{
										Expect(pError || null).to.equal(null);
										Expect(pEnvelope.Store.Facets.Status.Engine, 'the other tenant still uses the store').to.equal(STORE);
										return fDone();
									});
								return;
							}
							tmpRound++;
							H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), H.as('Lead'),
								(pError, pEnvelope) =>
								{
									Expect(pError || null).to.equal(null);
									Expect(pEnvelope.Store.Facets.Status.Engine).to.equal('Live');
									Expect(pEnvelope.Warnings.map((pWarning) => { return pWarning.Code; })).to.include('FACET_STORE_FALLBACK');
									return fRound();
								});
						};
						fRound();
					});

				test('ExposeFreshness off (a policy host): a lagging store answer carries no LagMS / AsOf, freshness refusals say \'Freshness\', Describe hides the per-entity state — except to an Admin.authorize principal',
					function (fDone)
					{
						let tmpMember = H.as('Member');
						let tmpTask = null;
						series(
							[
								(fNext) =>
								{
									rawRows(H, 'SELECT "IDTask" FROM "Task" WHERE "IDCustomer" = 2 AND "Deleted" = 0 ORDER BY "IDTask" LIMIT 1', '', (pError, pRows) => { tmpTask = pRows ? Number(pRows[0].IDTask) : null; return fNext(pError || null); });
								},
								// Another tenant's write, held unflushed (FlushIntervalMS): the store lags.
								(fNext) => { rawSet(H, 'Task', 'Status', 'Other-Tenant-Write', 'IDTask', [ tmpTask ], [ 2 ], fNext); },
								(fNext) =>
								{
									H.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), tmpMember,
										(pError, pEnvelope) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Facets.Status.Engine).to.equal(STORE);
											Expect(pEnvelope.Facets.Status.Exact).to.equal(false);
											Expect(pEnvelope.Facets.Status.LagMS, 'no lag figure').to.equal(null);
											Expect(pEnvelope.Facets.Status.AsOf, 'no AsOf of the lag').to.equal(null);
											return fNext();
										});
								},
								(fNext) =>
								{
									H.query('Task', TASK_BODY, tmpMember,
										(pError, pEnvelope, pMeta) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pMeta.Store.Refused.Status).to.equal('NotExact:Task');
											Expect(pEnvelope.Store.Facets.Status).to.deep.equal({ Engine: 'Live', Reason: 'Freshness' });
											return fNext();
										});
								},
								(fNext) =>
								{
									H.request('GET', '/1.0/Facet/Describe/Task', null, tmpMember,
										(pError, pResponse) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pResponse.Status).to.equal(200);
											Expect(pResponse.Body.Engines.ClickHouse).to.deep.equal({ Configured: true, Available: true });
											Expect(pResponse.Body.Entities.Task.Store.ClickHouse).to.not.have.property('State');
											return fNext();
										});
								},
								(fNext) =>
								{
									H.request('GET', '/1.0/Facet/Describe/Task', null, Object.assign({ Headers: { 'x-test-admin': 'yes' } }, tmpMember),
										(pError, pResponse) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pResponse.Status).to.equal(200);
											Expect(pResponse.Body.Engines.ClickHouse.Entities.Task).to.include.keys([ 'State', 'LagMS', 'Exact' ]);
											Expect(pResponse.Body.Entities.Task.Store.ClickHouse.State).to.be.a('string');
											return fNext();
										});
								},
								(fNext) => { H.quiesce(fNext); }
							], fDone);
					});
			}
		);

		// ------------------------------------------------------------------ a hung store (perf-ops)
		suite
		(
			'a hung store (accepts, never answers): Live inside the deadline, the store marked Unreachable at once, restored by a ping; a bounded shutdown',
			function ()
			{
				this.timeout(240000);
				let H = null;
				let X = null;

				suiteSetup(
					function (fDone)
					{
						hangingProxy(
							(pProxyError, pProxy) =>
							{
								if (pProxyError)
								{
									return fDone(pProxyError);
								}
								X = pProxy;
								H = libHarness.start(
									{
										Port: PORT, Fixture: 'ProjectTrack', Store: STORE,
										StoreOptions: { Store: { URL: `http://127.0.0.1:${X.Port}`, UnreachablePingMS: 150, UnreachableAfterFailures: 2, PingTimeoutMS: 300, HealthMinTimeoutMS: 500 } },
										Faceting: { Materializer: { DrainOnStopMS: 800 }, Freshness: { ReadYourWritesMS: 0 } }
									},
									(pError) => { return fDone(pError || undefined); });
							});
					});

				suiteTeardown(
					function (fDone)
					{
						if (X)
						{
							X.Hang = false;
						}
						series([ (fNext) => { return H ? H.stop(() => { return fNext(); }) : fNext(); }, (fNext) => { return X ? X.close(() => { return fNext(); }) : fNext(); } ], () => { return fDone(); });
					});

				test('every statement is bounded by the request deadline: Live with FACET_STORE_FALLBACK (Timeout) inside TimeoutMS; after two the store is Unreachable and requests go Live at once; a ping restores it',
					function (fDone)
					{
						let tmpMember = H.as('Member');
						let tmpBody = Object.assign({ Freshness: { Mode: 'Fast' }, TimeoutMS: 4000 }, TASK_BODY);
						series(
							[
								(fNext) =>
								{
									H.query('Task', tmpBody, tmpMember,
										(pError, pEnvelope) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Store.Facets.Status.Engine, 'before the hang').to.equal(STORE);
											X.Hang = true;
											return fNext();
										});
								},
								(fNext) =>
								{
									let tmpStart = Date.now();
									H.query('Task', tmpBody, tmpMember,
										(pError, pEnvelope) =>
										{
											let tmpElapsed = Date.now() - tmpStart;
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Facets.Status.Engine).to.equal('Live');
											Expect(pEnvelope.Store.Fallback).to.deep.equal({ Reason: 'Timeout' });
											Expect(pEnvelope.Warnings.map((pWarning) => { return pWarning.Code; })).to.include('FACET_STORE_FALLBACK');
											Expect(tmpElapsed, 'the store had 40 % of the 4 s deadline').to.be.below(4000);
											return fNext();
										});
								},
								(fNext) => { H.query('Task', tmpBody, tmpMember, (pError) => { Expect(pError || null).to.equal(null); return fNext(); }); },
								(fNext) =>
								{
									Expect(H.store.status()).to.include({ Available: false, Reason: 'Unreachable' });
									let tmpStart = Date.now();
									H.query('Task', tmpBody, tmpMember,
										(pError, pEnvelope, pMeta) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pMeta.Store.Refused.Status).to.equal('StoreUnavailable');
											Expect(pEnvelope.Store.Fallback).to.equal(null);
											Expect(Date.now() - tmpStart, 'no store round trip').to.be.below(1000);
											X.Hang = false;
											return fNext();
										});
								},
								(fNext) => { waitFor(() => { return H.store.status().Available === true; }, 10000, fNext); },
								(fNext) =>
								{
									H.query('Task', tmpBody, tmpMember,
										(pError, pEnvelope) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Store.Facets.Status.Engine, 'restored').to.equal(STORE);
											return fNext();
										});
								}
							], fDone);
					});

				test('a graceful shutdown with a hung store ends within DrainOnStopMS plus a short grace (its connections destroyed)',
					function (fDone)
					{
						rawRows(H, 'SELECT "IDTask" FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0 ORDER BY "IDTask" LIMIT 1', '',
							(pError, pRows) =>
							{
								Expect(pError || null).to.equal(null);
								rawSet(H, 'Task', 'Status', 'pending-at-shutdown', 'IDTask', [ Number(pRows[0].IDTask) ], [ 1 ],
									() =>
									{
										X.Hang = true;
										let tmpStart = Date.now();
										H.faceting.shutdown(
											() =>
											{
												let tmpElapsed = Date.now() - tmpStart;
												X.Hang = false;
												Expect(tmpElapsed, 'bounded').to.be.below(4000);
												return fDone();
											});
									});
							});
					});
			}
		);

		// ------------------------------------------------------------------ one materializer per store; the owner marker
		suite
		(
			'the materializer lease and the database owner marker',
			function ()
			{
				this.timeout(240000);
				const LEASE = { Materializer: { Lease: { TTLMS: 1500, HeartbeatMS: 250, SettleMS: 50 } } };
				let _Database = null;
				let A = null;
				let B = null;
				let C = null;

				suiteSetup(() => { _Database = libSupport.freshDatabase(); });

				suiteTeardown(
					function (fDone)
					{
						series(
							[ A, B, C ].map((pHarness) => { return (fNext) => { if (!pHarness || !pHarness.faceting) { return pHarness ? pHarness.stop(() => { return fNext(); }) : fNext(); } return pHarness.faceting.shutdown(() => { pHarness.stop(() => { return fNext(); }); }); }; }),
							() => { libSupport.release(_Database, () => { return fDone(); }); });
					});

				test('a second process on the same store stays off it (NotLeader, answering Live); a graceful stop hands it over at once; another deployment is refused (owner marker)',
					function (fDone)
					{
						series(
							[
								(fNext) => { A = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Database: _Database }, Faceting: LEASE }, (pError) => { return fNext(pError || null); }); },
								(fNext) => { B = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Database: _Database, Quiesce: false }, Faceting: LEASE }, (pError) => { return fNext(pError || null); }); },
								(fNext) => { waitFor(() => { let tmpStatus = B.materializer.status().Stores.ClickHouse; return !!tmpStatus && (tmpStatus.Reason === 'NotLeader'); }, 10000, fNext); },
								(fNext) =>
								{
									Expect(B.materializer.status().Stores.ClickHouse.Leader).to.equal(false);
									Expect(A.materializer.status().Stores.ClickHouse.Leader).to.equal(true);
									B.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), B.as('Member'),
										(pError, pEnvelope, pMeta) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Facets.Status.Engine).to.equal('Live');
											Expect(pMeta.Store.Refused.Status).to.equal('StoreUnavailable');
											return fNext();
										});
								},
								// A stops gracefully (CleanShutdown, then the lease released): B takes over within a heartbeat or so.
								(fNext) =>
								{
									let tmpStopped = Date.now();
									A.faceting.shutdown(
										() =>
										{
											A.stop(
												() =>
												{
													A = null;
													waitFor(() => { let tmpStatus = B.materializer.status().Stores.ClickHouse; return !!tmpStatus && tmpStatus.Leader && tmpStatus.Available; }, 10000,
														(pError) =>
														{
															if (!pError)
															{
																Expect(Date.now() - tmpStopped, 'well before the 1.5 s TTL would have run out').to.be.below(5000);
															}
															return fNext(pError || null);
														});
												});
										});
								},
								(fNext) => { B.quiesce(fNext, 60000); },
								(fNext) => { libSupport.assertMirrorEqualsSource(B, STORE, 'Task', (pError) => { return fNext(pError || null); }); },
								(fNext) =>
								{
									B.query('Task', Object.assign({ Freshness: { Mode: 'Fast' } }, TASK_BODY), B.as('Member'),
										(pError, pEnvelope) =>
										{
											Expect(pError || null).to.equal(null);
											Expect(pEnvelope.Store.Facets.Status.Engine, 'B serves the store now').to.equal(STORE);
											return fNext();
										});
								},
								// Another deployment (another InstanceID) pointed at the same database: refused.
								(fNext) => { C = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Store: STORE, StoreOptions: { Database: _Database, Quiesce: false }, Faceting: Object.assign({ InstanceID: 'another-app' }, LEASE) }, (pError) => { return fNext(pError || null); }); },
								(fNext) => { waitFor(() => { return C.store.status().Reason === 'Misconfigured'; }, 10000, fNext); },
								(fNext) =>
								{
									Expect(C.store.status().LastError).to.match(/another deployment/);
									Expect(C.materializer.status().Stores.ClickHouse.Available).to.equal(false);
									Expect(B.materializer.status().Stores.ClickHouse.Leader, 'B keeps it').to.equal(true);
									return fNext();
								}
							], fDone);
					});
			}
		);

		// ------------------------------------------------------------------ rebuilds, wipes and the write path (perf-ops)
		suite
		(
			'swaps, partial wipes and the write path',
			function ()
			{
				this.timeout(240000);
				let H = null;

				suiteSetup(
					function (fDone)
					{
						H = libHarness.start(
							{
								Port: PORT, Fixture: 'ProjectTrack', Store: STORE,
								Faceting: { Materializer: { FlushIntervalMS: 1000, MaxBackoffMS: 300 }, ChangeCapture: { NotifySettleMS: 40 }, Freshness: { ReadYourWritesMS: 0 } }
							},
							(pError) => { return fDone(pError || undefined); });
					});

				suiteTeardown((fDone) => { return H ? H.stop(() => { return fDone(); }) : fDone(); });

				test('a keymap EXCHANGE that lands but reports an error: the shadow is kept, the swap is retried and completes (the store checks which half landed); the mirror equals the source',
					function (fDone)
					{
						let tmpInjected = 0;
						H.store.setFaultInjector(
							(pRequest) =>
							{
								if ((tmpInjected < 1) && (pRequest.Kind === 'Command') && /EXCHANGE TABLES/.test(String(pRequest.SQL || '')) && /_rfs_keys_Task/.test(String(pRequest.SQL || '')))
								{
									tmpInjected++;
									return { Status: 500, Text: 'Code: 999. DB::Exception: injected after the keymap EXCHANGE landed', When: 'After' };
								}
								return null;
							});
						H.fable.RetoldFacetingRebuilder.rebuild(STORE, 'Task', { Reason: 'Admin' },
							(pError, pResult) =>
							{
								H.store.setFaultInjector(null);
								Expect(pError || null).to.equal(null);
								Expect(tmpInjected).to.equal(1);
								Expect(pResult.State).to.equal('Live');
								H.quiesce(
									(pQuiesceError) =>
									{
										Expect(pQuiesceError || null).to.equal(null);
										libSupport.assertMirrorEqualsSource(H, STORE, 'Task', (pAssertError) => { return fDone(pAssertError || null); });
									});
							});
					});

				test('one dropped mirror table: the wipe recovery confirms which tables are gone and rebuilds only that entity',
					function (fDone)
					{
						let tmpMaterializer = H.materializer;
						let fBackfill = tmpMaterializer._backfill;
						let tmpBackfilled = [];
						tmpMaterializer._backfill = function (pStore, pEntity, ...pRest)
						{
							tmpBackfilled.push(pEntity);
							return fBackfill.call(this, pStore, pEntity, ...pRest);
						};
						let fRestore = () => { tmpMaterializer._backfill = fBackfill; };
						let tmpTask = null;
						series(
							[
								(fNext) => { H.store.command(libDDL.dropTableDDL(H.store.Database, 'Task'), null, null, fNext); },
								(fNext) => { tmpMaterializer.recoverWipe(STORE, () => { return fNext(); }); },
								(fNext) => { waitFor(() => { return tmpBackfilled.length > 0; }, 10000, fNext); },
								(fNext) => { waitFor(() => { return H.fable.RetoldFacetingFreshness.state(STORE, 'Task').State === 'Live'; }, 60000, fNext); },
								(fNext) => { H.quiesce(fNext, 60000); },
								(fNext) =>
								{
									Expect(tmpBackfilled, 'only the wiped entity').to.deep.equal([ 'Task' ]);
									rawRows(H, 'SELECT "IDTask" FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0 ORDER BY "IDTask" LIMIT 1', '', (pError, pRows) => { tmpTask = pRows ? Number(pRows[0].IDTask) : null; return fNext(pError || null); });
								},
								(fNext) => { rawSet(H, 'Task', 'Status', 'after-a-partial-wipe', 'IDTask', [ tmpTask ], [ 1 ], fNext); },
								(fNext) => { H.quiesce(fNext); },
								(fNext) => { libSupport.assertMirrorEqualsSource(H, STORE, 'Task', (pError) => { return fNext(pError || null); }); }
							],
							(pError) =>
							{
								fRestore();
								return fDone(pError || null);
							});
					});

				test('under a write stream (~50 writes/s for 3 s) each table gets a few inserts per flush interval and the keymap is read about once per cycle, not per write; the state table gets coalesced writes',
					function (fDone)
					{
						let tmpTasks = [];
						let tmpInserts = {};
						let tmpKeyReads = 0;
						H.store.setFaultInjector(
							(pRequest) =>
							{
								if (pRequest.Kind === 'Insert')
								{
									let tmpTable = String(pRequest.Table || '').split('.').pop().replace(/`/g, '');
									tmpInserts[tmpTable] = (tmpInserts[tmpTable] || 0) + 1;
								}
								else if ((pRequest.Kind === 'Query') && /_rfs_keys_Task`/.test(String(pRequest.SQL || '')) && /IN \{ids:/.test(String(pRequest.SQL || '')))
								{
									tmpKeyReads++;
								}
								return null;
							});
						let tmpWrites = 0;
						series(
							[
								(fNext) => { rawRows(H, 'SELECT "IDTask" FROM "Task" WHERE "IDCustomer" = 1 AND "Deleted" = 0 ORDER BY "IDTask" LIMIT 40', '', (pError, pRows) => { tmpTasks = (pRows || []).map((pRow) => { return Number(pRow.IDTask); }); return fNext(pError || null); }); },
								(fNext) =>
								{
									let tmpTimer = setInterval(
										() =>
										{
											tmpWrites++;
											rawSet(H, 'Task', 'Status', `stream-${tmpWrites}`, 'IDTask', [ tmpTasks[tmpWrites % tmpTasks.length] ], [ 1 ], () => {});
											if (tmpWrites >= 150)
											{
												clearInterval(tmpTimer);
												return fNext();
											}
										}, 20);
								},
								(fNext) => { H.quiesce(fNext); },
								(fNext) =>
								{
									H.store.setFaultInjector(null);
									Expect(tmpWrites).to.equal(150);
									// ~3 s of writes at a 1 s flush interval (+ quiesce's final flush): a handful, not ~150.
									Expect(tmpInserts.Task || 0, JSON.stringify(tmpInserts)).to.be.within(1, 10);
									Expect(tmpInserts._rfs_keys_Task || 0, JSON.stringify(tmpInserts)).to.be.at.most(10);
									Expect(tmpKeyReads, 'keymap reads').to.be.within(1, 10);
									Expect(tmpInserts._rfs_entity_state || 0, JSON.stringify(tmpInserts)).to.be.at.most(4);
									libSupport.assertMirrorEqualsSource(H, STORE, 'Task', (pError) => { return fNext(pError || null); });
								}
							], fDone);
					});

				test('the paced Scrub: an unknown row count scrubs ScrubUnknownTotalRowsPerTick (never the ceiling); the seeded row estimate paces it over the period',
					function (fDone)
					{
						let tmpReconciler = H.fable.RetoldFacetingReconciler;
						let tmpRecord = tmpReconciler._record(STORE, 'Task');
						let fScrub = tmpReconciler.scrub;
						let tmpCaps = [];
						tmpReconciler.scrub = (pStore, pEntity, pOptions, fCallback) => { tmpCaps.push(pOptions.Cap); return fCallback(null, {}); };
						tmpRecord.Total = null;
						tmpRecord.Owed = 0;
						tmpReconciler._scrubTick(STORE, 'Task');
						tmpReconciler.scrub = fScrub;
						Expect(tmpCaps, 'unknown total: the conservative pace').to.deep.equal([ Math.min(tmpReconciler.scrubTickCap(), 256) ]);
						tmpReconciler._seedTotal(STORE, 'Task');
						waitFor(() => { return tmpRecord.Total !== null; }, 5000,
							(pError) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(tmpRecord.Total).to.be.above(0);
								tmpCaps = [];
								tmpReconciler.scrub = (pStore, pEntity, pOptions, fCallback) => { tmpCaps.push(pOptions.Cap); return fCallback(null, {}); };
								tmpRecord.Owed = 0;
								tmpReconciler._scrubTick(STORE, 'Task');
								tmpReconciler.scrub = fScrub;
								// A few hundred rows over a day: nothing owed after one tick.
								Expect(tmpCaps).to.deep.equal([]);
								return fDone();
							});
					});

				test('capable() and the freshness read stay O(1) with a 90k-hint backlog (no Materializer.status() on the request path)',
					function ()
					{
						let tmpLoop = H.materializer.loop(STORE, 'Document');
						tmpLoop.halt('test');
						let tmpIDs = [];
						for (let i = 0; i < 90000; i++)
						{
							tmpIDs.push(1000000 + i);
						}
						Expect(H.materializer.enqueue(STORE, 'Document', tmpIDs, { Source: 'Admin' })).to.equal(90000);
						let tmpEngine = H.fable.RetoldFacetingEngineClickHouse;
						let tmpFreshness = H.fable.RetoldFacetingFreshness;
						Expect(tmpEngine.capable(null, { Mode: 'Query' })).to.deep.equal({ Capable: false, Reason: 'KindUnsupported:None' });
						let tmpStart = process.hrtime.bigint();
						for (let i = 0; i < 2000; i++)
						{
							tmpEngine.capable(null, { Mode: 'Query' });
							tmpFreshness.entityFreshness(STORE, 'Document', Date.now());
						}
						let tmpPerCall = Number(process.hrtime.bigint() - tmpStart) / 1000 / 2000;
						Expect(tmpPerCall, `${tmpPerCall.toFixed(1)} µs per capable() + entityFreshness()`).to.be.below(250);
					});
			}
		);

		// ------------------------------------------------------------------ PostgreSQL: the naive timestamp text
		suite
		(
			'PostgreSQL: the materializer reads timestamps as the naive text, whatever the process time zone',
			function ()
			{
				if (!PG_GATE.Available)
				{
					test.skip(`PostgreSQL-gated: ${PG_GATE.Reason}`, () => {});
					return;
				}
				this.timeout(120000);
				let H = null;

				suiteSetup((fDone) => { H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: 'PostgreSQL' }, (pError) => { return fDone(pError || undefined); }); });
				suiteTeardown((fDone) => { return H ? H.stop(() => { return fDone(); }) : fDone(); });

				test('readRows / readRange under TZ=America/New_York return the stored wall clock (with microseconds), not a shifted JS Date',
					function (fDone)
					{
						let tmpSource = H.fable.RetoldFacetingMaterializeSourceInProcess;
						H.connection.pool.query('SELECT "IDTask", to_char("DueDate", \'YYYY-MM-DD HH24:MI:SS.US\') AS "T" FROM "Task" WHERE "DueDate" IS NOT NULL ORDER BY "IDTask" LIMIT 3', [],
							(pError, pResult) =>
							{
								Expect(pError || null).to.equal(null);
								let tmpExpected = {};
								pResult.rows.forEach((pRow) => { tmpExpected[Number(pRow.IDTask)] = pRow.T; });
								Expect(Object.keys(tmpExpected).length).to.equal(3);
								let tmpZone = process.env.TZ;
								process.env.TZ = 'America/New_York';
								let fRestoreZone = () =>
								{
									if (typeof(tmpZone) === 'undefined')
									{
										delete process.env.TZ;
									}
									else
									{
										process.env.TZ = tmpZone;
									}
								};
								tmpSource.readRows('Task', Object.keys(tmpExpected).map(Number), { Columns: [ 'IDTask', 'DueDate' ] },
									(pReadError, pRows) =>
									{
										tmpSource.readRange('Task', null, 3, { Columns: [ 'IDTask', 'DueDate' ] },
											(pRangeError, pRangeRows) =>
											{
												fRestoreZone();
												Expect(pReadError || null).to.equal(null);
												Expect(pRangeError || null).to.equal(null);
												Expect(pRows.length).to.equal(3);
												pRows.forEach((pRow) => { Expect(pRow.DueDate, `IDTask ${pRow.IDTask}`).to.equal(tmpExpected[Number(pRow.IDTask)]); });
												pRangeRows.forEach((pRow) => { Expect((typeof(pRow.DueDate) === 'string') || (pRow.DueDate === null), `IDTask ${pRow.IDTask}`).to.equal(true); });
												return fDone();
											});
									});
							});
					});
			}
		);
	}
);
