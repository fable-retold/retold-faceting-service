/**
 * Facet-Store-ClickHouse (internal-contracts §54, §56, §57, §66.2; builder A; port 19141): the
 * ClickHouse client, the type map, the DDL and the store's write side.
 *
 *   always (no server)  the client's parameter rendering, validation, 64-bit normalization and error
 *                       shape (also against a fake HTTP server: headers, URL, fault injection, retries),
 *                       TypeMap (every row of §56.3, every Lossy case, quarantine), DDL text goldens for a
 *                       Tenant, a Personal, a Global and an Unscoped entity, names, the store's
 *                       feature-not-boot configuration
 *   gated               (RFS_TEST_CLICKHOUSE=1 or RFS_TEST_CLICKHOUSE_URL: `npm run test:ch`) every
 *                       store-contract method against the rfs-test-clickhouse container, the static
 *                       loader and the O10 invariant on the SQLite fixtures (and on PostgreSQL with both
 *                       gates on)
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;
const libHttp = require('http');

const libClickHouseClient = require('../source/store/clickhouse/ClickHouse-Client.js');
const libTypeMap = require('../source/store/clickhouse/ClickHouse-TypeMap.js');
const libDDL = require('../source/store/clickhouse/ClickHouse-DDL.js');
const libStoreBase = require('../source/store/Retold-Faceting-StoreBase.js');
const libStore = require('../source/store/clickhouse/Retold-Faceting-StoreClickHouse.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libHarness = require('./support/Facet-Test-Harness.js');

const CLICKHOUSE = libSupport.available();
const POSTGRES = libProviders.available('PostgreSQL');

const gatedSuite = (pReady) =>
{
	return pReady ? suite : suite.skip;
};

// ---------------------------------------------------------------- hand-built specs (§55.2 shape)

const DATETIME = "Nullable(DateTime64(3, 'UTC'))";

// A Tenant entity (ProjectTrack-like).
const SPEC_TENANT = Object.freeze(
	{
		Entity: 'Project', Store: 'ClickHouse', Identity: 'IDProject', Kind: 'Tenant', TenantColumn: 'IDCustomer', OwnerColumn: null, DeleteColumn: 'Deleted',
		SortKey: [ 'IDCustomer', 'IDProject' ],
		Columns:
		[
			{ Column: 'IDProject', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
			{ Column: 'IDCustomer', DataType: 'Numeric', Mirror: 'Int64', Role: 'Tenant', Join: 'IDCustomer' },
			{ Column: 'UpdateDate', DataType: 'DateTime', Mirror: DATETIME, Role: 'Column' },
			{ Column: 'Deleted', DataType: 'Boolean', Mirror: 'Nullable(UInt8)', Role: 'Delete' },
			{ Column: 'IDClient', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDClient' },
			{ Column: 'Status', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' },
			{ Column: 'Budget', DataType: 'Decimal', Mirror: 'Nullable(Float64)', Role: 'Column' }
		],
		KeymapColumns: [ 'IDProject', 'IDCustomer', 'IDClient', 'UpdateDate' ],
		TrackedKeyColumns: [ 'IDCustomer', 'IDClient' ],
		UnsetValues: [ 0, '', null ],
		SpecHash: 'ms:0a0a0a0a'
	});

// A Personal entity (the LabForm example of §56.2, trimmed).
const SPEC_PERSONAL = Object.freeze(
	{
		Entity: 'LabForm', Store: 'ClickHouse', Identity: 'IDLabForm', Kind: 'Personal', TenantColumn: 'IDCustomer', OwnerColumn: 'OwnerIDUser', DeleteColumn: 'Deleted',
		SortKey: [ 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ],
		Columns:
		[
			{ Column: 'IDLabForm', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
			{ Column: 'IDCustomer', DataType: 'Numeric', Mirror: 'Int64', Role: 'Tenant' },
			{ Column: 'OwnerIDUser', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'Owner', Join: 'IDUser' },
			{ Column: 'UpdateDate', DataType: 'DateTime', Mirror: DATETIME, Role: 'Watermark' },
			{ Column: 'Deleted', DataType: 'Boolean', Mirror: 'Nullable(UInt8)', Role: 'Delete' },
			{ Column: 'IDMaterialIntake', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDMaterialIntake' },
			{ Column: 'Status', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' },
			{ Column: 'Score', DataType: 'Decimal', Mirror: 'Nullable(Float64)', Role: 'Column' },
			{ Column: 'CompletedDate', DataType: 'DateTime', Mirror: DATETIME, Role: 'Column' }
		],
		KeymapColumns: [ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'UpdateDate' ],
		TrackedKeyColumns: [ 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake' ],
		UnsetValues: [ 0, '', null ],
		SpecHash: 'ms:0b0b0b0b'
	});

// A Global entity (a lookup: no tenant, no delete column).
const SPEC_GLOBAL = Object.freeze(
	{
		Entity: 'FormType', Store: 'ClickHouse', Identity: 'IDFormType', Kind: 'Global', TenantColumn: null, OwnerColumn: null, DeleteColumn: null,
		SortKey: [ 'IDFormType' ],
		Columns:
		[
			{ Column: 'IDFormType', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
			{ Column: 'Name', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' }
		],
		KeymapColumns: [ 'IDFormType' ],
		TrackedKeyColumns: [],
		UnsetValues: [ 0, '', null ],
		SpecHash: 'ms:0c0c0c0c'
	});

// An Unscoped entity (no policy: the Bookstore).
const SPEC_UNSCOPED = Object.freeze(
	{
		Entity: 'Book', Store: 'ClickHouse', Identity: 'IDBook', Kind: 'Unscoped', TenantColumn: null, OwnerColumn: null, DeleteColumn: 'Deleted',
		SortKey: [ 'IDBook' ],
		Columns:
		[
			{ Column: 'IDBook', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' },
			{ Column: 'UpdateDate', DataType: 'DateTime', Mirror: DATETIME, Role: 'Column' },
			{ Column: 'Deleted', DataType: 'Boolean', Mirror: 'Nullable(UInt8)', Role: 'Delete' },
			{ Column: 'Title', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' },
			{ Column: 'PublicationYear', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'Column' }
		],
		KeymapColumns: [ 'IDBook', 'UpdateDate' ],
		TrackedKeyColumns: [],
		UnsetValues: [ 0, '', null ],
		SpecHash: 'ms:0d0d0d0d'
	});

// ---------------------------------------------------------------- helpers

/**
 * A fake ClickHouse HTTP server that records requests and answers with fRespond.
 *
 * @param {(pRequest: Record<string, any>) => { Status?: number, Body?: string, Headers?: Record<string, string> }} fRespond
 * @param {(pServer: Record<string, any>) => void} fReady
 */
const fakeServer = (fRespond, fReady) =>
{
	let tmpRecorded = [];
	let tmpServer = libHttp.createServer(
		(pRequest, pResponse) =>
		{
			let tmpChunks = [];
			pRequest.on('data', (pChunk) => { tmpChunks.push(pChunk); });
			pRequest.on('end', () =>
			{
				let tmpURL = new URL(pRequest.url, 'http://127.0.0.1');
				let tmpRecord = { Method: pRequest.method, Path: tmpURL.pathname, Query: Object.fromEntries(tmpURL.searchParams.entries()), RawURL: pRequest.url, Headers: pRequest.headers, Body: Buffer.concat(tmpChunks).toString('utf8') };
				tmpRecorded.push(tmpRecord);
				let tmpAnswer = fRespond(tmpRecord) || {};
				pResponse.writeHead(tmpAnswer.Status || 200, Object.assign({ 'Content-Type': 'text/plain' }, tmpAnswer.Headers || {}));
				pResponse.end(tmpAnswer.Body || '');
			});
		});
	tmpServer.listen(0, '127.0.0.1', () =>
	{
		fReady({ Server: tmpServer, URL: `http://127.0.0.1:${tmpServer.address().port}`, Requests: tmpRecorded, close: (fDone) => { tmpServer.close(() => { return fDone(); }); tmpServer.closeAllConnections(); } });
	});
};

/**
 * A store service on a quiet fable (logs captured).
 *
 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
 * @return {{ Store: any, Logged: Array<string> }}
 */
const newStore = (pOptions) =>
{
	let tmpFable = libBuilders.newFable('RetoldFacetingStoreTests');
	let tmpLogged = [];
	[ 'error', 'warn', 'info' ].forEach((pLevel) => { tmpFable.log[pLevel] = (pMessage) => { tmpLogged.push(`${pLevel}: ${String(pMessage)}`); }; });
	return { Store: new libStore(tmpFable, pOptions || {}), Logged: tmpLogged };
};

