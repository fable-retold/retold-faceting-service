/**
 * Facet-Harness-Providers — the storage-provider hook the test harness requires (internal-contracts
 * §32.2), so the harness (domains, principals, oracles) and the provider plumbing (SQLite in memory,
 * PostgreSQL in the rfs-test-postgres container) live in different files.
 *
 *   let libProviders = require('./Facet-Harness-Providers.js');
 *   libProviders.available('PostgreSQL')                         → { Available, Reason }
 *   libProviders.fableSettings('SQLite', pHarnessOptions)       → settings merged into new libFable(…)
 *   libProviders.connect('SQLite', pFable, pHarnessOptions, (pError, pConnection) => …)
 *   libProviders.seed(pConnection, libBookstoreSeed, { Fixture, Seed, Scale }, (pError, pSeedResult) => …)
 *   libProviders.release(pConnection, (pError) => …)
 *
 * pConnection = { Provider, StorageProvider, db, pool, Database, Coerced }:
 *   SQLite      db = the node:sqlite DatabaseSync (fable.MeadowSQLiteProvider.db), pool null
 *   PostgreSQL  pool = the pg.Pool of fable.MeadowPostgreSQLProvider on a FRESH per-harness database
 *               rfs_<pid>_<n> (CREATE DATABASE … TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C'
 *               LC_CTYPE 'C'), dropped by release(); db null
 *
 * PostgreSQL (internal-contracts §33):
 *   - gated: RFS_TEST_POSTGRES=1 (the rfs-test-postgres container, test/support/Facet-Docker-Postgres.js)
 *     or RFS_TEST_POSTGRES_URL; otherwise available() says no and the harness skips the suite
 *     (an error with .Skip === true);
 *   - refuses to run unless the process time zone is UTC (node-postgres reads `timestamp` values as
 *     LOCAL wall clock; `npm run test:pg` sets TZ=UTC);
 *   - tables come from the model with NULLABLE columns and no defaults (seeded NULLs stay NULL):
 *     ID → SERIAL PRIMARY KEY (explicit IDs inserted, then setval), GUID → VARCHAR(n),
 *     Numeric / ForeignKey / audit users → INTEGER, Decimal → DECIMAL(p,s), String → VARCHAR(n),
 *     Text / JSON → TEXT, DateTime → TIMESTAMP, Boolean (incl. Deleted) → SMALLINT
 *     (meadow's PostgreSQL convention), never meadow-connection-postgresql's createTables (its
 *     NOT NULL defaults would rewrite seeded NULLs, and its BOOLEAN differs from the SMALLINT the
 *     meadow provider binds);
 *   - rows are pSeedModule.generate(…).Rows inserted in Order, in batches; a value a typed column
 *     cannot hold ('' / ' ' in an INTEGER, an unparseable date) is inserted as NULL and listed in
 *     pConnection.Coerced (and the seed result's Coerced);
 *   - the seed result has the SQLite build() shape (Counts, LiveCounts, TenantCounts,
 *     TenantLiveCounts counted by SQL on the PostgreSQL database) plus every field generate()
 *     returned (Traps, Principals, Rows, Order, TenantColumn, …).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libFacetBuckets = require('../../source/contract/Facet-Contract-Buckets.js');
const libDockerPostgres = require('./Facet-Docker-Postgres.js');
const libBookstoreSeed = require('../fixtures/Bookstore-Seed.js');

const PROVIDERS = Object.freeze([ 'SQLite', 'PostgreSQL' ]);

// Rows per INSERT statement (and never more than this many bound values: PostgreSQL allows 65535).
const INSERT_BATCH_ROWS = 500;
const INSERT_MAX_BINDS = 30000;

// Database names this process created and has not dropped yet (never dropped by the leftover sweep).
const ACTIVE_DATABASES = new Set();

let _DatabaseCounter = 0;

// The server answered ensure() once in this process: later harnesses skip the docker round trips.
let _EnsuredInfo = null;

/**
 * Is the PostgreSQL gate on?
 *
 * @return {boolean}
 */
const postgresGateOn = () =>
{
	return (process.env.RFS_TEST_POSTGRES === '1')
		|| ((typeof(process.env.RFS_TEST_POSTGRES_URL) === 'string') && (process.env.RFS_TEST_POSTGRES_URL.length > 0));
};

/**
 * node-postgres reads `timestamp without time zone` as local time; only a UTC process gives the
 * stored wall clock back unchanged (internal-contracts §33.2).
 *
 * @return {boolean}
 */
const timeZoneIsUTC = () =>
{
	return (new Date(2020, 0, 1).getTimezoneOffset() === 0) && (new Date(2020, 6, 1).getTimezoneOffset() === 0);
};