/**
 * Run (pError) => … steps in order.
 *
 * @param {Array<Function>} pSteps
 * @param {Function} fDone
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
			tmpStep(fNext);
		}
		catch (pThrown)
		{
			return fDone(pThrown);
		}
	};
	fNext(null);
};

suite
(
	'Facet-Store-ClickHouse',
	() =>
	{
		suite
		(
			'Client (no server)',
			() =>
			{
				test('an unreachable server pings false without an error (feature-not-boot); a statement is a retryable network error',
					(fDone) =>
					{
						// Port 1 on loopback: refused at once.
						let tmpClient = new libClickHouseClient({ URL: 'http://127.0.0.1:1', PingTimeoutMS: 500 });
						tmpClient.ping(
							(pError, pUp) =>
							{
								Expect(pError).to.equal(null);
								Expect(pUp).to.equal(false);
								tmpClient.query('SELECT 1', null, null,
									(pQueryError) =>
									{
										Expect(pQueryError).to.include({ StoreError: true, Status: 0, Retryable: true, Code: null, NetworkCode: 'ECONNREFUSED' });
										return fDone();
									});
							});
					});

				test('formatParam: NULL, numbers, bigints, booleans, strings in the Escaped format, Dates, arrays with quotes / backslashes / NULL / nesting; non-finite numbers refused',
					() =>
					{
						let tmpClient = new libClickHouseClient({ URL: 'http://127.0.0.1:18123' });
						Expect(tmpClient.formatParam(null)).to.equal('\\N');
						Expect(tmpClient.formatParam(undefined)).to.equal('\\N');
						Expect(tmpClient.formatParam(-7)).to.equal('-7');
						Expect(tmpClient.formatParam(5.94)).to.equal('5.94');
						Expect(tmpClient.formatParam(BigInt('9007199254740993'))).to.equal('9007199254740993');
						Expect(tmpClient.formatParam(false)).to.equal('0');
						// A scalar {p:String} is parsed as Escaped text: every backslash doubled, TAB / LF / CR / NUL as escapes
						// (raw, `C:\temp` would arrive as C:<TAB>emp and `\N` as NULL); a quote needs nothing.
						Expect(tmpClient.formatParam("it's \\ raw")).to.equal("it's \\\\ raw");
						Expect(tmpClient.formatParam('C:\\temp')).to.equal('C:\\\\temp');
						Expect(tmpClient.formatParam('\\N')).to.equal('\\\\N');
						Expect(tmpClient.formatParam('trailing\\')).to.equal('trailing\\\\');
						Expect(tmpClient.formatParam('a\tb\nc\rd\u0000e')).to.equal('a\\tb\\nc\\rd\\0e');
						Expect(tmpClient.formatParam(new Date(Date.UTC(2023, 0, 2, 3, 4, 5, 6)))).to.equal('2023-01-02 03:04:05.006');
						Expect(tmpClient.formatParam([])).to.equal('[]');
						Expect(tmpClient.formatParam([ 1, -2, 3.5 ])).to.equal('[1,-2,3.5]');
						Expect(tmpClient.formatParam([ "a'b", 'c\\d', null, true ])).to.equal("['a\\'b','c\\\\d',NULL,1]");
						Expect(tmpClient.formatParam([ [ 1, 2 ], [ 3 ] ])).to.equal('[[1,2],[3]]');
						Expect(() => { return tmpClient.formatParam(NaN); }).to.throw(/non-finite/);
						Expect(() => { return tmpClient.formatParam([ 1, Infinity ]); }).to.throw(/non-finite/);
					});

				test('constructor: credentials, paths, queries, other schemes and bad database names are refused; Database null sends none',
					() =>
					{
						Expect(() => { return new libClickHouseClient({ URL: 'http://user:pw@127.0.0.1:18123' }); }).to.throw(/credentials/);
						Expect(() => { return new libClickHouseClient({ URL: 'http://127.0.0.1:18123/db' }); }).to.throw(/origin/);
						Expect(() => { return new libClickHouseClient({ URL: 'http://127.0.0.1:18123/?user=x' }); }).to.throw(/origin/);
						Expect(() => { return new libClickHouseClient({ URL: 'ftp://127.0.0.1' }); }).to.throw(/http/);
						Expect(() => { return new libClickHouseClient({ URL: 'http://127.0.0.1', Database: 'bad-name' }); }).to.throw(/database/);
						Expect(new libClickHouseClient({ URL: 'http://127.0.0.1', Database: null }).Database).to.equal(null);
						Expect(new libClickHouseClient({ URL: 'http://127.0.0.1' }).Database).to.equal('default');
						Expect(new libClickHouseClient({ URL: 'https://[::1]:8443' })._Host).to.equal('::1');
					});

				test('invalid parameter and setting names, object settings and empty statements fail before anything is sent (not retryable)',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: 'http://127.0.0.1:1' });
						let tmpSent = 0;
						tmpClient.setFaultInjector(() => { tmpSent++; return null; });
						series(
							[
								(fNext) => { tmpClient.query('SELECT {a:Int64}', { 'a-b': 1 }, null, (pError) => { Expect(pError.message).to.match(/invalid parameter name/); Expect(pError.Retryable).to.equal(false); return fNext(); }); },
								(fNext) => { tmpClient.query('SELECT 1', null, { 'Max_Threads': 1 }, (pError) => { Expect(pError.message).to.match(/invalid setting name/); return fNext(); }); },
								(fNext) => { tmpClient.query('SELECT 1', null, { max_threads: { a: 1 } }, (pError) => { Expect(pError.message).to.match(/scalar/); return fNext(); }); },
								(fNext) => { tmpClient.command('  ', null, null, (pError) => { Expect(pError.message).to.match(/empty statement/); return fNext(); }); },
								(fNext) => { tmpClient.insert('nope', [ { a: 1 } ], {}, (pError) => { Expect(pError.message).to.match(/qualified table/); return fNext(); }); },
								(fNext) => { tmpClient.insert('`d`.`t`', [ { a: 1 } ], { Query: 'INSERT INTO `d`.`other` FORMAT JSONEachRow' }, (pError) => { Expect(pError.message).to.match(/insert Query/); return fNext(); }); },
								(fNext) => { tmpClient.insert('`d`.`t`', [], {}, (pError, pCount) => { Expect(pError).to.equal(null); Expect(pCount).to.equal(0); return fNext(); }); }
							],
							(pError) =>
							{
								Expect(tmpSent).to.equal(0);
								return fDone(pError);
							});
					});

				test('64-bit normalization from the meta: safe Int64 / UInt64 (Nullable, LowCardinality, arrays) become numbers; unsafe ones stay decimal text; other columns untouched',
					() =>
					{
						let tmpRows = libClickHouseClient.normalizeRows(
							[ { A: '42', B: '18446744073709551615', C: null, D: '-9007199254740991', E: [ '1', '9007199254740993' ], F: '7', G: '3', H: 'inf' } ],
							[ { name: 'A', type: 'UInt64' }, { name: 'B', type: 'UInt64' }, { name: 'C', type: 'Nullable(Int64)' }, { name: 'D', type: 'LowCardinality(Nullable(Int64))' },
								{ name: 'E', type: 'Array(Int64)' }, { name: 'F', type: 'String' }, { name: 'G', type: 'Int128' }, { name: 'H', type: 'Float64' } ]);
						Expect(tmpRows).to.deep.equal([ { A: 42, B: '18446744073709551615', C: null, D: -9007199254740991, E: [ 1, '9007199254740993' ], F: '7', G: 3, H: 'inf' } ]);
						Expect(libClickHouseClient.normalizeRows([ { A: 1 } ], [])).to.deep.equal([ { A: 1 } ]);
					});

				test('errors: code, name, status and retryability parsed; detail kept only for codes that never echo a value; inserts never carry detail; the password is redacted',
					() =>
					{
						let tmpClient = new libClickHouseClient({ URL: 'http://127.0.0.1:18123', Password: 'S3cret-Pw' });
						let tmpUnknown = tmpClient._error(404, 'x', "Code: 60. DB::Exception: Unknown table expression identifier 'db.nope' in scope SELECT * FROM db.nope. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))", 'Query', null);
						Expect(tmpUnknown).to.include({ StoreError: true, Status: 404, Code: 60, Name: 'UNKNOWN_TABLE', Retryable: false });
						Expect(tmpUnknown.message).to.match(/^ClickHouse 404: Code: 60\. DB::Exception: Unknown table/);
						let tmpParam = tmpClient._error(500, 'x', "Code: 457. DB::Exception: Value secret-value cannot be parsed as Int64 for query parameter 'a'. (BAD_QUERY_PARAMETER) (version 24.8.14.39 (official build))", 'Query', null);
						Expect(tmpParam).to.include({ Code: 457, Name: 'BAD_QUERY_PARAMETER', Retryable: false });
						Expect(tmpParam.message).to.not.contain('secret-value');
						Expect(tmpParam.message).to.match(/detail withheld/);
						let tmpInsert = tmpClient._error(400, 'x', 'Code: 27. DB::Exception: Cannot parse input: row {"Name":"private"}. (CANNOT_PARSE_INPUT_ASSERTION_FAILED)', 'Insert', null);
						Expect(tmpInsert.message).to.not.contain('private');
						Expect(tmpInsert.Code).to.equal(27);
						let tmpBusy = tmpClient._error(503, 'x', 'Code: 202. DB::Exception: Too many simultaneous queries. (TOO_MANY_SIMULTANEOUS_QUERIES)', 'Query', null);
						Expect(tmpBusy.Retryable).to.equal(true);
						Expect(tmpClient._error(500, 'x', 'Injected failure.', 'Insert', null).Retryable).to.equal(true);
						Expect(tmpClient._error(400, 'x', 'Code: 62. Syntax error', 'Query', null).Retryable).to.equal(false);
						// The exception code header wins over the text.
						Expect(tmpClient._error(500, 'x', 'Something', 'Query', 159).Code).to.equal(159);
						// A JSON body with an exception (a failure mid-stream).
						Expect(tmpClient._error(500, 'x', JSON.stringify({ meta: [], exception: 'Code: 396. DB::Exception: Limit for result exceeded. (TOO_MANY_ROWS_OR_BYTES)' }), 'Query', null)).to.include({ Code: 396, Name: 'TOO_MANY_ROWS_OR_BYTES' });
						// The password never survives into a message.
						let tmpAuth = tmpClient._error(516, 'x', 'Code: 516. DB::Exception: rfs_test: Authentication failed: password S3cret-Pw is incorrect. (AUTHENTICATION_FAILED)', 'Query', null);
						Expect(tmpAuth.message).to.not.contain('S3cret-Pw');
						Expect(tmpAuth.message).to.contain('<redacted>');
						Expect(libClickHouseClient.redact('a S3cret-Pw b S3cret-Pw', 'S3cret-Pw')).to.equal('a <redacted> b <redacted>');
						Expect(libClickHouseClient.exceptionText('{"meta":[],"data":[{"a":1}\nCode: 241. DB::Exception: Memory limit (MEMORY_LIMIT_EXCEEDED)')).to.match(/^Code: 241\./);
					});
			}
		);

		suite
		(
			'Client against a fake HTTP server (no ClickHouse)',
			() =>
			{
				let _Fake = null;
				let _Answers = [];

				suiteSetup(
					(fDone) =>
					{
						fakeServer(
							(pRequest) =>
							{
								if (pRequest.Path === '/ping')
								{
									return { Body: 'Ok.\n' };
								}
								let tmpAnswer = _Answers.shift();
								return tmpAnswer || { Body: JSON.stringify({ meta: [ { name: 'N', type: 'UInt64' } ], data: [ { N: '3' } ] }) };
							},
							(pFake) =>
							{
								_Fake = pFake;
								return fDone();
							});
					});

				suiteTeardown((fDone) => { _Fake.close(fDone); });
				setup(() => { _Fake.Requests.length = 0; _Answers = []; });

				test('credentials travel in headers only; settings, parameters and the database are URL parameters; Database null sends none',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: _Fake.URL, User: 'rfs_test', Password: 'pw-123', Database: null, Settings: { max_threads: 2 } });
						tmpClient.query('SELECT {a:String} AS S', { a: "it's & = ?" }, { max_execution_time: 3, flag: true },
							(pError, pRows, pMeta) =>
							{
								Expect(pError).to.equal(null);
								Expect(pRows).to.deep.equal([ { N: 3 } ]);
								Expect(pMeta).to.deep.equal([ { name: 'N', type: 'UInt64' } ]);
								let tmpRequest = _Fake.Requests[0];
								Expect(tmpRequest.Headers['x-clickhouse-user']).to.equal('rfs_test');
								Expect(tmpRequest.Headers['x-clickhouse-key']).to.equal('pw-123');
								Expect(tmpRequest.RawURL).to.not.contain('pw-123');
								Expect(tmpRequest.Query).to.not.have.property('database');
								Expect(tmpRequest.Query).to.include({ param_a: "it's & = ?", max_threads: '2', max_execution_time: '3', flag: '1', default_format: 'JSON', output_format_json_quote_64bit_integers: '1' });
								Expect(tmpRequest.Body).to.equal('SELECT {a:String} AS S');
								let tmpWithDatabase = new libClickHouseClient({ URL: _Fake.URL, Database: 'rfs_x' });
								tmpWithDatabase.command('SELECT 1', null, null,
									(pCommandError) =>
									{
										Expect(pCommandError).to.equal(null);
										Expect(_Fake.Requests[1].Query.database).to.equal('rfs_x');
										// Ping is unauthenticated GET /ping.
										tmpClient.ping((pPingError, pUp) => { Expect(pUp).to.equal(true); Expect(_Fake.Requests[2].Headers).to.not.have.property('x-clickhouse-key'); tmpClient.close(); return fDone(); });
									});
							});
					});

				test('insert: JSONEachRow body, the INSERT query and the dedup token in the URL, insert_deduplicate on',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: _Fake.URL, Database: null });
						tmpClient.insert('`rfs_1_1`.`Project`', [ { IDProject: 1, Status: 'a' }, { IDProject: 2, Status: null } ], { Token: 'Project:100:Live:M0' },
							(pError, pCount) =>
							{
								Expect(pError).to.equal(null);
								Expect(pCount).to.equal(2);
								let tmpRequest = _Fake.Requests[0];
								Expect(tmpRequest.Query).to.include({ query: 'INSERT INTO `rfs_1_1`.`Project` FORMAT JSONEachRow', insert_deduplication_token: 'Project:100:Live:M0', insert_deduplicate: '1' });
								Expect(tmpRequest.Body.split('\n').map((pLine) => { return JSON.parse(pLine); })).to.deep.equal([ { IDProject: 1, Status: 'a' }, { IDProject: 2, Status: null } ]);
								return fDone();
							});
					});

				test('a 200 whose body ends in an exception, and a JSON exception member, are errors with the code',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: _Fake.URL });
						_Answers.push({ Body: '{"meta":[{"name":"N","type":"UInt64"}],"data":[{"N":"1"},\nCode: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED)' });
						_Answers.push({ Body: JSON.stringify({ meta: [], data: [], exception: 'Code: 396. DB::Exception: Limit for result exceeded, max rows: 3. (TOO_MANY_ROWS_OR_BYTES)' }) });
						_Answers.push({ Status: 500, Headers: { 'X-ClickHouse-Exception-Code': '159' }, Body: 'Code: 159. DB::Exception: Timeout exceeded. (TIMEOUT_EXCEEDED)' });
						tmpClient.query('SELECT 1', null, null,
							(pError) =>
							{
								Expect(pError).to.include({ StoreError: true, Code: 241 });
								tmpClient.query('SELECT 1', null, null,
									(pSecondError) =>
									{
										Expect(pSecondError).to.include({ Code: 396, Name: 'TOO_MANY_ROWS_OR_BYTES', Retryable: false });
										tmpClient.query('SELECT 1', null, null,
											(pThirdError) =>
											{
												Expect(pThirdError).to.include({ Code: 159, Status: 500, Retryable: true });
												return fDone();
											});
									});
							});
					});

				test('fault injector: Before fails without sending, After sends then reports a 500, Error is a network error; each call sees Kind / SQL / Table / Token / Attempt',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: _Fake.URL });
						let tmpSeen = [];
						let tmpPlan = [ { Status: 500, When: 'Before' }, { Status: 503, When: 'After' }, { Error: new Error('wire cut') }, null ];
						tmpClient.setFaultInjector((pRequest) => { tmpSeen.push(pRequest); return tmpPlan.shift(); });
						series(
							[
								(fNext) => { tmpClient.command('SELECT 1', null, null, (pError) => { Expect(pError).to.include({ Status: 500, Retryable: true }); Expect(_Fake.Requests).to.have.length(0); return fNext(); }); },
								(fNext) => { tmpClient.command('SELECT 2', null, null, (pError) => { Expect(pError).to.include({ Status: 503 }); Expect(_Fake.Requests).to.have.length(1); return fNext(); }); },
								(fNext) => { tmpClient.query('SELECT 3', null, null, (pError) => { Expect(pError).to.include({ Status: 0, Retryable: true }); Expect(pError.message).to.match(/wire cut/); return fNext(); }); },
								(fNext) => { tmpClient.insert('`d`.`t`', [ { a: 1 } ], { Token: 'T1' }, (pError) => { Expect(pError).to.equal(null); return fNext(); }); }
							],
							(pError) =>
							{
								Expect(tmpSeen.map((pRequest) => { return pRequest.Kind; })).to.deep.equal([ 'Command', 'Command', 'Query', 'Insert' ]);
								Expect(tmpSeen[0]).to.include({ SQL: 'SELECT 1', Attempt: 1, Sequence: 1 });
								Expect(tmpSeen[3]).to.include({ Table: '`d`.`t`', Token: 'T1', Attempt: 1, Sequence: 4 });
								Expect(tmpClient.stats()).to.include({ Requests: 4, Errors: 3 });
								return fDone(pError);
							});
					});

				test('an insert with a token is retried with the SAME token after a retryable failure; without a token it is never retried; a deterministic error is not retried',
					(fDone) =>
					{
						let tmpClient = new libClickHouseClient({ URL: _Fake.URL, RetryDelayMS: 1 });
						let tmpFaults = 0;
						let tmpAttempts = [];
						tmpClient.setFaultInjector((pRequest) => { tmpAttempts.push(pRequest.Attempt); if ((pRequest.Kind === 'Insert') && (tmpFaults < 1)) { tmpFaults++; return { Status: 500, When: 'After' }; } return null; });
						tmpClient.insert('`d`.`t`', [ { a: 1 } ], { Token: 'T-retry', Retries: 2 },
							(pError, pCount) =>
							{
								Expect(pError).to.equal(null);
								Expect(pCount).to.equal(1);
								Expect(_Fake.Requests.map((pRequest) => { return pRequest.Query.insert_deduplication_token; })).to.deep.equal([ 'T-retry', 'T-retry' ]);
								Expect(tmpAttempts).to.deep.equal([ 1, 2 ]);
								_Fake.Requests.length = 0;
								tmpFaults = 0;
								tmpClient.insert('`d`.`t`', [ { a: 1 } ], { Retries: 2 },
									(pNoTokenError) =>
									{
										Expect(pNoTokenError).to.include({ Status: 500, Attempts: 1 });
										Expect(_Fake.Requests).to.have.length(1);
										_Fake.Requests.length = 0;
										tmpClient.setFaultInjector(null);
										_Answers.push({ Status: 500, Body: 'Code: 27. DB::Exception: Cannot parse input (CANNOT_PARSE_INPUT_ASSERTION_FAILED)' });
										tmpClient.insert('`d`.`t`', [ { a: 1 } ], { Token: 'T-bad', Retries: 2 },
											(pDeterministicError) =>
											{
												Expect(pDeterministicError).to.include({ Code: 27, Retryable: false, Attempts: 1 });
												Expect(_Fake.Requests).to.have.length(1);
												return fDone();
											});
									});
							});
					});
			}
		);

		suite
		(
			'TypeMap (§56.3)',
			() =>
			{
				test('mirrorType: every DataType and role; Text / JSON / unknown are not mirrored',
					() =>
					{
						Expect(libTypeMap.mirrorType({ DataType: 'ID', IsInteger: true }, 'Identity')).to.equal('Int64');
						Expect(libTypeMap.mirrorType({ DataType: 'String' }, 'Identity')).to.equal(null);
						Expect(libTypeMap.mirrorType({ DataType: 'Numeric', IsInteger: true }, 'Tenant')).to.equal('Int64');
						Expect(libTypeMap.mirrorType({ DataType: 'String' }, 'Tenant')).to.equal('String');
						Expect(libTypeMap.mirrorType({ DataType: 'Numeric', IsInteger: true }, 'Owner')).to.equal('Nullable(Int64)');
						Expect(libTypeMap.mirrorType({ DataType: 'ForeignKey' }, 'FK')).to.equal('Nullable(Int64)');
						Expect(libTypeMap.mirrorType({ DataType: 'Numeric', IsInteger: false })).to.equal('Nullable(Float64)');
						Expect(libTypeMap.mirrorType({ DataType: 'Decimal', Scale: 2 })).to.equal('Nullable(Float64)');
						Expect(libTypeMap.mirrorType({ DataType: 'String', Size: '128' })).to.equal('Nullable(String)');
						Expect(libTypeMap.mirrorType({ DataType: 'DateTime' })).to.equal("Nullable(DateTime64(3, 'UTC'))");
						Expect(libTypeMap.mirrorType({ DataType: 'Boolean', IsInteger: true }, 'Delete')).to.equal('Nullable(UInt8)');
						Expect(libTypeMap.mirrorType({ DataType: 'GUID' })).to.equal('Nullable(String)');
						[ 'Text', 'JSON', 'JSONProxy', 'Blob', null ].forEach((pType) => { Expect(libTypeMap.mirrorType({ DataType: pType }), String(pType)).to.equal(null); });
						Expect(libTypeMap.mirrorType(null)).to.equal(null);
						Expect(libTypeMap.baseType('Nullable(Int64)')).to.equal('Int64');
						Expect(libTypeMap.paramType("Nullable(DateTime64(3, 'UTC'))")).to.equal("DateTime64(3, 'UTC')");
						Expect(libTypeMap.isNullableType('Int64')).to.equal(false);
					});

				test('integers: safe numbers, bigints and canonical integer text; SQLite \'\' / \' \' / text, fractions and unsafe magnitudes are NULL + Value',
					() =>
					{
						let tmpColumn = { Column: 'BookCount', Mirror: 'Nullable(Int64)' };
						Expect(libTypeMap.toStoreValue(tmpColumn, 12, 'SQLite')).to.deep.equal({ Value: 12, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, -0, 'SQLite')).to.deep.equal({ Value: 0, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, BigInt(42), 'PostgreSQL')).to.deep.equal({ Value: 42, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '9007199254740991', 'PostgreSQL')).to.deep.equal({ Value: 9007199254740991, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, null, 'SQLite')).to.deep.equal({ Value: null, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, undefined, 'SQLite')).to.deep.equal({ Value: null, Lossy: null });
						[ '', ' ', 'abc', '007', '1.5', 4.5, 9007199254740993, BigInt('9007199254740993'), '9007199254740993', true, Buffer.from('1'), Infinity ].forEach(
							(pValue) => { Expect(libTypeMap.toStoreValue(tmpColumn, pValue, 'SQLite'), String(pValue)).to.deep.equal({ Value: null, Lossy: 'Value' }); });
						// From a catalog ColumnInfo (no Mirror) the DataType decides.
						Expect(libTypeMap.toStoreValue({ DataType: 'ForeignKey' }, '7', 'PostgreSQL')).to.deep.equal({ Value: 7, Lossy: null });
					});

				test('decimals: numbers as is (499.996 stays exact), PostgreSQL numeric text parsed; more than 15 significant digits, non-numeric text and non-finite are NULL + Value',
					() =>
					{
						let tmpColumn = { Column: 'TotalAmount', Mirror: 'Nullable(Float64)' };
						Expect(libTypeMap.toStoreValue(tmpColumn, 499.996, 'SQLite')).to.deep.equal({ Value: 499.996, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, 8.4, 'SQLite').Value).to.equal(8.4);
						Expect(libTypeMap.toStoreValue(tmpColumn, '499.996', 'PostgreSQL')).to.deep.equal({ Value: 499.996, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '12.50', 'PostgreSQL')).to.deep.equal({ Value: 12.5, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '-0.000000000000001', 'PostgreSQL').Value).to.equal(-1e-15);
						Expect(libTypeMap.toStoreValue(tmpColumn, '123456789012345', 'PostgreSQL').Value).to.equal(123456789012345);
						Expect(libTypeMap.toStoreValue(tmpColumn, '1000000000000000000000', 'PostgreSQL').Value).to.equal(1e21);
						Expect(libTypeMap.toStoreValue(tmpColumn, BigInt(5), 'PostgreSQL')).to.deep.equal({ Value: 5, Lossy: null });
						[ '1234567890.123456', '0.1234567890123456', '', ' ', 'x', NaN, Infinity, false ].forEach(
							(pValue) => { Expect(libTypeMap.toStoreValue(tmpColumn, pValue, 'PostgreSQL'), String(pValue)).to.deep.equal({ Value: null, Lossy: 'Value' }); });
					});

				test('strings (Buffers as UTF-8) and booleans (true / 1 / \'1\' / \'true\' and their negatives; anything else NULL + Value)',
					() =>
					{
						let tmpString = { Column: 'Status', Mirror: 'Nullable(String)' };
						Expect(libTypeMap.toStoreValue(tmpString, '', 'SQLite')).to.deep.equal({ Value: '', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpString, 'Sci~Fi', 'SQLite')).to.deep.equal({ Value: 'Sci~Fi', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpString, Buffer.from('héllo', 'utf8'), 'SQLite')).to.deep.equal({ Value: 'héllo', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpString, 12, 'SQLite')).to.deep.equal({ Value: '12', Lossy: null });
						let tmpBoolean = { Column: 'Deleted', Mirror: 'Nullable(UInt8)' };
						[ true, 1, '1', BigInt(1) ].forEach((pValue) => { Expect(libTypeMap.toStoreValue(tmpBoolean, pValue, 'SQLite'), String(pValue)).to.deep.equal({ Value: 1, Lossy: null }); });
						[ false, 0, '0', BigInt(0) ].forEach((pValue) => { Expect(libTypeMap.toStoreValue(tmpBoolean, pValue, 'SQLite'), String(pValue)).to.deep.equal({ Value: 0, Lossy: null }); });
						// SQLite: 'true' / 'false' are TEXT in an integer column — Live's `= 1` never matches them and its
						// Terms count them Missing; no mirror value reproduces both, so the column is Value-lossy.
						[ 2, -1, 'yes', '', 'TRUE', 'true', 'false' ].forEach((pValue) => { Expect(libTypeMap.toStoreValue(tmpBoolean, pValue, 'SQLite'), String(pValue)).to.deep.equal({ Value: null, Lossy: 'Value' }); });
						// A driver that hands booleans over (PostgreSQL) keeps the words.
						Expect(libTypeMap.toStoreValue(tmpBoolean, 'true', 'PostgreSQL')).to.deep.equal({ Value: 1, Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpBoolean, 'false', 'PostgreSQL')).to.deep.equal({ Value: 0, Lossy: null });
					});

				test('dates: the naive wall clock with milliseconds; non-canonical SQLite text is Compare; \'\', unparseable and out-of-range (1899) are NULL + Value',
					() =>
					{
						let tmpColumn = { Column: 'SaleDate', Mirror: "Nullable(DateTime64(3, 'UTC'))" };
						Expect(libTypeMap.toStoreValue(tmpColumn, '2023-04-01 10:20:30', 'SQLite')).to.deep.equal({ Value: '2023-04-01 10:20:30.000', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '2022-01-01T00:00:00', 'SQLite')).to.deep.equal({ Value: '2022-01-01 00:00:00.000', Lossy: 'Compare' });
						Expect(libTypeMap.toStoreValue(tmpColumn, '2023-07-01 00:00', 'SQLite')).to.deep.equal({ Value: '2023-07-01 00:00:00.000', Lossy: 'Compare' });
						Expect(libTypeMap.toStoreValue(tmpColumn, '2023-04-01', 'SQLite')).to.deep.equal({ Value: '2023-04-01 00:00:00.000', Lossy: 'Compare' });
						Expect(libTypeMap.toStoreValue(tmpColumn, '2023-04-01 10:20:30.5', 'SQLite')).to.deep.equal({ Value: '2023-04-01 10:20:30.500', Lossy: 'Compare' });
						// PostgreSQL hands back Dates (read in UTC under TZ=UTC): exact, milliseconds kept.
						Expect(libTypeMap.toStoreValue(tmpColumn, new Date(Date.UTC(2023, 3, 1, 10, 20, 30, 45)), 'PostgreSQL')).to.deep.equal({ Value: '2023-04-01 10:20:30.045', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '2023-04-01', 'PostgreSQL')).to.deep.equal({ Value: '2023-04-01 00:00:00.000', Lossy: null });
						// Before 1970 is fine (Date32 range); the DateTime64 range edges.
						Expect(libTypeMap.toStoreValue(tmpColumn, '1955-06-15 00:00:00', 'SQLite')).to.deep.equal({ Value: '1955-06-15 00:00:00.000', Lossy: null });
						Expect(libTypeMap.toStoreValue(tmpColumn, '1900-01-01 00:00:00', 'SQLite').Lossy).to.equal(null);
						Expect(libTypeMap.toStoreValue(tmpColumn, '2299-12-31 23:59:59', 'SQLite').Lossy).to.equal(null);
						[ '1899-12-31', '1899-12-31 23:59:59', '2300-01-01 00:00:00', '', 'soon', '2023-02-30', 1700000000000, '2023-01-01+05:00' ].forEach(
							(pValue) => { Expect(libTypeMap.toStoreValue(tmpColumn, pValue, 'SQLite'), String(pValue)).to.deep.equal({ Value: null, Lossy: 'Value' }); });
						Expect(libTypeMap.toStoreValue(tmpColumn, new Date(NaN), 'PostgreSQL')).to.deep.equal({ Value: null, Lossy: 'Value' });
					});

				test('toStoreRow: the spec columns only, Lossy per column (Value wins over Compare), quarantine of an unset tenant, an unusable identity',
					() =>
					{
						let tmpRow = libTypeMap.toStoreRow(SPEC_PERSONAL,
							{ IDLabForm: 7, IDCustomer: 1, OwnerIDUser: null, UpdateDate: '2024-01-02 03:04:05', Deleted: 0, IDMaterialIntake: '', Status: 'Done', Score: 4.5, CompletedDate: '2024-01-02', GUIDLabForm: 'g', Secret: 'x' }, 'SQLite');
						Expect(tmpRow.Quarantined).to.equal(false);
						Expect(tmpRow.Row).to.deep.equal({ IDLabForm: 7, IDCustomer: 1, OwnerIDUser: null, UpdateDate: '2024-01-02 03:04:05.000', Deleted: 0, IDMaterialIntake: null, Status: 'Done', Score: 4.5, CompletedDate: '2024-01-02 00:00:00.000' });
						Expect(tmpRow.Lossy).to.deep.equal({ IDMaterialIntake: 'Value', CompletedDate: 'Compare' });
						// An unset owner is not a quarantine (the owner sort-key column is Nullable).
						Expect(libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 8, IDCustomer: 2, OwnerIDUser: 0 }, 'SQLite').Quarantined).to.equal(false);
						// An unset tenant (0, NULL, '', a policy UnsetValue, a text the integer column cannot hold) is.
						[ 0, null, '', ' ', 'x' ].forEach((pTenant) => { Expect(libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 9, IDCustomer: pTenant }, 'SQLite').Quarantined, String(pTenant)).to.equal('TenantUnset'); });
						Expect(libTypeMap.toStoreRow(Object.assign({}, SPEC_TENANT, { UnsetValues: [ 0, '', null, -1 ] }), { IDProject: 1, IDCustomer: -1 }, 'SQLite').Quarantined).to.equal('TenantUnset');
						// Global / Unscoped entities never quarantine on a tenant.
						Expect(libTypeMap.toStoreRow(SPEC_GLOBAL, { IDFormType: 3, Name: 'x' }, 'SQLite')).to.deep.equal({ Row: { IDFormType: 3, Name: 'x' }, Lossy: {}, Quarantined: false });
						// An identity that is not a safe integer: no row.
						let tmpBad = libTypeMap.toStoreRow(SPEC_GLOBAL, { IDFormType: 'abc', Name: 'x' }, 'SQLite');
						Expect(tmpBad).to.deep.include({ Row: null, Quarantined: 'Identity' });
						Expect(tmpBad.Lossy.IDFormType).to.equal('Value');
					});

				test('isLive (§56.4): the delete column exactly 0; no delete column → live; NULL or anything else → not live',
					() =>
					{
						Expect(libTypeMap.isLive(SPEC_TENANT, { Deleted: 0 })).to.equal(true);
						Expect(libTypeMap.isLive(SPEC_TENANT, { Deleted: false })).to.equal(true);
						Expect(libTypeMap.isLive(SPEC_TENANT, { Deleted: '0' })).to.equal(true);
						[ 1, true, null, undefined, 2, '' ].forEach((pValue) => { Expect(libTypeMap.isLive(SPEC_TENANT, { Deleted: pValue }), String(pValue)).to.equal(false); });
						Expect(libTypeMap.isLive(SPEC_GLOBAL, { IDFormType: 1 })).to.equal(true);
						Expect(libTypeMap.isLive(SPEC_GLOBAL, null)).to.equal(false);
					});

				test('keyOf / trackedOf / keyString: the keymap Key and tracked values of a store row; equal keys give equal strings',
					() =>
					{
						let tmpRow = libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 7, IDCustomer: 1, OwnerIDUser: 42, IDMaterialIntake: 9 }, 'SQLite').Row;
						Expect(libTypeMap.keyOf(SPEC_PERSONAL, tmpRow)).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 42 });
						Expect(libTypeMap.trackedOf(SPEC_PERSONAL, tmpRow)).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 42, IDMaterialIntake: 9 });
						Expect(libTypeMap.keyString(SPEC_PERSONAL, { OwnerIDUser: 42, IDCustomer: 1 })).to.equal(libTypeMap.keyString(SPEC_PERSONAL, libTypeMap.keyOf(SPEC_PERSONAL, tmpRow)));
						Expect(libTypeMap.keyString(SPEC_PERSONAL, { IDCustomer: 1, OwnerIDUser: null })).to.not.equal(libTypeMap.keyString(SPEC_PERSONAL, { IDCustomer: 1, OwnerIDUser: 42 }));
						Expect(libTypeMap.keyOf(SPEC_GLOBAL, { IDFormType: 3 })).to.deep.equal({});
						Expect(libTypeMap.keyColumnsOf(SPEC_PERSONAL)).to.deep.equal([ 'IDCustomer', 'OwnerIDUser' ]);
					});

				test('fromStoreValue: DateTime64 text to the wire format; wide integers and numeric text to numbers',
					() =>
					{
						Expect(libTypeMap.fromStoreValue(DATETIME, '2023-01-01 10:00:00.500')).to.equal('2023-01-01 10:00:00');
						Expect(libTypeMap.fromStoreValue('Int64', '42')).to.equal(42);
						Expect(libTypeMap.fromStoreValue('Int64', '18446744073709551615')).to.equal('18446744073709551615');
						Expect(libTypeMap.fromStoreValue('Nullable(Float64)', '5.94')).to.equal(5.94);
						Expect(libTypeMap.fromStoreValue('Nullable(String)', 'x')).to.equal('x');
						Expect(libTypeMap.fromStoreValue('Nullable(String)', null)).to.equal(null);
					});

				test('canonicalDateLiteral (§63.3): canonical text under any operator; day-only under >= / < (both dialects) and anything on PostgreSQL; the rest refused',
					() =>
					{
						[ '=', '!=', '<', '<=', '>', '>=' ].forEach(
							(pOperator) =>
							{
								Expect(libTypeMap.canonicalDateLiteral('2026-10-08 12:00:00', pOperator, 'SQLite'), pOperator).to.deep.equal({ Literal: '2026-10-08 12:00:00' });
								Expect(libTypeMap.canonicalDateLiteral('2026-10-08', pOperator, 'PostgreSQL'), pOperator).to.deep.equal({ Literal: '2026-10-08 00:00:00' });
							});
						Expect(libTypeMap.canonicalDateLiteral('2026-10-08', '>=', 'SQLite')).to.deep.equal({ Literal: '2026-10-08 00:00:00' });
						Expect(libTypeMap.canonicalDateLiteral('2026-10-08', '<', 'SQLite')).to.deep.equal({ Literal: '2026-10-08 00:00:00' });
						[ '>', '<=', '=', '!=' ].forEach((pOperator) => { Expect(libTypeMap.canonicalDateLiteral('2026-10-08', pOperator, 'SQLite'), pOperator).to.deep.equal({ Refused: 'DateLiteral' }); });
						[ '2026-10-08T12:00:00', '2026-10-08 12:00', '2026-10-08 12:00:00.000', '2026-02-30', '1899-12-31 00:00:00', '2400-01-01 00:00:00', 20261008, null, new Date() ].forEach(
							(pValue) => { Expect(libTypeMap.canonicalDateLiteral(pValue, '>=', 'PostgreSQL'), String(pValue)).to.deep.equal({ Refused: 'DateLiteral' }); });
						Expect(libTypeMap.canonicalDateLiteral([ '2026-10-08 12:00:00', '2026-10-09' ], 'IN', 'PostgreSQL')).to.deep.equal({ Literal: [ '2026-10-08 12:00:00', '2026-10-09 00:00:00' ] });
						Expect(libTypeMap.canonicalDateLiteral([ '2026-10-08 12:00:00', '2026-10-09' ], 'IN', 'SQLite')).to.deep.equal({ Refused: 'DateLiteral' });
					});
			}
		);

		suite
		(
			'DDL (§56.1–§56.2)',
			() =>
			{
				test('names: instance keys, database names, quoting, mirror / keymap / shadow names; reserved and invalid names refused',
					() =>
					{
						Expect(libDDL.sanitizeInstanceKey('sluice-juicebox.1')).to.equal('sluice_juicebox_1');
						Expect(libDDL.sanitizeInstanceKey(null)).to.equal('main');
						Expect(libDDL.sanitizeInstanceKey('')).to.equal('main');
						Expect(libDDL.databaseName('main')).to.equal('rfs_main');
						// Injective: an InstanceID that sanitizing changes gets a short hash of its raw text.
						Expect(libDDL.databaseName('a b', null)).to.match(/^rfs_a_b_[0-9a-f]{8}$/);
						Expect(libDDL.databaseName('a_b', null)).to.equal('rfs_a_b');
						Expect(libDDL.databaseName('prod.eu')).to.not.equal(libDDL.databaseName('prod-eu'));
						Expect(libDDL.databaseName('prod.eu')).to.not.equal(libDDL.databaseName('prod_eu'));
						Expect(libDDL.databaseName('main', 'rfs_123_4')).to.equal('rfs_123_4');
						Expect(() => { return libDDL.databaseName('main', 'bad`name'); }).to.throw();
						Expect(libDDL.quoteIdentifier('IDLabForm')).to.equal('`IDLabForm`');
						Expect(() => { return libDDL.quoteIdentifier('a`b'); }).to.throw();
						Expect(() => { return libDDL.quoteIdentifier(''); }).to.throw();
						Expect(libDDL.qualified('rfs_main', 'LabForm')).to.equal('`rfs_main`.`LabForm`');
						Expect(libDDL.mirrorTableName('LabForm')).to.equal('LabForm');
						Expect(libDDL.mirrorTableName('LabForm', '0a1b2c3d')).to.equal('LabForm__shadow_0a1b2c3d');
						Expect(libDDL.keymapTableName('LabForm', '0a1b2c3d')).to.equal('_rfs_keys_LabForm__shadow_0a1b2c3d');
						Expect(() => { return libDDL.mirrorTableName('LabForm', 'XYZ'); }).to.throw(/BuildID/);
						Expect(() => { return libDDL.mirrorTableName('_rfs_keys_x'); }).to.throw();
						Expect(libDDL.META_COLUMNS).to.deep.equal([ '_Version', '_IsDeleted', '_AppliedAt' ]);
						Expect(libStoreBase.shadowTarget('0a1b2c3d')).to.equal('Shadow:0a1b2c3d');
						Expect(() => { return libStoreBase.shadowTarget('nope'); }).to.throw();
						Expect(libStoreBase.isShadowTarget('Shadow:zzzzzzzz')).to.equal(null);
					});

				test('golden: a Tenant entity (mirror and keymap)',
					() =>
					{
						Expect(libDDL.mirrorDDL('rfs_main', SPEC_TENANT)).to.equal(
							[
								'CREATE TABLE IF NOT EXISTS `rfs_main`.`Project`',
								'(',
								'\t`IDProject` Int64,',
								'\t`IDCustomer` Int64,',
								"\t`UpdateDate` Nullable(DateTime64(3, 'UTC')),",
								'\t`Deleted` Nullable(UInt8),',
								'\t`IDClient` Nullable(Int64),',
								'\t`Status` Nullable(String),',
								'\t`Budget` Nullable(Float64),',
								'\t`_Version` UInt64,',
								'\t`_IsDeleted` UInt8,',
								"\t`_AppliedAt` DateTime64(3, 'UTC') DEFAULT now64(3)",
								')',
								'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
								'ORDER BY (`IDCustomer`, `IDProject`)',
								'SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000',
								"COMMENT 'rfs mirror Project spec=ms:0a0a0a0a'"
							].join('\n'));
						Expect(libDDL.keymapDDL('rfs_main', SPEC_TENANT)).to.equal(
							[
								'CREATE TABLE IF NOT EXISTS `rfs_main`.`_rfs_keys_Project`',
								'(',
								'\t`IDProject` Int64,',
								'\t`IDCustomer` Int64,',
								'\t`IDClient` Nullable(Int64),',
								"\t`UpdateDate` Nullable(DateTime64(3, 'UTC')),",
								'\t`_Version` UInt64,',
								'\t`_IsDeleted` UInt8',
								')',
								'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
								'ORDER BY (`IDProject`, `IDCustomer`)',
								'SETTINGS index_granularity = 256, non_replicated_deduplication_window = 1000',
								"COMMENT 'rfs keymap Project spec=ms:0a0a0a0a'"
							].join('\n'));
					});

				test('golden: a Personal entity (Nullable owner in both sort keys → allow_nullable_key), a shadow build',
					() =>
					{
						let tmpMirror = libDDL.mirrorDDL('rfs_main', SPEC_PERSONAL, '0a1b2c3d');
						Expect(tmpMirror.split('\n')[0]).to.equal('CREATE TABLE IF NOT EXISTS `rfs_main`.`LabForm__shadow_0a1b2c3d`');
						Expect(tmpMirror).to.contain('\t`OwnerIDUser` Nullable(Int64),\n');
						Expect(tmpMirror).to.contain('ORDER BY (`IDCustomer`, `OwnerIDUser`, `IDLabForm`)\nSETTINGS allow_nullable_key = 1, index_granularity = 8192, non_replicated_deduplication_window = 1000\n');
						// The COMMENT names the entity (it travels with the table through RENAME / EXCHANGE).
						Expect(tmpMirror).to.match(/COMMENT 'rfs mirror LabForm spec=ms:0b0b0b0b'$/);
						Expect(libDDL.keymapDDL('rfs_main', SPEC_PERSONAL)).to.equal(
							[
								'CREATE TABLE IF NOT EXISTS `rfs_main`.`_rfs_keys_LabForm`',
								'(',
								'\t`IDLabForm` Int64,',
								'\t`IDCustomer` Int64,',
								'\t`OwnerIDUser` Nullable(Int64),',
								'\t`IDMaterialIntake` Nullable(Int64),',
								"\t`UpdateDate` Nullable(DateTime64(3, 'UTC')),",
								'\t`_Version` UInt64,',
								'\t`_IsDeleted` UInt8',
								')',
								'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
								'ORDER BY (`IDLabForm`, `IDCustomer`, `OwnerIDUser`)',
								'SETTINGS allow_nullable_key = 1, index_granularity = 256, non_replicated_deduplication_window = 1000',
								"COMMENT 'rfs keymap LabForm spec=ms:0b0b0b0b'"
							].join('\n'));
					});

				test('golden: a Global and an Unscoped entity (identity-only sort keys)',
					() =>
					{
						Expect(libDDL.mirrorDDL('rfs_7', SPEC_GLOBAL)).to.equal(
							[
								'CREATE TABLE IF NOT EXISTS `rfs_7`.`FormType`',
								'(',
								'\t`IDFormType` Int64,',
								'\t`Name` Nullable(String),',
								'\t`_Version` UInt64,',
								'\t`_IsDeleted` UInt8,',
								"\t`_AppliedAt` DateTime64(3, 'UTC') DEFAULT now64(3)",
								')',
								'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
								'ORDER BY (`IDFormType`)',
								'SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000',
								"COMMENT 'rfs mirror FormType spec=ms:0c0c0c0c'"
							].join('\n'));
						Expect(libDDL.keymapDDL('rfs_7', SPEC_GLOBAL)).to.contain('(\n\t`IDFormType` Int64,\n\t`_Version` UInt64,\n\t`_IsDeleted` UInt8\n)\n');
						Expect(libDDL.mirrorDDL('rfs_7', SPEC_UNSCOPED)).to.contain('ORDER BY (`IDBook`)\nSETTINGS index_granularity = 8192');
						Expect(libDDL.keymapDDL('rfs_7', SPEC_UNSCOPED)).to.contain("(\n\t`IDBook` Int64,\n\t`UpdateDate` Nullable(DateTime64(3, 'UTC')),\n\t`_Version` UInt64,");
					});

				test('the state table, additive ALTER, MODIFY COMMENT, EXCHANGE, RENAME, DROP; spec comments round-trip',
					() =>
					{
						let tmpState = libDDL.entityStateDDL('rfs_main');
						Expect(tmpState).to.match(/^CREATE TABLE IF NOT EXISTS `rfs_main`\.`_rfs_entity_state`/);
						[ '`Store` LowCardinality(String)', '`AppliedSeq` String', '`CleanShutdown` UInt8', '`LossyColumns` String', '`FillingColumns` String', "`UnverifiedSince` Nullable(DateTime64(3, 'UTC'))", '`_Version` UInt64' ].forEach((pPart) => { Expect(tmpState).to.contain(pPart); });
						Expect(tmpState).to.match(/ENGINE = ReplacingMergeTree\(`_Version`\)\nORDER BY \(`Store`, `Entity`\)$/);
						Expect(libDDL.addColumnsDDL('rfs_main', 'LabForm', [ { Column: 'Priority', Mirror: 'Nullable(String)' } ], 'rfs mirror LabForm spec=ms:12345678')).to.equal(
							"ALTER TABLE `rfs_main`.`LabForm` ADD COLUMN IF NOT EXISTS `Priority` Nullable(String), MODIFY COMMENT 'rfs mirror LabForm spec=ms:12345678'");
						Expect(libDDL.modifyCommentDDL('rfs_main', '_rfs_keys_LabForm', 'rfs keymap LabForm spec=ms:12345678')).to.equal("ALTER TABLE `rfs_main`.`_rfs_keys_LabForm` MODIFY COMMENT 'rfs keymap LabForm spec=ms:12345678'");
						Expect(() => { return libDDL.addColumnsDDL('rfs_main', 'LabForm', [ { Column: 'IDCustomer', Mirror: 'Int64' } ]); }).to.throw(/Nullable/);
						Expect(() => { return libDDL.addColumnsDDL('rfs_main', 'LabForm', [ { Column: '_Version', Mirror: 'Nullable(Int64)' } ]); }).to.throw();
						Expect(() => { return libDDL.addColumnsDDL('rfs_main', 'LabForm', [ { Column: 'X', Mirror: 'Nullable(Int64); DROP' } ]); }).to.throw(/type/);
						Expect(() => { return libDDL.addColumnsDDL('rfs_main', 'LabForm', []); }).to.throw();
						Expect(libDDL.exchangeDDL('rfs_main', 'LabForm', 'LabForm__shadow_0a1b2c3d')).to.equal('EXCHANGE TABLES `rfs_main`.`LabForm` AND `rfs_main`.`LabForm__shadow_0a1b2c3d`');
						Expect(libDDL.renameDDL('rfs_main', 'LabForm__shadow_0a1b2c3d', 'LabForm')).to.equal('RENAME TABLE `rfs_main`.`LabForm__shadow_0a1b2c3d` TO `rfs_main`.`LabForm`');
						Expect(libDDL.dropTableDDL('rfs_main', 'LabForm__shadow_0a1b2c3d')).to.equal('DROP TABLE IF EXISTS `rfs_main`.`LabForm__shadow_0a1b2c3d` SYNC');
						Expect(libDDL.specComment('mirror', 'LabForm', 'ms:0123abcd')).to.equal('rfs mirror LabForm spec=ms:0123abcd');
						Expect(libDDL.parseSpecComment('rfs keymap LabForm spec=ms:0123abcd')).to.deep.equal({ Kind: 'keymap', Entity: 'LabForm', SpecHash: 'ms:0123abcd' });
						[ '', 'rfs mirror LabForm', "rfs mirror La'bForm spec=ms:0123abcd", 'rfs other X spec=ms:0123abcd', null ].forEach((pComment) => { Expect(libDDL.parseSpecComment(pComment), String(pComment)).to.equal(null); });
						Expect(() => { return libDDL.specComment('mirror', 'LabForm', "ms:0123abcd'"); }).to.throw();
					});

				test('a spec the DDL cannot render is refused: no sort key, a meta column, a duplicate, an unknown type, a keymap column outside the spec',
					() =>
					{
						Expect(() => { return libDDL.mirrorDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { SortKey: [] })); }).to.throw();
						Expect(() => { return libDDL.mirrorDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { Columns: SPEC_GLOBAL.Columns.concat([ { Column: '_IsDeleted', Mirror: 'UInt8' } ]) })); }).to.throw();
						Expect(() => { return libDDL.mirrorDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { Columns: SPEC_GLOBAL.Columns.concat([ { Column: 'Name', Mirror: 'Nullable(String)' } ]) })); }).to.throw(/duplicate/);
						Expect(() => { return libDDL.mirrorDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { Columns: [ SPEC_GLOBAL.Columns[0], { Column: 'Name', Mirror: 'Nullable(Decimal(10,2))' } ] })); }).to.throw(/type/);
						Expect(() => { return libDDL.keymapDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { KeymapColumns: [ 'IDFormType', 'Nope' ] })); }).to.throw();
						Expect(() => { return libDDL.mirrorDDL('rfs_main', Object.assign({}, SPEC_GLOBAL, { SortKey: [ 'Nope' ] })); }).to.throw();
					});
			}
		);

		suite
		(
			'Store configuration and feature-not-boot (no server)',
			() =>
			{
				test('not an object → NotConfigured; methods answer a StoreError, never throw',
					(fDone) =>
					{
						let tmpStore = newStore().Store;
						Expect(tmpStore.StoreName).to.equal('ClickHouse');
						Expect(tmpStore.status()).to.include({ Configured: false, Available: false, Reason: 'NotConfigured' });
						Expect(tmpStore.configure(false)).to.deep.equal({ Configured: false, Available: false, Reason: 'NotConfigured' });
						Expect(tmpStore.capabilities()).to.deep.equal({ Folds: [ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'ChildRollup', 'ExistsSplit' ], Predicates: 'Portable', Paths: 'Subquery', CountModes: [ 'Rows', 'PivotDistinct', 'KeyDistinct' ], TimeZones: [ 'UTC' ] });
						tmpStore.connect(
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult).to.deep.equal({ Up: false, Version: null });
								tmpStore.queryRows('SELECT 1', {}, null, null,
									(pQueryError) =>
									{
										Expect(pQueryError).to.include({ StoreError: true });
										tmpStore.writeBatch('LabForm', {}, 'x', 'Live', (pWriteError) => { Expect(pWriteError.StoreError).to.equal(true); return fDone(); });
									});
							});
					});

				test('misconfigured (no URL, a bad database name, credentials in the URL, bad settings) → Available false, Reason Misconfigured, no secret logged',
					() =>
					{
						let tmpCase = newStore({ InstanceID: 'demo' });
						Expect(tmpCase.Store.configure({})).to.deep.equal({ Configured: true, Available: false, Reason: 'Misconfigured' });
						Expect(tmpCase.Store.status().LastError).to.match(/no URL/);
						Expect(tmpCase.Store.configure({ URL: 'http://127.0.0.1:18123', Database: 'bad-name', Password: 'Hunter2-secret' }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Store.configure({ URL: 'http://rfs:Hunter2-secret@127.0.0.1:18123' }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Store.status().LastError).to.match(/credentials/);
						Expect(tmpCase.Store.configure({ URL: 'not a url' }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Store.configure({ URL: 'http://127.0.0.1:18123', QuerySettings: { 'Bad-Name': 1 } }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Store.configure({ URL: 'http://127.0.0.1:18123', SourceStringOrder: 'Whatever' }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Store.configure({ URLEnv: 'RFS_TEST_NO_SUCH_VARIABLE_XYZ' }).Reason).to.equal('Misconfigured');
						Expect(tmpCase.Logged.join('\n')).to.not.contain('Hunter2-secret');
						Expect(tmpCase.Logged.filter((pLine) => { return /misconfigured/.test(pLine); }).length).to.be.above(5);
					});

				test('the database name defaults to rfs_<InstanceKey> (+ a hash when sanitized); the default InstanceID needs an explicit Database; URLEnv / UserEnv / PasswordEnv resolve; the resolved options carry no password',
					() =>
					{
						let tmpCase = newStore({ InstanceID: 'sluice-juicebox' });
						process.env.RFS_TEST_STORE_URL_X = 'http://127.0.0.1:18123';
						process.env.RFS_TEST_STORE_USER_X = 'env_user';
						process.env.RFS_TEST_STORE_PASSWORD_X = 'env-secret-pw';
						try
						{
							let tmpResult = tmpCase.Store.configure({ URLEnv: 'RFS_TEST_STORE_URL_X', UserEnv: 'RFS_TEST_STORE_USER_X', PasswordEnv: 'RFS_TEST_STORE_PASSWORD_X', QuerySettings: { max_threads: 2 }, InsertRetries: 3 });
							Expect(tmpResult).to.deep.equal({ Configured: true, Available: false, Reason: 'NotConnected' });
							Expect(tmpCase.Store.Database).to.match(/^rfs_sluice_juicebox_[0-9a-f]{8}$/);
							let tmpDatabase = tmpCase.Store.Database;
							Expect(tmpCase.Store.Client).to.include({ User: 'env_user', Password: 'env-secret-pw', Database: null });
							let tmpResolved = tmpCase.Store.resolvedOptions();
							Expect(tmpResolved).to.include({ URL: 'http://127.0.0.1:18123', User: 'env_user', Database: tmpDatabase, InsertRetries: 3, SourceStringOrder: 'Auto', ExposeReasons: false });
							Expect(tmpResolved.QuerySettings).to.deep.equal({ max_threads: 2 });
							Expect(JSON.stringify(tmpResolved)).to.not.contain('env-secret-pw');
							Expect(tmpCase.Logged.join('\n')).to.not.contain('env-secret-pw');
							Expect(tmpCase.Store.status()).to.include({ Configured: true, Available: false, Reason: 'NotConnected', Database: tmpDatabase });
							// The same section again (installStores after a model reload) keeps the client and its status.
							let tmpClient = tmpCase.Store.Client;
							tmpCase.Store._Status.Available = true;
							tmpCase.Store._Status.Reason = null;
							Expect(tmpCase.Store.configure({ URLEnv: 'RFS_TEST_STORE_URL_X', UserEnv: 'RFS_TEST_STORE_USER_X', PasswordEnv: 'RFS_TEST_STORE_PASSWORD_X', QuerySettings: { max_threads: 2 }, InsertRetries: 3 })).to.deep.equal({ Configured: true, Available: true, Reason: null });
							Expect(tmpCase.Store.Client).to.equal(tmpClient);
							// A changed setting (or password) is a new configuration: a new client, NotConnected.
							Expect(tmpCase.Store.configure({ URLEnv: 'RFS_TEST_STORE_URL_X', UserEnv: 'RFS_TEST_STORE_USER_X', PasswordEnv: 'RFS_TEST_STORE_PASSWORD_X', QuerySettings: { max_threads: 4 }, InsertRetries: 3 }).Reason).to.equal('NotConnected');
							Expect(tmpCase.Store.Client).to.not.equal(tmpClient);
							// A Database override wins.
							tmpCase.Store.configure({ URL: 'http://127.0.0.1:18123', Database: 'rfs_9_9' });
							Expect(tmpCase.Store.Database).to.equal('rfs_9_9');
							// The defaults object of the options module is what a host's section merges over.
							Expect(libOptions.STORE_DEFAULTS.ClickHouse.InsertRetries).to.equal(2);
							// The default InstanceID ('main') with no Database would be shared by every deployment left at
							// the defaults: refused (Misconfigured), never guessed.
							let tmpDefault = newStore({});
							Expect(tmpDefault.Store.configure({ URL: 'http://127.0.0.1:18123' })).to.deep.include({ Configured: true, Available: false, Reason: 'Misconfigured' });
							Expect(tmpDefault.Logged.join('\n')).to.match(/Database or a non-default InstanceID/);
							Expect(tmpDefault.Store.configure({ URL: 'http://127.0.0.1:18123', Database: 'facets_main' }).Reason).to.equal('NotConnected');
						}
						finally
						{
							delete process.env.RFS_TEST_STORE_URL_X;
							delete process.env.RFS_TEST_STORE_USER_X;
							delete process.env.RFS_TEST_STORE_PASSWORD_X;
						}
					});

				test('an unreachable server: connect Up false (no error), status Available false / Unreachable, health Up false',
					(fDone) =>
					{
						let tmpStore = newStore().Store;
						tmpStore.configure({ URL: 'http://127.0.0.1:1', PingTimeoutMS: 300, Database: 'rfs_0_0' });
						tmpStore.connect(
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult).to.deep.equal({ Up: false, Version: null });
								Expect(tmpStore.status()).to.include({ Configured: true, Available: false, Reason: 'Unreachable' });
								tmpStore.health(
									(pHealthError, pHealth) =>
									{
										Expect(pHealthError).to.equal(null);
										Expect(pHealth).to.include({ Up: false, Tables: 0 });
										tmpStore.ensureSchema({}, (pSchemaError) => { Expect(pSchemaError).to.include({ StoreError: true, Status: 0 }); return fDone(); });
									});
							});
					});

				test('StoreBase: every abstract method calls back a StoreError; isWipeError recognizes the wipe codes',
					(fDone) =>
					{
						let tmpBase = new libStoreBase(libBuilders.newFable());
						Expect(tmpBase.StoreName).to.equal('Base');
						Expect(tmpBase.configure({})).to.include({ Configured: false });
						tmpBase.writeBatch('E', {}, 't', 'Live', (pError) => { Expect(pError).to.include({ StoreError: true }); });
						Expect(libStore.isWipeError({ StoreError: true, Code: 81 })).to.equal(true);
						Expect(libStore.isWipeError({ StoreError: true, Code: 60 })).to.equal(true);
						Expect(libStore.isWipeError({ StoreError: true, Code: 62 })).to.equal(false);
						Expect(libStore.READ_SETTINGS).to.include({ enable_extended_results_for_datetime_functions: 1, precise_float_parsing: 1, join_use_nulls: 1, transform_null_in: 0 });
						tmpBase.readKeys('E', [ 1 ], 'Live', (pError) => { Expect(pError.message).to.match(/abstract/); return fDone(); });
					});
			}
		);

		gatedSuite(CLICKHOUSE.Available)
		(
			'Store against rfs-test-clickhouse (CH-gated)',
			() =>
			{
				let _Client = null;
				let _Database = null;
				let _Store = null;

				suiteSetup(
					(fDone) =>
					{
						libSupport.ensure(
							(pError, pInfo) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_Client = new libClickHouseClient({ URL: pInfo.URL, User: pInfo.User, Password: pInfo.Password, Database: null });
								_Database = libSupport.freshDatabase();
								_Store = newStore({ Materializer: { FlushRows: 3 } }).Store;
								let tmpConfigured = _Store.configure(libSupport.storeOptions(_Database));
								Expect(tmpConfigured.Reason).to.equal('NotConnected');
								_Store.connect(
									(pConnectError, pConnected) =>
									{
										if (pConnectError || !pConnected.Up)
										{
											return fDone(pConnectError || new Error('the store did not connect'));
										}
										Expect(_Store.status()).to.include({ Available: true, Reason: null, Database: _Database });
										Expect(pConnected.Version).to.match(/^24\.8\./);
										return fDone();
									});
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						_Store.close();
						_Client.close();
						libSupport.release(_Database, fDone);
					});

				setup(() => { _Store.Client.setFaultInjector(null); });

				/**
				 * FINAL live rows of a table (meta columns kept).
				 */
				const finalRows = (pTable, fCallback) =>
				{
					_Client.query(`SELECT * FROM ${libDDL.qualified(_Database, pTable)} FINAL WHERE _IsDeleted = 0 ORDER BY 1`, null, null, fCallback);
				};

				test('ping and a trivial query through the client (24.8)',
					(fDone) =>
					{
						_Client.ping(
							(pPingError, pUp) =>
							{
								Expect(pPingError).to.equal(null);
								Expect(pUp).to.equal(true);
								_Client.query('SELECT version() AS Version, {a:Int64} + 1 AS Two, {s:String} AS S, count() AS N FROM system.one', { a: 1, s: "it's ~ %" }, null,
									(pError, pRows) =>
									{
										Expect(pError).to.equal(null);
										Expect(pRows).to.have.length(1);
										Expect(pRows[0].Version).to.match(/^24\.8\./);
										Expect(pRows[0].Two).to.equal(2);
										Expect(pRows[0].S).to.equal("it's ~ %");
										Expect(pRows[0].N).to.equal(1);
										return fDone();
									});
							});
					});

				test('client: command, a parameterized array, 64-bit values both ways, a deterministic error with its code',
					(fDone) =>
					{
						_Client.query('SELECT has({ids:Array(Int64)}, 9007199254740991) AS H, toUInt64(18446744073709551615) AS Big, toInt64(-5) AS Neg, [toInt64(1), toInt64(2)] AS Arr, {n:Nullable(String)} AS Nul',
							{ ids: [ 1, 9007199254740991 ], n: null }, null,
							(pError, pRows) =>
							{
								Expect(pError).to.equal(null);
								Expect(pRows[0]).to.deep.equal({ H: 1, Big: '18446744073709551615', Neg: -5, Arr: [ 1, 2 ], Nul: null });
								_Client.query('SELECT * FROM rfs_no_such_database_x.t', null, null,
									(pMissingError) =>
									{
										Expect(pMissingError).to.include({ Code: 81, Status: 404, Retryable: false });
										return fDone();
									});
							});
					});

				test('insert with a dedup token: the same token is dropped, a new token lands; a retry after a landed 5xx leaves one copy',
					(fDone) =>
					{
						let tmpTable = libDDL.qualified(_Database, 'DedupProbe');
						series(
							[
								(fNext) => { _Client.command(`CREATE DATABASE IF NOT EXISTS ${libDDL.quoteIdentifier(_Database)}`, null, null, fNext); },
								(fNext) => { _Client.command(`CREATE TABLE ${tmpTable} (K UInt32) ENGINE = MergeTree ORDER BY K SETTINGS non_replicated_deduplication_window = 100`, null, null, fNext); },
								(fNext) => { _Client.insert(tmpTable, [ { K: 1 } ], { Token: 'tok-a' }, fNext); },
								(fNext) => { _Client.insert(tmpTable, [ { K: 1 } ], { Token: 'tok-a' }, fNext); },
								(fNext) => { _Client.insert(tmpTable, [ { K: 1 } ], { Token: 'tok-b' }, fNext); },
								(fNext) =>
								{
									let tmpFaulted = false;
									_Client.setFaultInjector((pRequest) => { if ((pRequest.Kind === 'Insert') && !tmpFaulted) { tmpFaulted = true; return { Status: 500, When: 'After' }; } return null; });
									_Client.insert(tmpTable, [ { K: 2 } ], { Token: 'tok-c', Retries: 2 },
										(pError) =>
										{
											_Client.setFaultInjector(null);
											Expect(tmpFaulted).to.equal(true);
											return fNext(pError);
										});
								},
								(fNext) =>
								{
									_Client.query(`SELECT K, count() AS N FROM ${tmpTable} GROUP BY K ORDER BY K`, null, null,
										(pError, pRows) =>
										{
											Expect(pRows).to.deep.equal([ { K: 1, N: 2 }, { K: 2, N: 1 } ]);
											return fNext(pError);
										});
								},
								(fNext) => { _Client.command(`DROP TABLE ${tmpTable} SYNC`, null, null, fNext); }
							], fDone);
					});

				test('ensureSchema: Atomic database + state table, idempotent; reports what exists (never creates a live mirror); createLive; the COMMENT reads back',
					(fDone) =>
					{
						series(
							[
								(fNext) =>
								{
									_Store.ensureSchema({ LabForm: SPEC_PERSONAL, FormType: SPEC_GLOBAL },
										(pError, pResult) =>
										{
											Expect(pError).to.equal(null);
											Expect(pResult.Database).to.equal(_Database);
											Expect(pResult.Entities.LabForm).to.include({ MirrorExists: false, KeymapExists: false, SpecHash: null });
											Expect(pResult.Entities.FormType.Columns).to.deep.equal([]);
											return fNext();
										});
								},
								(fNext) => { _Store.createLive('LabForm', SPEC_PERSONAL, fNext); },
								(fNext) => { _Store.createLive('LabForm', SPEC_PERSONAL, fNext); },
								(fNext) =>
								{
									_Store.ensureSchema({ LabForm: SPEC_PERSONAL },
										(pError, pResult) =>
										{
											Expect(pError).to.equal(null);
											let tmpReport = pResult.Entities.LabForm;
											Expect(tmpReport).to.include({ MirrorExists: true, KeymapExists: true, SpecHash: 'ms:0b0b0b0b', KeymapSpecHash: 'ms:0b0b0b0b' });
											Expect(tmpReport.Columns).to.deep.equal(SPEC_PERSONAL.Columns.map((pColumn) => { return pColumn.Column; }));
											Expect(tmpReport.ColumnTypes.Score).to.equal('Nullable(Float64)');
											Expect(tmpReport.SortKey).to.deep.equal([ 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ]);
											Expect(tmpReport.KeymapSortKey).to.deep.equal([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser' ]);
											Expect(tmpReport.KeymapColumns).to.deep.equal(SPEC_PERSONAL.KeymapColumns);
											Expect(tmpReport.Shadows).to.deep.equal([]);
											return fNext();
										});
								},
								(fNext) =>
								{
									_Client.query('SELECT engine FROM system.databases WHERE name = {d:String}', { d: _Database }, null,
										(pError, pRows) =>
										{
											Expect(pRows).to.deep.equal([ { engine: 'Atomic' } ]);
											_Client.query('SELECT name FROM system.tables WHERE database = {d:String} ORDER BY name', { d: _Database }, null,
												(pTablesError, pTables) =>
												{
													Expect(pTables.map((pRow) => { return pRow.name; })).to.include.members([ 'LabForm', '_rfs_entity_state', '_rfs_keys_LabForm' ]);
													Expect(pTables.map((pRow) => { return pRow.name; })).to.not.include('FormType');
													return fNext(pTablesError || pError);
												});
										});
								}
							], fDone);
					});

				test('addColumns: additive ALTER on the mirror and (for tracked columns) the keymap, then the new SpecHash in both COMMENTs',
					(fDone) =>
					{
						let tmpWider = JSON.parse(JSON.stringify(SPEC_PERSONAL));
						tmpWider.Columns.push({ Column: 'Priority', DataType: 'String', Mirror: 'Nullable(String)', Role: 'Column' });
						tmpWider.Columns.push({ Column: 'IDLabFormType', DataType: 'Numeric', Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDLabFormType' });
						tmpWider.KeymapColumns = [ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType', 'UpdateDate' ];
						tmpWider.TrackedKeyColumns = [ 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType' ];
						tmpWider.SpecHash = 'ms:0e0e0e0e';
						tmpWider.Entity = 'Widened';
						let tmpNarrow = Object.assign({}, SPEC_PERSONAL, { Entity: 'Widened' });
						series(
							[
								(fNext) => { _Store.createLive('Widened', tmpNarrow, fNext); },
								(fNext) => { _Store.addColumns('Widened', tmpWider, [ 'Priority', 'IDLabFormType' ], fNext); },
								(fNext) =>
								{
									_Store.ensureSchema({ Widened: tmpWider },
										(pError, pResult) =>
										{
											let tmpReport = pResult.Entities.Widened;
											Expect(tmpReport.SpecHash).to.equal('ms:0e0e0e0e');
											Expect(tmpReport.KeymapSpecHash).to.equal('ms:0e0e0e0e');
											Expect(tmpReport.Columns).to.include.members([ 'Priority', 'IDLabFormType' ]);
											Expect(tmpReport.KeymapColumns).to.include('IDLabFormType');
											Expect(tmpReport.KeymapColumns).to.not.include('Priority');
											return fNext(pError);
										});
								},
								// Idempotent.
								(fNext) => { _Store.addColumns('Widened', tmpWider, [ 'Priority' ], fNext); },
								(fNext) => { _Store.addColumns('Widened', tmpWider, [ 'NotInSpec' ], (pError) => { Expect(pError).to.include({ StoreError: true }); return fNext(); }); }
							], fDone);
					});

				test('writeBatch: keymap intents, ONE mirror insert with rows AND tombstones, keymap retirements — in that order, with their tokens; exact Float64',
					(fDone) =>
					{
						let tmpInserts = [];
						_Store.Client.setFaultInjector((pRequest) => { if (pRequest.Kind === 'Insert') { tmpInserts.push(`${pRequest.Table} ${pRequest.Token}`); } return null; });
						let tmpRow = libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 1, IDCustomer: 1, OwnerIDUser: 10, UpdateDate: '2024-01-01 00:00:00', Deleted: 0, IDMaterialIntake: 5, Status: 'Pending', Score: 5.94, CompletedDate: '1955-06-15 00:00:00' }, 'SQLite').Row;
						let tmpOther = libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 2, IDCustomer: 1, OwnerIDUser: null, Deleted: 0, Score: 7.56 }, 'SQLite').Row;
						let tmpBatch =
							{
								Rows: [ Object.assign({}, tmpRow, { _Version: 100 }), { Row: tmpOther, Version: 100 } ],
								Tombstones: [ { ID: 3, Key: { IDCustomer: 1, OwnerIDUser: 10 }, Version: 100 } ],
								KeyIntents:
									[
										{ ID: 1, Key: libTypeMap.keyOf(SPEC_PERSONAL, tmpRow), Tracked: libTypeMap.trackedOf(SPEC_PERSONAL, tmpRow), UpdateDate: tmpRow.UpdateDate, Version: 100 },
										{ ID: 2, Key: libTypeMap.keyOf(SPEC_PERSONAL, tmpOther), Tracked: libTypeMap.trackedOf(SPEC_PERSONAL, tmpOther), UpdateDate: null, Version: 100 }
									],
								KeyRetires: [ { ID: 3, Key: { IDCustomer: 1, OwnerIDUser: 10 }, Version: 100 } ]
							};
						_Store.writeBatch('LabForm', tmpBatch, 'LabForm:100:Live', 'Live',
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult).to.deep.equal({ Rows: 2, Tombstones: 1, KeyIntents: 2, KeyRetires: 1, Inserts: 3 });
								Expect(tmpInserts).to.deep.equal(
									[
										`\`${_Database}\`.\`_rfs_keys_LabForm\` LabForm:100:Live:K0`,
										`\`${_Database}\`.\`LabForm\` LabForm:100:Live:M0`,
										`\`${_Database}\`.\`_rfs_keys_LabForm\` LabForm:100:Live:R0`
									]);
								_Store.readLeafRows('LabForm', null, null, null,
									(pLeafError, pRows) =>
									{
										Expect(pLeafError).to.equal(null);
										Expect(pRows).to.have.length(2);
										Expect(pRows[0]).to.deep.equal(tmpRow);
										// Float64 exact (5.94 / 7.56 are off by one ulp through ClickHouse's JSON parser).
										Expect(pRows[0].Score).to.equal(5.94);
										Expect(pRows[1].Score).to.equal(7.56);
										Expect(pRows[0].CompletedDate).to.equal('1955-06-15 00:00:00.000');
										// The same exactness through a bound value: toFloat64({p:String}) under the read settings.
										_Store.queryRows(`SELECT count() AS N FROM ${libDDL.qualified(_Database, 'LabForm')} FINAL WHERE _IsDeleted = 0 AND Score = toFloat64({p:String})`, { p: '5.94' }, { p: 'String' }, null,
											(pQueryError, pCount) =>
											{
												Expect(pCount).to.deep.equal([ { N: 1 } ]);
												return fDone(pQueryError);
											});
									});
							});
					});

				test('writeBatch chunks at FlushRows with one token per chunk; an empty phase sends nothing; a malformed batch is refused before anything is sent',
					(fDone) =>
					{
						let tmpTokens = [];
						_Store.Client.setFaultInjector((pRequest) => { if (pRequest.Kind === 'Insert') { tmpTokens.push(pRequest.Token); } return null; });
						let tmpRows = [];
						for (let i = 0; i < 7; i++)
						{
							tmpRows.push({ IDFormType: 100 + i, Name: `F${i}`, _Version: 200 });
						}
						series(
							[
								(fNext) => { _Store.createLive('FormType', SPEC_GLOBAL, fNext); },
								(fNext) =>
								{
									_Store.writeBatch('FormType', { Rows: tmpRows, Tombstones: [], KeyIntents: [], KeyRetires: [] }, 'FormType:200:Live', 'Live',
										(pError, pResult) =>
										{
											Expect(pResult).to.include({ Rows: 7, Inserts: 3 });
											Expect(tmpTokens).to.deep.equal([ 'FormType:200:Live:M0', 'FormType:200:Live:M1', 'FormType:200:Live:M2' ]);
											return fNext(pError);
										});
								},
								(fNext) =>
								{
									tmpTokens.length = 0;
									_Store.writeBatch('FormType', { Rows: [ { IDFormType: 1, Name: 'no version' } ] }, 'FormType:201:Live', 'Live',
										(pError) =>
										{
											Expect(pError).to.include({ StoreError: true });
											Expect(pError.message).to.match(/_Version/);
											Expect(tmpTokens).to.deep.equal([]);
											_Store.writeBatch('FormType', { Tombstones: [ { ID: 'x', Key: {}, Version: 1 } ] }, 'FormType:202:Live', 'Live', (pTombstoneError) => { Expect(pTombstoneError.message).to.match(/Tombstone/); return fNext(); });
										});
								},
								(fNext) => { _Store.writeBatch('FormType', {}, 'FormType:203:Live', 'Bogus', (pError) => { Expect(pError.message).to.match(/target/); return fNext(); }); },
								(fNext) => { _Store.writeBatch('NoSpec', {}, 'NoSpec:1:Live', 'Live', (pError) => { Expect(pError.message).to.match(/MirrorSpec/); return fNext(); }); }
							], fDone);
					});

				test('a moved ID: readKeys returns every live key; the keymap stays a superset of the mirror under a fault between each pair of inserts',
					(fDone) =>
					{
						let tmpRowAt = (pTenant, pOwner) => { return libTypeMap.toStoreRow(SPEC_PERSONAL, { IDLabForm: 50, IDCustomer: pTenant, OwnerIDUser: pOwner, Deleted: 0, Status: `${pTenant}/${pOwner}` }, 'SQLite').Row; };
						let tmpMove = (pFrom, pTo, pVersion) =>
						{
							let tmpRow = tmpRowAt(pTo[0], pTo[1]);
							let tmpOldKey = pFrom ? { IDCustomer: pFrom[0], OwnerIDUser: pFrom[1] } : null;
							return (
								{
									Rows: [ Object.assign({}, tmpRow, { _Version: pVersion }) ],
									Tombstones: pFrom ? [ { ID: 50, Key: tmpOldKey, Version: pVersion } ] : [],
									KeyIntents: [ { ID: 50, Key: libTypeMap.keyOf(SPEC_PERSONAL, tmpRow), Tracked: libTypeMap.trackedOf(SPEC_PERSONAL, tmpRow), UpdateDate: null, Version: pVersion } ],
									KeyRetires: pFrom ? [ { ID: 50, Key: tmpOldKey, Version: pVersion } ] : []
								});
						};
						let fFailPhase = (pPhase) =>
						{
							_Store.Client.setFaultInjector((pRequest) => { return ((pRequest.Kind === 'Insert') && (typeof(pRequest.Token) === 'string') && pRequest.Token.endsWith(`:${pPhase}0`)) ? { Status: 500, When: 'Before' } : null; });
						};
						let fState = (fCallback) =>
						{
							_Store.readKeys('LabForm', [ 50 ], 'Live',
								(pError, pKeys) =>
								{
									if (pError)
									{
										return fCallback(pError);
									}
									finalRows('LabForm',
										(pRowsError, pRows) =>
										{
											let tmpMirrorKeys = pRows.filter((pRow) => { return pRow.IDLabForm === 50; }).map((pRow) => { return libTypeMap.keyString(SPEC_PERSONAL, libTypeMap.keyOf(SPEC_PERSONAL, pRow)); }).sort();
											let tmpKeymapKeys = (pKeys.get(50) || []).map((pEntry) => { return libTypeMap.keyString(SPEC_PERSONAL, pEntry.Key); }).sort();
											// The superset invariant: every live mirror key is a live keymap key.
											tmpMirrorKeys.forEach((pKey) => { Expect(tmpKeymapKeys, pKey).to.include(pKey); });
											return fCallback(pRowsError, { Mirror: tmpMirrorKeys, Keymap: tmpKeymapKeys });
										});
								});
						};
						let tmpA = libTypeMap.keyString(SPEC_PERSONAL, { IDCustomer: 1, OwnerIDUser: 10 });
						let tmpB = libTypeMap.keyString(SPEC_PERSONAL, { IDCustomer: 2, OwnerIDUser: 11 });
						let tmpC = libTypeMap.keyString(SPEC_PERSONAL, { IDCustomer: 2, OwnerIDUser: null });
						series(
							[
								(fNext) => { _Store.writeBatch('LabForm', tmpMove(null, [ 1, 10 ], 1000), 'LabForm:1000:Live', 'Live', fNext); },
								(fNext) => { fState((pError, pState) => { Expect(pState).to.deep.equal({ Mirror: [ tmpA ], Keymap: [ tmpA ] }); return fNext(pError); }); },
								// A → B with the keymap intents failing: nothing changed.
								(fNext) => { fFailPhase('K'); _Store.writeBatch('LabForm', tmpMove([ 1, 10 ], [ 2, 11 ], 1001), 'LabForm:1001:Live', 'Live', (pError) => { Expect(pError).to.include({ Phase: 'K', Status: 500 }); return fNext(); }); },
								(fNext) => { fState((pError, pState) => { Expect(pState).to.deep.equal({ Mirror: [ tmpA ], Keymap: [ tmpA ] }); return fNext(pError); }); },
								// A → B with the mirror insert failing: the intent landed, the mirror did not (keymap ⊇ mirror).
								(fNext) => { fFailPhase('M'); _Store.writeBatch('LabForm', tmpMove([ 1, 10 ], [ 2, 11 ], 1002), 'LabForm:1002:Live', 'Live', (pError) => { Expect(pError).to.include({ Phase: 'M' }); return fNext(); }); },
								(fNext) => { fState((pError, pState) => { Expect(pState).to.deep.equal({ Mirror: [ tmpA ], Keymap: [ tmpA, tmpB ].sort() }); return fNext(pError); }); },
								// A → B with the retirements failing: the mirror moved, both keys still live in the keymap.
								(fNext) => { fFailPhase('R'); _Store.writeBatch('LabForm', tmpMove([ 1, 10 ], [ 2, 11 ], 1003), 'LabForm:1003:Live', 'Live', (pError) => { Expect(pError).to.include({ Phase: 'R' }); return fNext(); }); },
								(fNext) => { fState((pError, pState) => { Expect(pState).to.deep.equal({ Mirror: [ tmpB ], Keymap: [ tmpA, tmpB ].sort() }); return fNext(pError); }); },
								// A later cycle (a new flush) tombstones and retires every stale key: B → C (owner unset).
								(fNext) =>
								{
									_Store.Client.setFaultInjector(null);
									_Store.readKeys('LabForm', [ 50, 51 ], 'Live',
										(pError, pKeys) =>
										{
											Expect(pKeys.has(51)).to.equal(false);
											let tmpEntries = pKeys.get(50);
											Expect(tmpEntries).to.have.length(2);
											Expect(tmpEntries.every((pEntry) => { return Number.isSafeInteger(pEntry.Version) && (pEntry.Tracked.IDCustomer === pEntry.Key.IDCustomer); })).to.equal(true);
											let tmpRow = tmpRowAt(2, null);
											let tmpBatch =
												{
													Rows: [ Object.assign({}, tmpRow, { _Version: 1004 }) ],
													Tombstones: tmpEntries.map((pEntry) => { return { ID: 50, Key: pEntry.Key, Version: 1004 }; }),
													KeyIntents: [ { ID: 50, Key: libTypeMap.keyOf(SPEC_PERSONAL, tmpRow), Tracked: libTypeMap.trackedOf(SPEC_PERSONAL, tmpRow), UpdateDate: null, Version: 1004 } ],
													KeyRetires: tmpEntries.map((pEntry) => { return { ID: 50, Key: pEntry.Key, Version: 1004 }; })
												};
											return _Store.writeBatch('LabForm', tmpBatch, 'LabForm:1004:Live', 'Live', fNext);
										});
								},
								(fNext) => { fState((pError, pState) => { Expect(pState).to.deep.equal({ Mirror: [ tmpC ], Keymap: [ tmpC ] }); return fNext(pError); }); },
								// readKeyRange sees the same, bounded.
								(fNext) =>
								{
									_Store.readKeyRange('LabForm', 49, 50, 'Live',
										(pError, pKeys) =>
										{
											Expect(Array.from(pKeys.keys())).to.deep.equal([ 50 ]);
											Expect(pKeys.get(50)[0].Key).to.deep.equal({ IDCustomer: 2, OwnerIDUser: null });
											_Store.readKeyRange('LabForm', 50, null, 'Live', (pAfterError, pAfter) => { Expect(pAfter.has(50)).to.equal(false); return fNext(pAfterError || pError); });
										});
								}
							], fDone);
					});

				test('insert faults: a 5xx before the send and a landed-but-5xx insert are retried with the same token — no loss, no duplicate',
					(fDone) =>
					{
						let tmpPlan = { 'Shadowless:300:Live:M0': [ { Status: 500, When: 'Before' } ], 'Shadowless:301:Live:M0': [ { Status: 503, When: 'After' } ] };
						let tmpSpec = Object.assign({}, SPEC_GLOBAL, { Entity: 'Shadowless' });
						_Store.Client.RetryDelayMS = 1;
						series(
							[
								(fNext) => { _Store.createLive('Shadowless', tmpSpec, fNext); },
								(fNext) =>
								{
									_Store.Client.setFaultInjector((pRequest) => { let tmpQueue = tmpPlan[pRequest.Token]; return (tmpQueue && (tmpQueue.length > 0)) ? tmpQueue.shift() : null; });
									_Store.writeBatch('Shadowless', { Rows: [ { IDFormType: 1, Name: 'a', _Version: 300 } ] }, 'Shadowless:300:Live', 'Live', fNext);
								},
								(fNext) => { _Store.writeBatch('Shadowless', { Rows: [ { IDFormType: 2, Name: 'b', _Version: 301 } ] }, 'Shadowless:301:Live', 'Live', fNext); },
								(fNext) =>
								{
									_Client.query(`SELECT IDFormType, count() AS N FROM ${libDDL.qualified(_Database, 'Shadowless')} GROUP BY IDFormType ORDER BY IDFormType`, null, null,
										(pError, pRows) =>
										{
											// Without FINAL: exactly one physical row each (the landed insert was deduplicated).
											Expect(pRows).to.deep.equal([ { IDFormType: 1, N: 1 }, { IDFormType: 2, N: 1 } ]);
											return fNext(pError);
										});
								}
							], fDone);
					});

				test('shadow tables: beginShadow (leftovers dropped), first enable RENAME, then a rebuild EXCHANGE of mirror and keymap, dropShadow',
					(fDone) =>
					{
						let tmpSpec = Object.assign({}, SPEC_UNSCOPED, { Entity: 'Rebuilt' });
						let tmpRows = (pIDs, pVersion, pTitle) => { return pIDs.map((pID) => { return { IDBook: pID, Deleted: 0, Title: `${pTitle}${pID}`, _Version: pVersion }; }); };
						let tmpIntents = (pIDs, pVersion) => { return pIDs.map((pID) => { return { ID: pID, Key: {}, Tracked: {}, UpdateDate: null, Version: pVersion }; }); };
						let fTables = (fCallback) => { _Client.query("SELECT name FROM system.tables WHERE database = {d:String} AND name LIKE '%Rebuilt%' ORDER BY name", { d: _Database }, null, (pError, pRows) => { return fCallback(pError, (pRows || []).map((pRow) => { return pRow.name; })); }); };
						series(
							[
								(fNext) => { _Client.command(`CREATE TABLE ${libDDL.qualified(_Database, 'Rebuilt__shadow_aaaaaaaa')} (X UInt8) ENGINE = Memory`, null, null, fNext); },
								(fNext) => { _Store.beginShadow('Rebuilt', 'aaaaaaaa', tmpSpec, fNext); },
								(fNext) => { _Store.writeBatch('Rebuilt', { Rows: tmpRows([ 1, 2 ], 400, 'a'), KeyIntents: tmpIntents([ 1, 2 ], 400) }, 'Rebuilt:400:Shadow:aaaaaaaa', 'Shadow:aaaaaaaa', fNext); },
								(fNext) => { _Store.readKeys('Rebuilt', [ 1, 2 ], 'Shadow:aaaaaaaa', (pError, pKeys) => { Expect(pKeys.size).to.equal(2); return fNext(pError); }); },
								(fNext) => { fTables((pError, pNames) => { Expect(pNames).to.deep.equal([ 'Rebuilt__shadow_aaaaaaaa', '_rfs_keys_Rebuilt__shadow_aaaaaaaa' ]); return fNext(pError); }); },
								(fNext) => { _Store.swapShadow('Rebuilt', 'aaaaaaaa', true, fNext); },
								(fNext) => { _Store.dropShadow('Rebuilt', 'aaaaaaaa', fNext); },
								(fNext) => { fTables((pError, pNames) => { Expect(pNames).to.deep.equal([ 'Rebuilt', '_rfs_keys_Rebuilt' ]); return fNext(pError); }); },
								(fNext) => { _Store.readLeafRows('Rebuilt', null, null, [ 'IDBook', 'Title' ], (pError, pRows) => { Expect(pRows).to.deep.equal([ { IDBook: 1, Title: 'a1' }, { IDBook: 2, Title: 'a2' } ]); return fNext(pError); }); },
								// A rebuild: dual writes, then EXCHANGE.
								(fNext) => { _Store.beginShadow('Rebuilt', 'bbbbbbbb', tmpSpec, fNext); },
								(fNext) => { _Store.writeBatch('Rebuilt', { Rows: tmpRows([ 2, 3 ], 500, 'b'), KeyIntents: tmpIntents([ 2, 3 ], 500) }, 'Rebuilt:500:Shadow:bbbbbbbb', 'Shadow:bbbbbbbb', fNext); },
								(fNext) => { _Store.writeBatch('Rebuilt', { Rows: tmpRows([ 9 ], 501, 'live'), KeyIntents: tmpIntents([ 9 ], 501) }, 'Rebuilt:501:Live', 'Live', fNext); },
								(fNext) => { _Store.swapShadow('Rebuilt', 'bbbbbbbb', false, fNext); },
								(fNext) => { _Store.readLeafRows('Rebuilt', null, null, [ 'IDBook', 'Title' ], (pError, pRows) => { Expect(pRows).to.deep.equal([ { IDBook: 2, Title: 'b2' }, { IDBook: 3, Title: 'b3' } ]); return fNext(pError); }); },
								(fNext) => { _Store.readKeyRange('Rebuilt', null, null, 'Live', (pError, pKeys) => { Expect(Array.from(pKeys.keys())).to.deep.equal([ 2, 3 ]); return fNext(pError); }); },
								// The shadow name now holds the old live data; dropShadow removes it.
								(fNext) => { _Client.query(`SELECT IDBook FROM ${libDDL.qualified(_Database, 'Rebuilt__shadow_bbbbbbbb')} FINAL ORDER BY IDBook`, null, null, (pError, pRows) => { Expect(pRows.map((pRow) => { return pRow.IDBook; })).to.deep.equal([ 1, 2, 9 ]); return fNext(pError); }); },
								(fNext) => { _Store.dropShadow('Rebuilt', 'bbbbbbbb', fNext); },
								(fNext) => { fTables((pError, pNames) => { Expect(pNames).to.deep.equal([ 'Rebuilt', '_rfs_keys_Rebuilt' ]); return fNext(pError); }); },
								// ensureSchema reports leftover shadows.
								(fNext) => { _Store.beginShadow('Rebuilt', 'cccccccc', tmpSpec, fNext); },
								(fNext) => { _Store.ensureSchema({ Rebuilt: tmpSpec }, (pError, pResult) => { Expect(pResult.Entities.Rebuilt.Shadows).to.deep.equal([ 'cccccccc' ]); return fNext(pError); }); },
								(fNext) => { _Store.dropShadow('Rebuilt', 'cccccccc', fNext); },
								// A write to a shadow that is gone is not a wipe.
								(fNext) => { _Store.writeBatch('Rebuilt', { Rows: tmpRows([ 4 ], 502, 'x') }, 'Rebuilt:502:Shadow:cccccccc', 'Shadow:cccccccc', (pError) => { Expect(pError).to.include({ StoreError: true, ShadowMissing: true, Code: null }); Expect(libStore.isWipeError(pError)).to.equal(false); return fNext(); }); }
							], fDone);
					});

				test('readState / writeState: null before any write, the full row latest-wins by version, partial updates merge, JSON and dates round-trip',
					(fDone) =>
					{
						let tmpNow = Date.UTC(2026, 9, 8, 12, 0, 0, 250);
						series(
							[
								(fNext) => { _Store.readState('StateProbe', (pError, pState) => { Expect(pState).to.equal(null); return fNext(pError); }); },
								(fNext) => { _Store.writeState('StateProbe', { State: 'Building', Epoch: 0, SpecHash: 'ms:11111111', Version: 1000 }, fNext); },
								(fNext) => { _Store.writeState('StateProbe', { State: 'Live', Epoch: 1, AppliedSeq: { 'e:0a0b0c0d': 42 }, LossyColumns: { SaleDate: 'Compare' }, FillingColumns: [ 'Priority' ], CleanShutdown: true, UnverifiedSince: tmpNow, LastRebuild: new Date(tmpNow), SweepWatermark: '2026-10-08 12:00:00', ScrubCursor: 77, Detail: { Quarantined: 3 }, Version: 2000 }, fNext); },
								(fNext) =>
								{
									_Store.readState('StateProbe',
										(pError, pState) =>
										{
											Expect(pState).to.include({ Store: 'ClickHouse', Entity: 'StateProbe', State: 'Live', Epoch: 1, SpecHash: 'ms:11111111', CleanShutdown: 1, SweepWatermark: '2026-10-08 12:00:00', ScrubCursor: 77, Version: 2000, UnverifiedSince: tmpNow, LastRebuild: tmpNow, LastBisect: null, ScrubbedThrough: null });
											Expect(pState.AppliedSeq).to.deep.equal({ 'e:0a0b0c0d': 42 });
											Expect(pState.LossyColumns).to.deep.equal({ SaleDate: 'Compare' });
											Expect(pState.FillingColumns).to.deep.equal([ 'Priority' ]);
											Expect(pState.Detail).to.deep.equal({ Quarantined: 3 });
											return fNext(pError);
										});
								},
								// An older version never overrides a newer one (ReplacingMergeTree(_Version), FINAL).
								(fNext) => { _Store.writeState('StateProbe', { State: 'Absent', Version: 1500 }, fNext); },
								(fNext) => { _Store.readState('StateProbe', (pError, pState) => { Expect(pState).to.include({ State: 'Live', Version: 2000 }); return fNext(pError); }); },
								// A partial update without a version: merged over the last known state, a version above every one seen.
								(fNext) => { _Store.writeState('StateProbe', { CleanShutdown: 0, UnverifiedSince: null }, (pError, pWritten) => { Expect(pWritten.Version).to.be.above(2000); return fNext(pError); }); },
								(fNext) =>
								{
									_Store.readState('StateProbe',
										(pError, pState) =>
										{
											Expect(pState).to.include({ State: 'Live', SpecHash: 'ms:11111111', CleanShutdown: 0, UnverifiedSince: null, ScrubCursor: 77 });
											Expect(pState.LossyColumns).to.deep.equal({ SaleDate: 'Compare' });
											return fNext(pError);
										});
								},
								// A structured watermark round-trips as JSON.
								(fNext) => { _Store.writeState('StateProbe', { SweepWatermark: { At: '2026-10-08 12:00:00', ID: 5 } }, fNext); },
								(fNext) => { _Store.readState('StateProbe', (pError, pState) => { Expect(pState.SweepWatermark).to.deep.equal({ At: '2026-10-08 12:00:00', ID: 5 }); return fNext(pError); }); }
							], fDone);
					});

				test('bucketChecksums over the keymap\'s live distinct IDs; readLeafRows over a range; maxVersion is the largest _Version in the database',
					(fDone) =>
					{
						let tmpSpec = Object.assign({}, SPEC_UNSCOPED, { Entity: 'Bisected' });
						let tmpIDs = [ 1, 2, 2001, 2002, 3 ];
						series(
							[
								(fNext) => { _Store.createLive('Bisected', tmpSpec, fNext); },
								(fNext) =>
								{
									_Store.writeBatch('Bisected',
										{
											Rows: tmpIDs.map((pID) => { return { IDBook: pID, Deleted: 0, Title: `t${pID}`, _Version: 600 }; }),
											KeyIntents: tmpIDs.map((pID) => { return { ID: pID, Key: {}, Tracked: {}, UpdateDate: null, Version: 600 }; })
										}, 'Bisected:600:Live', 'Live', fNext);
								},
								// ID 3 hard-deleted: tombstone + retire.
								(fNext) => { _Store.writeBatch('Bisected', { Tombstones: [ { ID: 3, Key: {}, Version: 601 } ], KeyRetires: [ { ID: 3, Key: {}, Version: 601 } ] }, 'Bisected:601:Live', 'Live', fNext); },
								(fNext) =>
								{
									_Store.bucketChecksums('Bisected', 2000, 'Live',
										(pError, pBuckets) =>
										{
											Expect(pBuckets).to.deep.equal({ 0: { Count: 2, IDSum: 3 }, 1: { Count: 2, IDSum: 4003 } });
											return fNext(pError);
										});
								},
								(fNext) => { _Store.bucketChecksums('Bisected', 0, 'Live', (pError) => { Expect(pError.message).to.match(/LeafRange/); return fNext(); }); },
								(fNext) =>
								{
									_Store.readLeafRows('Bisected', 1, 2001, null,
										(pError, pRows) =>
										{
											Expect(pRows.map((pRow) => { return pRow.IDBook; })).to.deep.equal([ 2, 2001 ]);
											Expect(Object.keys(pRows[0]).sort()).to.deep.equal(tmpSpec.Columns.map((pColumn) => { return pColumn.Column; }).sort());
											_Store.readLeafRows('Bisected', null, null, [ 'IDBook', '_Version', 'NotAColumn' ], (pAllError, pAll) => { Expect(pAll).to.deep.equal([ 1, 2, 2001, 2002 ].map((pID) => { return { IDBook: pID, _Version: 600 }; })); return fNext(pAllError || pError); });
										});
								},
								(fNext) =>
								{
									_Store.maxVersion(
										(pError, pMax) =>
										{
											// The state rows of the previous test carry a version above the batches.
											Expect(pMax).to.be.a('number');
											Expect(pMax).to.be.at.least(2000);
											_Client.query(`SELECT max(_Version) AS V FROM ${libDDL.qualified(_Database, '_rfs_entity_state')}`, null, null, (pStateError, pRows) => { Expect(pMax).to.equal(Math.max(pRows[0].V, 1004)); return fNext(pStateError || pError); });
										});
								}
							], fDone);
					});

				test('queryRows applies the read settings: a Date32 month bucket before 1970 is right; QuerySettings and call settings layer on top',
					(fDone) =>
					{
						let tmpSQL = "SELECT formatDateTime(toStartOfMonth(toDateTime64('1950-03-15 10:00:00', 3, 'UTC')), '%Y-%m-%d 00:00:00') AS K, getSetting('max_threads') AS T";
						_Store.queryRows(tmpSQL, {}, null, { max_threads: 3 },
							(pError, pRows) =>
							{
								Expect(pError).to.equal(null);
								Expect(pRows[0].K).to.equal('1950-03-01 00:00:00');
								Expect(Number(pRows[0].T)).to.equal(3);
								// Without the extended-results setting the same expression wraps (why every read sends it).
								_Client.query(tmpSQL, null, null,
									(pRawError, pRawRows) =>
									{
										Expect(pRawRows[0].K).to.not.equal('1950-03-01 00:00:00');
										return fDone(pRawError);
									});
							});
					});

				test('health reports the database tables and parts; status after connect',
					(fDone) =>
					{
						_Store.health(
							(pError, pHealth) =>
							{
								Expect(pError).to.equal(null);
								Expect(pHealth).to.include({ Up: true, Database: _Database });
								Expect(pHealth.Tables).to.be.above(3);
								Expect(pHealth.ActivePartsMax).to.be.at.least(1);
								Expect(_Store.stats().Statements).to.be.above(10);
								return fDone();
							});
					});

				test('feature-not-boot against a live server: a wrong port is Up false; wrong credentials are Up false / AuthenticationFailed; never an error',
					(fDone) =>
					{
						let tmpWrongPort = newStore().Store;
						tmpWrongPort.configure(libSupport.storeOptions(_Database, { URL: 'http://127.0.0.1:1', PingTimeoutMS: 300 }));
						tmpWrongPort.connect(
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Up).to.equal(false);
								Expect(tmpWrongPort.status()).to.include({ Available: false, Reason: 'Unreachable' });
								let tmpWrongPassword = newStore();
								tmpWrongPassword.Store.configure(libSupport.storeOptions(_Database, { Password: 'definitely-not-the-password' }));
								tmpWrongPassword.Store.connect(
									(pAuthError, pAuthResult) =>
									{
										Expect(pAuthError).to.equal(null);
										Expect(pAuthResult.Up).to.equal(false);
										Expect(tmpWrongPassword.Store.status()).to.include({ Available: false, Reason: 'AuthenticationFailed' });
										Expect(tmpWrongPassword.Logged.join('\n')).to.not.contain('definitely-not-the-password');
										tmpWrongPassword.Store.close();
										return fDone();
									});
							});
					});

				test('a wiped database: writes and state reads fail with a wipe error (codes 60 / 81); ensureSchema recreates the database',
					(fDone) =>
					{
						let tmpWiped = newStore();
						let tmpDatabase = libSupport.freshDatabase();
						tmpWiped.Store.configure(libSupport.storeOptions(tmpDatabase));
						series(
							[
								(fNext) => { tmpWiped.Store.ensureSchema({ FormType: SPEC_GLOBAL }, fNext); },
								(fNext) => { tmpWiped.Store.createLive('FormType', SPEC_GLOBAL, fNext); },
								(fNext) => { tmpWiped.Store.writeBatch('FormType', { Rows: [ { IDFormType: 1, Name: 'x', _Version: 1 } ] }, 'FormType:1:Live', 'Live', fNext); },
								(fNext) => { tmpWiped.Store.dropDatabase(fNext); },
								(fNext) =>
								{
									tmpWiped.Store.writeBatch('FormType', { Rows: [ { IDFormType: 2, Name: 'y', _Version: 2 } ] }, 'FormType:2:Live', 'Live',
										(pError) =>
										{
											Expect(pError).to.include({ StoreError: true, Wipe: true });
											Expect([ 60, 81 ]).to.include(pError.Code);
											Expect(libStore.isWipeError(pError)).to.equal(true);
											return fNext();
										});
								},
								(fNext) => { tmpWiped.Store.readState('FormType', (pError) => { Expect(pError).to.include({ Wipe: true }); Expect([ 60, 81 ]).to.include(pError.Code); return fNext(); }); },
								// No table left: the floor is the highest version this store wrote (its clock never goes back).
								(fNext) => { tmpWiped.Store.maxVersion((pError, pMax) => { Expect(pMax).to.equal(tmpWiped.Store._StateVersionFloor); return fNext(pError); }); },
								(fNext) => { tmpWiped.Store.ensureSchema({ FormType: SPEC_GLOBAL }, (pError, pResult) => { Expect(pResult.Entities.FormType.MirrorExists).to.equal(false); return fNext(pError); }); },
								(fNext) => { tmpWiped.Store.dropDatabase(fNext); }
							],
							(pError) =>
							{
								tmpWiped.Store.close();
								libSupport.release(tmpDatabase, () => { return fDone(pError); });
							});
					});
			}
		);

		gatedSuite(CLICKHOUSE.Available)
		(
			'the static loader and the O10 invariant on the SQLite fixtures (CH-gated)',
			() =>
			{
				[ 'LabTrack', 'Bookstore' ].forEach(
					(pFixture) =>
					{
						test(`${pFixture}: loadMirrors mirrors every facetable entity; the mirror equals the source for each; Lossy flags reported`,
							function (fDone)
							{
								this.timeout(60000);
								let tmpDatabase = libSupport.freshDatabase();
								let tmpHarness = libHarness.start({ Port: 19141, Fixture: pFixture, LogLevel: 'fatal' },
									(pStartError) =>
									{
										if (pStartError)
										{
											return fDone(pStartError);
										}
										let fFinish = (pError) =>
										{
											tmpHarness.fable.RetoldFacetingStoreClickHouse.close();
											libSupport.release(tmpDatabase, () => { tmpHarness.stop(() => { return fDone(pError); }); });
										};
										libSupport.loadMirrors(tmpHarness, { Database: tmpDatabase },
											(pLoadError, pResult) =>
											{
												if (pLoadError)
												{
													return fFinish(pLoadError);
												}
												let tmpEntities = Object.keys(pResult.Specs).sort();
												try
												{
													Expect(pResult.Disabled).to.deep.equal([]);
													Expect(tmpEntities).to.deep.equal(tmpHarness.fable.RetoldFacetingCatalog.entities().slice().sort());
													if (pFixture === 'Bookstore')
													{
														Expect(pResult.Entities.BookStoreSale.Lossy).to.deep.equal({ SaleDate: 'Compare' });
														Expect(pResult.Entities.BookStoreInventory.Lossy).to.deep.equal({ BookCount: 'Value' });
														Expect(pResult.Entities.BookPrice.Lossy).to.deep.equal({ EndDate: 'Value' });
													}
													else
													{
														Expect(pResult.Entities.LabForm.Rows).to.be.above(100);
													}
												}
												catch (pAssertError)
												{
													return fFinish(pAssertError);
												}
												let tmpIndex = 0;
												let fNext = (pError) =>
												{
													if (pError || (tmpIndex >= tmpEntities.length))
													{
														return fFinish(pError);
													}
													let tmpEntity = tmpEntities[tmpIndex++];
													libSupport.assertMirrorEqualsSource(tmpHarness, 'ClickHouse', tmpEntity,
														(pAssertError, pReport) =>
														{
															if (!pAssertError)
															{
																Expect(pReport.Rows).to.equal(pResult.Entities[tmpEntity].Rows);
															}
															return fNext(pAssertError);
														});
												};
												fNext();
											});
									});
							});
					});

				test('assertMirrorEqualsSource reports Missing / Extra / Different / keymap mismatches by ID and column name only',
					function (fDone)
					{
						this.timeout(60000);
						let tmpDatabase = libSupport.freshDatabase();
						let tmpHarness = libHarness.start({ Port: 19141, Fixture: 'ProjectTrack', LogLevel: 'fatal' },
							(pStartError) =>
							{
								if (pStartError)
								{
									return fDone(pStartError);
								}
								let tmpStore = tmpHarness.fable.RetoldFacetingStoreClickHouse;
								let fFinish = (pError) =>
								{
									tmpStore.close();
									libSupport.release(tmpDatabase, () => { tmpHarness.stop(() => { return fDone(pError); }); });
								};
								libSupport.loadMirrors(tmpHarness, { Database: tmpDatabase, Entities: [ 'Client', 'Project' ] },
									(pLoadError, pResult) =>
									{
										if (pLoadError)
										{
											return fFinish(pLoadError);
										}
										let tmpSpec = pResult.Specs.Client;
										libSupport.expectedRows(tmpHarness, tmpSpec,
											(pReadError, pExpected) =>
											{
												let tmpIDs = Array.from(pExpected.Rows.keys()).sort((pA, pB) => { return pA - pB; });
												let tmpChanged = Object.assign({}, pExpected.Rows.get(tmpIDs[0]), { Name: 'Tampered Name', _Version: Date.now() * 2000 });
												let tmpGhost = { IDClient: 999999, IDCustomer: 1, Name: 'Ghost', Deleted: 0, _Version: Date.now() * 2000 };
												series(
													[
														(fNext) => { tmpStore.writeBatch('Client', { Rows: [ tmpChanged, tmpGhost ], Tombstones: [ { ID: tmpIDs[1], Key: libTypeMap.keyOf(tmpSpec, pExpected.Rows.get(tmpIDs[1])), Version: Date.now() * 2000 } ] }, `Client:${Date.now()}:Live`, 'Live', fNext); }
													],
													(pWriteError) =>
													{
														if (pWriteError || pReadError)
														{
															return fFinish(pWriteError || pReadError);
														}
														libSupport.assertMirrorEqualsSource(tmpHarness, 'ClickHouse', 'Client',
															(pError, pReport) =>
															{
																try
																{
																	Expect(pError).to.be.an('error');
																	Expect(pError.Report).to.deep.equal(pReport);
																	Expect(pReport.Missing).to.deep.equal([ tmpIDs[1] ]);
																	Expect(pReport.Extra).to.deep.equal([ 999999 ]);
																	Expect(pReport.Different).to.deep.equal([ tmpIDs[0] ]);
																	Expect(pReport.Columns[tmpIDs[0]]).to.deep.equal([ 'Name' ]);
																	// The ghost has no keymap key; the tombstoned ID keeps its (now stale) key.
																	Expect(pReport.KeymapMissing).to.deep.equal([ 999999 ]);
																	Expect(pReport.KeymapExtra).to.deep.equal([ tmpIDs[1] ]);
																	// IDs and column names only: no value anywhere.
																	Expect(JSON.stringify(pReport)).to.not.contain('Tampered');
																	Expect(pError.message).to.not.contain('Tampered');
																}
																catch (pAssertError)
																{
																	return fFinish(pAssertError);
																}
																// The other entity is still equal.
																libSupport.assertMirrorEqualsSource(tmpHarness, 'ClickHouse', 'Project', (pProjectError) => { return fFinish(pProjectError); });
															});
													});
											});
									});
							});
					});
			}
		);

		gatedSuite(CLICKHOUSE.Available && POSTGRES.Available)
		(
			'the static loader on PostgreSQL (PG + CH gated)',
			() =>
			{
				[ 'ProjectTrack', 'Bookstore' ].forEach(
					(pFixture) =>
					{
						test(`${pFixture} on PostgreSQL: Dates and numeric text convert exactly; the mirror equals the source for every entity`,
							function (fDone)
							{
								this.timeout(90000);
								let tmpDatabase = libSupport.freshDatabase();
								let tmpHarness = libHarness.start({ Port: 19141, Fixture: pFixture, Provider: 'PostgreSQL', LogLevel: 'fatal' },
									(pStartError) =>
									{
										if (pStartError)
										{
											return fDone(pStartError);
										}
										let fFinish = (pError) =>
										{
											tmpHarness.fable.RetoldFacetingStoreClickHouse.close();
											libSupport.release(tmpDatabase, () => { tmpHarness.stop(() => { return fDone(pError); }); });
										};
										Expect(libSupport.sourceDialect(tmpHarness, (pFixture === 'Bookstore') ? 'Book' : 'Project')).to.equal('PostgreSQL');
										libSupport.loadMirrors(tmpHarness, { Database: tmpDatabase },
											(pLoadError, pResult) =>
											{
												if (pLoadError)
												{
													return fFinish(pLoadError);
												}
												if (pFixture === 'Bookstore')
												{
													// PostgreSQL typed columns cannot hold '' or non-canonical text: no Compare / Value flags from those traps.
													Expect(pResult.Entities.BookStoreSale.Lossy).to.deep.equal({});
												}
												let tmpEntities = Object.keys(pResult.Specs).sort();
												let tmpIndex = 0;
												let fNext = (pError) =>
												{
													if (pError || (tmpIndex >= tmpEntities.length))
													{
														return fFinish(pError);
													}
													libSupport.assertMirrorEqualsSource(tmpHarness, 'ClickHouse', tmpEntities[tmpIndex++], (pAssertError) => { return fNext(pAssertError); });
												};
												fNext();
											});
									});
							});
					});
			}
		);
	}
);