/**
 * Can a module be resolved from here (the umbrella node_modules)?
 *
 * @param {string} pModule
 * @return {boolean}
 */
const resolvable = (pModule) =>
{
	try
	{
		require.resolve(pModule);
		return true;
	}
	catch (pError)
	{
		return false;
	}
};

/**
 * Is a provider usable in this process?  SQLite always; PostgreSQL only when gated on
 * (RFS_TEST_POSTGRES=1 or RFS_TEST_POSTGRES_URL), so plain `npm test` stays SQLite-only.
 *
 * @param {string} pProvider
 * @return {{ Available: boolean, Reason: string|null }}
 */
const available = (pProvider) =>
{
	if (pProvider === 'SQLite')
	{
		return { Available: true, Reason: null };
	}
	if (pProvider === 'PostgreSQL')
	{
		if (!postgresGateOn())
		{
			return { Available: false, Reason: 'PostgreSQL tests are off (set RFS_TEST_POSTGRES=1 or RFS_TEST_POSTGRES_URL; `npm run test:pg`).' };
		}
		if (!resolvable('pg') || !resolvable('meadow-connection-postgresql'))
		{
			return { Available: false, Reason: 'pg / meadow-connection-postgresql are not installed in the umbrella node_modules.' };
		}
		return { Available: true, Reason: null };
	}
	return { Available: false, Reason: `Unknown provider [${pProvider}].` };
};

/**
 * The next per-harness database name: rfs_<pid>_<counter> (internal-contracts §33.3).
 *
 * @return {string}
 */
const nextDatabaseName = () =>
{
	_DatabaseCounter++;
	return `rfs_${process.pid}_${_DatabaseCounter}`;
};

/**
 * Settings merged into the harness fable's constructor settings.
 *
 * @param {string} pProvider
 * @param {Record<string, any>} pHarnessOptions
 * @return {Record<string, any>}
 */
const fableSettings = (pProvider, pHarnessOptions) =>
{
	if (pProvider === 'SQLite')
	{
		return { SQLite: { SQLiteFilePath: ':memory:' } };
	}
	if (pProvider === 'PostgreSQL')
	{
		let tmpInfo = libDockerPostgres.connectionInfo();
		// The database does not exist yet: connect() creates it under exactly this name.
		return { PostgreSQL: { host: tmpInfo.host, port: tmpInfo.port, user: tmpInfo.user, password: tmpInfo.password, database: nextDatabaseName(), max: 4 } };
	}
	throw new Error(`Facet-Harness-Providers: no fable settings for provider [${pProvider}].`);
};

/**
 * An Error the harness turns into a skipped suite.
 *
 * @param {string} pMessage
 * @return {Error}
 */
const skipError = (pMessage) =>
{
	let tmpError = new Error(pMessage);
	tmpError.Skip = true;
	return tmpError;
};

/**
 * Register and connect the Meadow<Provider>Provider on the harness fable.
 *
 * @param {string} pProvider
 * @param {any} pFable
 * @param {Record<string, any>} pHarnessOptions
 * @param {(pError?: Error, pConnection?: Record<string, any>) => void} fCallback
 */
const connect = (pProvider, pFable, pHarnessOptions, fCallback) =>
{
	if (pProvider === 'PostgreSQL')
	{
		return connectPostgreSQL(pFable, pHarnessOptions, fCallback);
	}
	if (pProvider !== 'SQLite')
	{
		return fCallback(skipError(available(pProvider).Reason || `Facet-Harness-Providers: provider [${pProvider}] is unavailable.`));
	}
	pFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
	pFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
	pFable.MeadowSQLiteProvider.connectAsync(
		(pConnectError) =>
		{
			if (pConnectError)
			{
				return fCallback(pConnectError);
			}
			return fCallback(null, { Provider: 'SQLite', StorageProvider: 'SQLite', db: pFable.MeadowSQLiteProvider.db, pool: null, Database: ':memory:', Coerced: [] });
		});
};

/**
 * PostgreSQL: start / reuse the server, create this harness's database, connect the meadow
 * PostgreSQL provider to it.
 *
 * @param {any} pFable
 * @param {Record<string, any>} pHarnessOptions
 * @param {(pError?: Error, pConnection?: Record<string, any>) => void} fCallback
 */
const connectPostgreSQL = (pFable, pHarnessOptions, fCallback) =>
{
	let tmpAvailable = available('PostgreSQL');
	if (!tmpAvailable.Available)
	{
		return fCallback(skipError(tmpAvailable.Reason));
	}
	if (!timeZoneIsUTC())
	{
		return fCallback(new Error('Facet-Harness-Providers: the PostgreSQL provider needs TZ=UTC (node-postgres reads timestamp values as local time). Run `npm run test:pg`, or set TZ=UTC.'));
	}
	let tmpSettings = (pFable.settings && pFable.settings.PostgreSQL && (typeof(pFable.settings.PostgreSQL) === 'object')) ? pFable.settings.PostgreSQL : null;
	let tmpDatabase = (tmpSettings && libDockerPostgres.DATABASE_NAME_PATTERN.test(String(tmpSettings.database))) ? tmpSettings.database : nextDatabaseName();
	ACTIVE_DATABASES.add(tmpDatabase);

	let fEnsure = (fEnsured) =>
	{
		if (_EnsuredInfo)
		{
			return fEnsured(null, _EnsuredInfo);
		}
		libDockerPostgres.ensure({ Keep: Array.from(ACTIVE_DATABASES) },
			(pEnsureError, pInfo) =>
			{
				if (!pEnsureError)
				{
					_EnsuredInfo = pInfo;
				}
				return fEnsured(pEnsureError, pInfo);
			});
	};

	fEnsure(
		(pEnsureError, pInfo) =>
		{
			if (pEnsureError)
			{
				ACTIVE_DATABASES.delete(tmpDatabase);
				return fCallback(pEnsureError);
			}
			// The name matched DATABASE_NAME_PATTERN (or was generated), so it is safe to quote.  The
			// production-like mode (PostgresSchema 'Meadow') runs under an ICU en-US collation, the kind a
			// real deployment has (case- and punctuation-aware ordering), instead of C.
			let tmpICU = (pHarnessOptions && (pHarnessOptions.PostgresSchema === 'Meadow'));
			let tmpCreate = tmpICU
				? `CREATE DATABASE "${tmpDatabase}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`
				: `CREATE DATABASE "${tmpDatabase}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`;
			libDockerPostgres.adminQuery(pInfo, tmpCreate, [],
				(pCreateError) =>
				{
					if (pCreateError)
					{
						ACTIVE_DATABASES.delete(tmpDatabase);
						// The server may have gone away since it was ensured: check it again next time.
						_EnsuredInfo = null;
						return fCallback(new Error(`Facet-Harness-Providers: could not create the test database ${tmpDatabase}: ${pCreateError.message}`));
					}
					let tmpConnection = (
						{
							Provider: 'PostgreSQL',
							StorageProvider: 'PostgreSQL',
							db: null,
							pool: null,
							Database: tmpDatabase,
							Coerced: [],
							Server: { host: pInfo.host, port: pInfo.port, Source: pInfo.Source },
							// 'Harness' (nullable typed DDL, SMALLINT booleans, C collation) or 'Meadow' (the
							// production DDL of meadow-connection-postgresql: BOOLEAN / NOT NULL defaults, ICU).
							Schema: tmpICU ? 'Meadow' : 'Harness',
							_Fable: pFable,
							_Info: pInfo,
							_Released: false
						});
					let tmpProviderSettings = { host: pInfo.host, port: pInfo.port, user: pInfo.user, password: pInfo.password, database: tmpDatabase, max: (tmpSettings && (tmpSettings.max >= 1)) ? tmpSettings.max : 4 };
					try
					{
						pFable.serviceManager.addServiceType('MeadowPostgreSQLProvider', require('meadow-connection-postgresql'));
						pFable.serviceManager.instantiateServiceProvider('MeadowPostgreSQLProvider', { PostgreSQL: tmpProviderSettings });
					}
					catch (pProviderError)
					{
						return release(tmpConnection, () => { return fCallback(pProviderError); });
					}
					pFable.MeadowPostgreSQLProvider.connectAsync(
						(pConnectError, pPool) =>
						{
							if (pConnectError || !pPool)
							{
								return release(tmpConnection, () => { return fCallback(pConnectError || new Error('Facet-Harness-Providers: the PostgreSQL pool did not open.')); });
							}
							tmpConnection.pool = pPool;
							// An idle client losing its server (e.g. a forced drop) must never crash the test process.
							pPool.on('error', (pPoolError) => { pFable.log.warn(`Facet-Harness-Providers: idle PostgreSQL client error: ${pPoolError.message}`); });
							pPool.query('SELECT "d"."datcollate" AS "Collate", current_setting(\'server_version_num\') AS "Version" FROM pg_database "d" WHERE "d"."datname" = current_database()',
								(pProbeError, pProbe) =>
								{
									if (pProbeError)
									{
										return release(tmpConnection, () => { return fCallback(pProbeError); });
									}
									let tmpRow = pProbe.rows[0] || {};
									let tmpExpectedCollate = tmpICU ? 'en_US.utf8' : 'C';
									if (tmpRow.Collate !== tmpExpectedCollate)
									{
										return release(tmpConnection, () => { return fCallback(new Error(`Facet-Harness-Providers: ${tmpDatabase} has collation ${tmpRow.Collate}, not ${tmpExpectedCollate}.`)); });
									}
									tmpConnection.ServerVersion = parseInt(tmpRow.Version, 10);
									return fCallback(null, tmpConnection);
								});
						});
				});
		});
};

/**
 * The PostgreSQL column type of a model column (internal-contracts §33.3).
 *
 * @param {Record<string, any>} pColumn - { Column, DataType, Size }
 * @return {string}
 */
const postgresType = (pColumn) =>
{
	let tmpSize = (pColumn.Size === null || (typeof(pColumn.Size) === 'undefined')) ? '' : String(pColumn.Size).trim();
	switch (pColumn.DataType)
	{
		case 'ID':
			return 'SERIAL PRIMARY KEY';
		case 'GUID':
			return /^[0-9]+$/.test(tmpSize) ? `VARCHAR(${tmpSize})` : 'VARCHAR(255)';
		case 'String':
			return /^[0-9]+$/.test(tmpSize) ? `VARCHAR(${tmpSize})` : 'TEXT';
		case 'Numeric':
		case 'ForeignKey':
			return (tmpSize.toLowerCase() === 'bigint') ? 'BIGINT' : 'INTEGER';
		case 'Decimal':
			return /^[0-9]+\s*,\s*[0-9]+$/.test(tmpSize) ? `DECIMAL(${tmpSize.replace(/\s+/g, '')})` : 'NUMERIC';
		case 'DateTime':
			return 'TIMESTAMP';
		case 'Boolean':
			return 'SMALLINT';
		case 'Text':
		case 'JSON':
		default:
			return 'TEXT';
	}
};

/**
 * A quoted identifier from the model (refuses anything that is not a plain identifier).
 *
 * @param {string} pIdentifier
 * @return {string}
 */
const quoteIdentifier = (pIdentifier) =>
{
	if ((typeof(pIdentifier) !== 'string') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pIdentifier))
	{
		throw new Error(`Facet-Harness-Providers: refusing the identifier [${pIdentifier}].`);
	}
	return `"${pIdentifier}"`;
};

/**
 * CREATE TABLE for one model table: nullable columns, no defaults.
 *
 * @param {string} pTableName
 * @param {Record<string, any>} pTable - model table ({ Columns: [ … ] })
 * @return {string}
 */
const createTableStatement = (pTableName, pTable) =>
{
	let tmpColumns = pTable.Columns.map((pColumn) => { return `${quoteIdentifier(pColumn.Column)} ${postgresType(pColumn)}`; });
	return `CREATE TABLE ${quoteIdentifier(pTableName)} (${tmpColumns.join(', ')})`;
};

/**
 * A seeded value as the typed PostgreSQL column can hold it.  Values the column cannot hold become
 * NULL with a reason (internal-contracts §33.3).
 *
 * @param {Record<string, any>} pColumn - model column
 * @param {any} pValue
 * @return {{ Value: any, Reason: string|null }}
 */
const coerceValue = (pColumn, pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return { Value: null, Reason: null };
	}
	switch (pColumn.DataType)
	{
		case 'ID':
		case 'Numeric':
		case 'ForeignKey':
			{
				let tmpNumber = (typeof(pValue) === 'boolean') ? (pValue ? 1 : 0) : libFacetBuckets.numericValue(pValue);
				if ((tmpNumber === null) || !Number.isInteger(tmpNumber))
				{
					return { Value: null, Reason: 'NotInteger' };
				}
				return { Value: tmpNumber, Reason: null };
			}
		case 'Boolean':
			{
				let tmpNumber = libFacetBuckets.numericValue(pValue);
				if ((tmpNumber !== 0) && (tmpNumber !== 1))
				{
					return { Value: null, Reason: 'NotBoolean' };
				}
				return { Value: tmpNumber, Reason: null };
			}
		case 'Decimal':
			{
				let tmpNumber = libFacetBuckets.numericValue(pValue);
				if (tmpNumber === null)
				{
					return { Value: null, Reason: 'NotNumeric' };
				}
				// Bind the original text when it is a numeric literal (exact), else the number.
				return { Value: (typeof(pValue) === 'string') ? pValue.trim() : tmpNumber, Reason: null };
			}
		case 'DateTime':
			{
				let tmpCanonical = libFacetBuckets.canonicalDateTime(pValue);
				if (tmpCanonical === null)
				{
					return { Value: null, Reason: 'NotDate' };
				}
				return { Value: tmpCanonical, Reason: null };
			}
		case 'Text':
		case 'JSON':
			return { Value: (typeof(pValue) === 'object') ? JSON.stringify(pValue) : String(pValue), Reason: null };
		default:
			return { Value: (typeof(pValue) === 'string') ? pValue : String(pValue), Reason: null };
	}
};

/**
 * A seeded value as the PRODUCTION (meadow-connection-postgresql) DDL holds it: NOT NULL columns take
 * their DEFAULT for a NULL (INTEGER 0, VARCHAR '', BOOLEAN false) and booleans are real booleans.
 *
 * @param {Record<string, any>} pColumn - model column
 * @param {any} pValue
 * @return {{ Value: any, Reason: string|null, Stored: any }} Stored: the value as the JS oracles see it (booleans stay 0/1)
 */
const coerceMeadowValue = (pColumn, pValue) =>
{
	let tmpCoerced = coerceValue(pColumn, pValue);
	switch (pColumn.DataType)
	{
		case 'Numeric':
		case 'ForeignKey':
			if (tmpCoerced.Value === null)
			{
				return { Value: 0, Reason: tmpCoerced.Reason || ((pValue === null) || (typeof(pValue) === 'undefined') ? null : 'NotInteger'), Stored: 0 };
			}
			return Object.assign(tmpCoerced, { Stored: tmpCoerced.Value });
		case 'String':
			if (tmpCoerced.Value === null)
			{
				return { Value: '', Reason: null, Stored: '' };
			}
			return Object.assign(tmpCoerced, { Stored: tmpCoerced.Value });
		case 'Boolean':
			return { Value: (tmpCoerced.Value === 1), Reason: tmpCoerced.Reason, Stored: (tmpCoerced.Value === 1) ? 1 : 0 };
		default:
			return Object.assign(tmpCoerced, { Stored: tmpCoerced.Value });
	}
};

/**
 * Run statements one after the other on one pg client.
 *
 * @param {any} pClient
 * @param {Array<{ text: string, values?: Array<any> }>} pStatements
 * @param {(pError?: Error) => void} fCallback
 */
const runSequence = (pClient, pStatements, fCallback) =>
{
	let fNext = (pIndex) =>
	{
		if (pIndex >= pStatements.length)
		{
			return fCallback();
		}
		pClient.query(pStatements[pIndex].text, pStatements[pIndex].values || [],
			(pError) =>
			{
				if (pError)
				{
					let tmpError = new Error(`Facet-Harness-Providers: ${pError.message} [${pStatements[pIndex].text.slice(0, 160)}]`);
					return fCallback(tmpError);
				}
				return fNext(pIndex + 1);
			});
	};
	return fNext(0);
};

/**
 * The DDL + INSERT + setval statements that load a generated fixture into PostgreSQL.
 *
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 * @param {Array<string>} pOrder
 * @param {Array<Record<string, any>>} pCoerced - receives { Table, Column, Key, Value, Reason }
 * @return {Array<{ text: string, values?: Array<any> }>}
 */
const loadStatements = (pModel, pRows, pOrder, pCoerced, pMeadowSchema) =>
{
	let tmpStatements = [];
	let tmpTables = Object.keys(pModel.Tables);
	let fCoerce = pMeadowSchema ? coerceMeadowValue : coerceValue;
	for (let i = 0; i < tmpTables.length; i++)
	{
		if (pMeadowSchema)
		{
			// The production DDL, exactly as meadow-connection-postgresql's createTables writes it.
			let tmpDDL = pMeadowSchema.generateCreateTableStatement(Object.assign({ TableName: tmpTables[i] }, pModel.Tables[tmpTables[i]]));
			tmpStatements.push({ text: tmpDDL.split('\n').filter((pLine) => { return !/^\s*--/.test(pLine); }).join('\n') });
		}
		else
		{
			tmpStatements.push({ text: createTableStatement(tmpTables[i], pModel.Tables[tmpTables[i]]) });
		}
	}

	let tmpOrder = (Array.isArray(pOrder) ? pOrder : []).filter((pTable) => { return pModel.Tables.hasOwnProperty(pTable); });
	Object.keys(pRows || {}).forEach(
		(pTable) =>
		{
			if ((tmpOrder.indexOf(pTable) < 0) && pModel.Tables.hasOwnProperty(pTable))
			{
				tmpOrder.push(pTable);
			}
		});

	for (let i = 0; i < tmpOrder.length; i++)
	{
		let tmpTableName = tmpOrder[i];
		let tmpColumns = pModel.Tables[tmpTableName].Columns;
		let tmpPrimaryKey = tmpColumns.find((pColumn) => { return pColumn.DataType === 'ID'; });
		let tmpTableRows = Array.isArray(pRows[tmpTableName]) ? pRows[tmpTableName] : [];
		let tmpBatchRows = Math.max(1, Math.min(INSERT_BATCH_ROWS, Math.floor(INSERT_MAX_BINDS / Math.max(1, tmpColumns.length))));
		let tmpColumnList = tmpColumns.map((pColumn) => { return quoteIdentifier(pColumn.Column); }).join(', ');
		for (let tmpStart = 0; tmpStart < tmpTableRows.length; tmpStart += tmpBatchRows)
		{
			let tmpValues = [];
			let tmpTuples = [];
			let tmpEnd = Math.min(tmpTableRows.length, tmpStart + tmpBatchRows);
			for (let j = tmpStart; j < tmpEnd; j++)
			{
				let tmpRow = tmpTableRows[j];
				let tmpPlaceholders = [];
				for (let k = 0; k < tmpColumns.length; k++)
				{
					let tmpColumn = tmpColumns[k];
					let tmpRaw = (Object.prototype.hasOwnProperty.call(tmpRow, tmpColumn.Column)) ? tmpRow[tmpColumn.Column] : null;
					let tmpCoerced = fCoerce(tmpColumn, tmpRaw);
					if (tmpCoerced.Reason)
					{
						pCoerced.push({ Table: tmpTableName, Column: tmpColumn.Column, Key: tmpPrimaryKey ? tmpRow[tmpPrimaryKey.Column] : null, Value: tmpRaw, Reason: tmpCoerced.Reason });
					}
					if (pMeadowSchema && (tmpColumn.DataType !== 'ID') && (tmpCoerced.Stored !== tmpRaw))
					{
						// The JS oracles must see what the database holds (a NULL FK stored as the DEFAULT 0, …).
						tmpRow[tmpColumn.Column] = tmpCoerced.Stored;
					}
					tmpValues.push(tmpCoerced.Value);
					tmpPlaceholders.push(`$${tmpValues.length}`);
				}
				tmpTuples.push(`(${tmpPlaceholders.join(', ')})`);
			}
			tmpStatements.push({ text: `INSERT INTO ${quoteIdentifier(tmpTableName)} (${tmpColumnList}) VALUES ${tmpTuples.join(', ')}`, values: tmpValues });
		}
	}

	// The same indexes the SQLite fixtures get (FK / Join, GUID, tenancy / owner columns), after the rows.
	for (let i = 0; i < tmpTables.length; i++)
	{
		libBookstoreSeed.indexColumns(pModel.Tables[tmpTables[i]]).forEach(
			(pColumn) =>
			{
				tmpStatements.push({ text: `CREATE INDEX ${quoteIdentifier(`IX_${tmpTables[i]}_${pColumn}`.slice(0, 63))} ON ${quoteIdentifier(tmpTables[i])} (${quoteIdentifier(pColumn)})` });
			});
	}

	// Planner statistics for the fresh data (the selective correlation index over the tenancy one).
	tmpStatements.push({ text: 'ANALYZE' });

	// SERIAL sequences continue after the explicit IDs.
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpPrimaryKey = pModel.Tables[tmpTables[i]].Columns.find((pColumn) => { return pColumn.DataType === 'ID'; });
		if (!tmpPrimaryKey)
		{
			continue;
		}
		let tmpTable = quoteIdentifier(tmpTables[i]);
		let tmpKey = quoteIdentifier(tmpPrimaryKey.Column);
		tmpStatements.push({ text: `SELECT setval(pg_get_serial_sequence('${tmpTable}', '${tmpPrimaryKey.Column}'), COALESCE((SELECT max(${tmpKey}) FROM ${tmpTable}), 0) + 1, false)` });
	}
	return tmpStatements;
};

/**
 * Row counts (all rows, and non-deleted rows) per table, optionally for one tenant, counted on PostgreSQL.
 *
 * @param {any} pPool
 * @param {Record<string, any>} pModel
 * @param {string|null} pTenantColumn
 * @param {number|null} pTenant
 * @param {(pError?: Error, pCounts?: { Counts: Record<string, number>, LiveCounts: Record<string, number> }) => void} fCallback
 */
const countRowsPostgreSQL = (pPool, pModel, pTenantColumn, pTenant, fCallback) =>
{
	let tmpTables = Object.keys(pModel.Tables);
	let tmpParts = [];
	let tmpValues = [];
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpColumns = pModel.Tables[tmpTables[i]].Columns;
		let tmpHasTenant = (typeof(pTenant) === 'number') && tmpColumns.some((pColumn) => { return pColumn.Column === pTenantColumn; });
		if ((typeof(pTenant) === 'number') && !tmpHasTenant)
		{
			// A global lookup has no tenant rows of its own.
			tmpParts.push(`SELECT ${i} AS "T", 0 AS "N", 0 AS "Live"`);
			continue;
		}
		let tmpHasDeleted = tmpColumns.some((pColumn) => { return pColumn.Column === 'Deleted'; });
		let tmpWhere = '';
		if (tmpHasTenant)
		{
			tmpValues.push(pTenant);
			tmpWhere = ` WHERE ${quoteIdentifier(pTenantColumn)} = $${tmpValues.length}`;
		}
		let tmpLive = tmpHasDeleted ? 'count(*) FILTER (WHERE "Deleted" = \'0\')' : 'count(*)';
		tmpParts.push(`SELECT ${i} AS "T", count(*) AS "N", ${tmpLive} AS "Live" FROM ${quoteIdentifier(tmpTables[i])}${tmpWhere}`);
	}
	pPool.query(tmpParts.join(' UNION ALL '), tmpValues,
		(pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpCounts = {};
			let tmpLiveCounts = {};
			pResult.rows.forEach(
				(pRow) =>
				{
					let tmpTable = tmpTables[Number(pRow.T)];
					tmpCounts[tmpTable] = Number(pRow.N);
					tmpLiveCounts[tmpTable] = Number(pRow.Live);
				});
			return fCallback(null, { Counts: tmpCounts, LiveCounts: tmpLiveCounts });
		});
};

/**
 * Create the tables from the seed module's model and insert its deterministic rows.
 *
 * @param {Record<string, any>} pConnection
 * @param {{ build: Function, generate?: Function }} pSeedModule - Bookstore-Seed, ProjectTrack-Seed, LabTrack-Seed
 * @param {{ Fixture?: string, Seed?: number, Scale?: string }} pSeedOptions
 * @param {(pError?: Error, pSeedResult?: Record<string, any>) => void} fCallback
 */
const seed = (pConnection, pSeedModule, pSeedOptions, fCallback) =>
{
	if (pConnection && (pConnection.Provider === 'PostgreSQL'))
	{
		return seedPostgreSQL(pConnection, pSeedModule, pSeedOptions, fCallback);
	}
	if (!pConnection || (pConnection.Provider !== 'SQLite'))
	{
		return fCallback(new Error('Facet-Harness-Providers: seed() needs a connection from connect().'));
	}
	let tmpResult;
	try
	{
		tmpResult = pSeedModule.build(pConnection.db, pSeedOptions);
	}
	catch (pSeedError)
	{
		return fCallback(pSeedError);
	}
	return fCallback(null, tmpResult);
};

/**
 * PostgreSQL seed: generate() → DDL + batched INSERTs (one transaction) → setval → SQL counts.
 *
 * @param {Record<string, any>} pConnection
 * @param {Record<string, any>} pSeedModule
 * @param {Record<string, any>} pSeedOptions
 * @param {(pError?: Error, pSeedResult?: Record<string, any>) => void} fCallback
 */
const seedPostgreSQL = (pConnection, pSeedModule, pSeedOptions, fCallback) =>
{
	if (!pConnection.pool || pConnection._Released)
	{
		return fCallback(new Error('Facet-Harness-Providers: the PostgreSQL connection is not open.'));
	}
	if (!pSeedModule || (typeof(pSeedModule.generate) !== 'function'))
	{
		return fCallback(new Error('Facet-Harness-Providers: the seed module has no generate() (internal-contracts §31.6).'));
	}
	let tmpGenerated;
	let tmpStatements;
	let tmpCoerced = [];
	try
	{
		tmpGenerated = pSeedModule.generate(pSeedOptions || {});
		let tmpMeadowSchema = ((pConnection.Schema === 'Meadow') && pConnection._Fable && pConnection._Fable.MeadowPostgreSQLProvider) ? pConnection._Fable.MeadowPostgreSQLProvider : null;
		tmpStatements = loadStatements(tmpGenerated.Model, tmpGenerated.Rows, tmpGenerated.Order, tmpCoerced, tmpMeadowSchema);
	}
	catch (pGenerateError)
	{
		return fCallback(pGenerateError);
	}

	pConnection.pool.connect(
		(pConnectError, pClient, fReleaseClient) =>
		{
			if (pConnectError)
			{
				return fCallback(pConnectError);
			}
			runSequence(pClient, [ { text: 'BEGIN' } ].concat(tmpStatements, [ { text: 'COMMIT' } ]),
				(pLoadError) =>
				{
					let fAfterLoad = () =>
					{
						fReleaseClient();
						if (pLoadError)
						{
							return fCallback(pLoadError);
						}
						pConnection.Coerced = pConnection.Coerced.concat(tmpCoerced);
						let tmpTenants = Array.isArray(tmpGenerated.Tenants) ? tmpGenerated.Tenants : [];
						let tmpTenantColumn = tmpGenerated.TenantColumn || null;
						countRowsPostgreSQL(pConnection.pool, tmpGenerated.Model, null, null,
							(pCountError, pAll) =>
							{
								if (pCountError)
								{
									return fCallback(pCountError);
								}
								let tmpTenantCounts = {};
								let tmpTenantLiveCounts = {};
								let fTenant = (pIndex) =>
								{
									if (pIndex >= tmpTenants.length)
									{
										let tmpResult = Object.assign({}, tmpGenerated,
											{
												Provider: 'PostgreSQL',
												Database: pConnection.Database,
												Counts: pAll.Counts,
												LiveCounts: pAll.LiveCounts,
												Tenants: tmpTenants,
												TenantCounts: tmpTenantCounts,
												TenantLiveCounts: tmpTenantLiveCounts,
												Coerced: tmpCoerced
											});
										return fCallback(null, tmpResult);
									}
									countRowsPostgreSQL(pConnection.pool, tmpGenerated.Model, tmpTenantColumn, tmpTenants[pIndex],
										(pTenantError, pTenantCounted) =>
										{
											if (pTenantError)
											{
												return fCallback(pTenantError);
											}
											tmpTenantCounts[tmpTenants[pIndex]] = pTenantCounted.Counts;
											tmpTenantLiveCounts[tmpTenants[pIndex]] = pTenantCounted.LiveCounts;
											return fTenant(pIndex + 1);
										});
								};
								return fTenant(0);
							});
					};
					if (pLoadError)
					{
						return pClient.query('ROLLBACK', () => { return fAfterLoad(); });
					}
					return fAfterLoad();
				});
		});
};

/**
 * Close (SQLite) or drop the per-harness database (PostgreSQL).  Idempotent.
 *
 * @param {Record<string, any>} pConnection
 * @param {(pError?: Error) => void} fCallback
 */
const release = (pConnection, fCallback) =>
{
	if (pConnection && (pConnection.Provider === 'PostgreSQL'))
	{
		if (pConnection._Released)
		{
			return fCallback();
		}
		pConnection._Released = true;
		let fDrop = () =>
		{
			// WITH (FORCE) (PostgreSQL 13+) also ends any straggling session; older servers get the plain form.
			libDockerPostgres.adminQuery(pConnection._Info, `DROP DATABASE IF EXISTS "${pConnection.Database}" WITH (FORCE)`, [],
				(pDropError) =>
				{
					if (pDropError && /syntax/i.test(String(pDropError.message)))
					{
						return libDockerPostgres.adminQuery(pConnection._Info, `DROP DATABASE IF EXISTS "${pConnection.Database}"`, [],
							(pPlainDropError) =>
							{
								ACTIVE_DATABASES.delete(pConnection.Database);
								return fCallback(pPlainDropError || null);
							});
					}
					ACTIVE_DATABASES.delete(pConnection.Database);
					return fCallback(pDropError || null);
				});
		};
		if (!pConnection.pool || pConnection.pool.ended || pConnection.pool.ending)
		{
			return fDrop();
		}
		return pConnection.pool.end(() => { return fDrop(); });
	}
	try
	{
		if (pConnection && pConnection.db && (typeof(pConnection.db.close) === 'function'))
		{
			pConnection.db.close();
		}
	}
	catch (pCloseError)
	{
		// Already closed
	}
	return fCallback();
};

/**
 * Database names this process created and has not dropped (for tests of the hook).
 *
 * @return {Array<string>}
 */
const activeDatabases = () =>
{
	return Array.from(ACTIVE_DATABASES);
};

module.exports = (
	{
		PROVIDERS: PROVIDERS,
		available: available,
		fableSettings: fableSettings,
		connect: connect,
		seed: seed,
		release: release,
		// helpers (tests of the hook, the PostgreSQL conformance suite)
		postgresGateOn: postgresGateOn,
		timeZoneIsUTC: timeZoneIsUTC,
		nextDatabaseName: nextDatabaseName,
		activeDatabases: activeDatabases,
		postgresType: postgresType,
		createTableStatement: createTableStatement,
		coerceValue: coerceValue,
		coerceMeadowValue: coerceMeadowValue,
		loadStatements: loadStatements,
		countRowsPostgreSQL: countRowsPostgreSQL
	});
