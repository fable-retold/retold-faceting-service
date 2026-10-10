/**
 * Retold Faceting - Store ClickHouse
 *
 * The ClickHouse store (design 04 §5): feature-not-boot registration, the database
 * rfs_<InstanceKey> (ENGINE = Atomic), the generated DDL (one ReplacingMergeTree(_Version,
 * _IsDeleted) mirror per entity ordered by (tenant[, owner], identity), its keymap
 * _rfs_keys_<Entity> ordered by (identity, scope keys), the in-store _rfs_entity_state), the
 * write side of the store contract (keymap reads, the three-insert flush with
 * insert_deduplication_token, shadow tables and EXCHANGE / RENAME, state, reconcile checksums), and
 * raw reads for the engine (queryRows with the read settings of §57.3).
 *
 * Feature-not-boot (§54.2): configure() never throws and connect() reports Up: false instead of an
 * error, so the service boots and answers Live with ClickHouse down or misconfigured.
 *
 * Batch shapes (writeBatch, §58.6; the WriterLoop builds them, the support loader too):
 *
 *   Rows        [ <store row of the spec: TypeMap.toStoreRow(…).Row> + _Version ]            → mirror, _IsDeleted 0
 *               (or { Row, Version })
 *   Tombstones  [ { ID, Key: { <sort-key scope column>: v }, Version } ]                       → mirror, _IsDeleted 1
 *               (or a flat { <Identity>, <scope columns>, _Version })
 *   KeyIntents  [ { ID, Key, Tracked: { <TrackedKeyColumn>: v }, UpdateDate, Version } ]       → keymap, _IsDeleted 0
 *   KeyRetires  [ { ID, Key, Version } ]                                                       → keymap, _IsDeleted 1
 *
 * readKeys / readKeyRange return Map<ID, [ { Key, Tracked, UpdateDate, Version } ]> holding only IDs
 * with at least one live key; Key / Tracked / UpdateDate values are store values (TypeMap), so a
 * KeyIntent built from TypeMap.keyOf(spec, row) compares with === (TypeMap.keyString).
 *
 * Registered in SUB_SERVICES (inert until the wiring's installStores() calls configure()).
 *
 * Contract: internal-contracts §54, §56, §57.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libRetoldFacetingStoreBase = require('../Retold-Faceting-StoreBase.js');
const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetUtil = require('../../contract/Facet-Contract-Util.js');
const libFacetClauses = require('../../contract/Facet-Contract-Clauses.js');

const libClickHouseClient = require('./ClickHouse-Client.js');
const libDDL = require('./ClickHouse-DDL.js');
const libTypeMap = require('./ClickHouse-TypeMap.js');

// The store's name everywhere (Router reasons, Freshness keys, _rfs_entity_state.Store).
const STORE_NAME = 'ClickHouse';

// ClickHouse error codes that mean the database or a table is gone (a wiped volume, §59.3).
const WIPE_ERROR_CODES = Object.freeze([ 60, 81 ]);

// ClickHouse codes for an existing table (RENAME onto it) and an authentication failure.
const TABLE_ALREADY_EXISTS = 57;
const AUTHENTICATION_FAILED = 516;

// The read settings of every engine statement (§57.3); max_execution_time / max_result_rows /
// result_overflow_mode come from the engine per statement.
//
// precise_float_parsing: ClickHouse 24.8 parses Float64 TEXT (JSONEachRow / CSV / Values input AND {p:Float64}
// query parameters) with a fast parser that is off by one ulp for values such as 5.94 or 7.56 (verified);
// only toFloat64(<String>) under precise_float_parsing = 1 is exact.  So the store inserts Float64 columns
// as text through toFloat64 (_insertQuery), and an engine statement binds a Float64 value as
// toFloat64({p:String}) — never {p:Float64} — with this setting on.
const READ_SETTINGS = Object.freeze(
	{
		enable_extended_results_for_datetime_functions: 1,
		precise_float_parsing: 1,
		join_use_nulls: 1,
		transform_null_in: 0,
		cancel_http_readonly_queries_on_client_close: 1,
		output_format_json_quote_64bit_integers: 1,
		readonly: 2
	});

// Every kind the Live engine supports (§5.3, §24.9).
const FOLDS = Object.freeze([ 'Count', 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'ChildRollup', 'ExistsSplit' ]);

// Identifiers per keymap / readKeys chunk (the IDs travel in the URL as an Array(Int64) parameter: 4000
// 19-digit IDs stay well under the client's MAX_PARAM_TEXT).
const ID_CHUNK = 4000;

const STATE_JSON_COLUMNS = Object.freeze([ 'AppliedSeq', 'LossyColumns', 'FillingColumns', 'Detail' ]);
const STATE_DATE_COLUMNS = Object.freeze([ 'ScrubbedThrough', 'LastRebuild', 'LastBisect', 'UnverifiedSince' ]);
const STATE_DEFAULTS = Object.freeze(
	{
		State: 'Absent', Epoch: 0, SpecHash: '', AppliedSeq: {}, CleanShutdown: 0, LossyColumns: {}, FillingColumns: [],
		SweepWatermark: null, ScrubCursor: null, ScrubbedThrough: null, LastRebuild: null, LastBisect: null, UnverifiedSince: null, Detail: {}
	});

const SOURCE_STRING_ORDERS = Object.freeze([ 'Auto', 'Binary', 'Collated' ]);

/**
 * A store error (never carries a bound value).
 *
 * @param {string} pMessage
 * @param {number|null} [pCode]
 * @return {Error}
 */
const storeError = (pMessage, pCode) =>
{
	let tmpError = new Error(pMessage);
	tmpError.StoreError = true;
	tmpError.Status = 0;
	tmpError.Code = Number.isInteger(pCode) ? pCode : null;
	tmpError.Retryable = false;
	if (WIPE_ERROR_CODES.indexOf(tmpError.Code) >= 0)
	{
		tmpError.Wipe = true;
	}
	return tmpError;
};

/**
 * Does this error mean the database or a table is gone (§59.3)?
 *
 * @param {any} pError
 * @return {boolean}
 */
const isWipeError = (pError) =>
{
	return !!(pError && pError.StoreError && (WIPE_ERROR_CODES.indexOf(pError.Code) >= 0));
};

/**
 * A state DateTime field → 'YYYY-MM-DD HH:mm:ss.SSS' (UTC) or null.
 *
 * @param {any} pValue - epoch milliseconds, a Date, or date text
 * @return {string|null}
 */
const stateDateText = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return null;
	}
	let tmpTime = null;
	if (typeof(pValue) === 'number')
	{
		tmpTime = pValue;
	}
	else if (Object.prototype.toString.call(pValue) === '[object Date]')
	{
		tmpTime = pValue.getTime();
	}
	else if (typeof(pValue) === 'string')
	{
		let tmpText = pValue.trim();
		tmpTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(tmpText) ? Date.parse(`${tmpText.replace(' ', 'T')}Z`) : Date.parse(tmpText);
	}
	if (!Number.isFinite(tmpTime))
	{
		return null;
	}
	let tmpISO = new Date(tmpTime).toISOString();
	let tmpText = `${tmpISO.slice(0, 10)} ${tmpISO.slice(11, 23)}`;
	return ((tmpText >= libTypeMap.DATETIME_MIN) && (tmpText <= `${libTypeMap.DATETIME_MAX}.999`)) ? tmpText : null;
};

/**
 * A state DateTime column read back → epoch milliseconds or null.
 *
 * @param {any} pText
 * @return {number|null}
 */
const stateDateMS = (pText) =>
{
	if ((typeof(pText) !== 'string') || (pText.length < 10))
	{
		return null;
	}
	let tmpTime = Date.parse(`${pText.replace(' ', 'T')}Z`);
	return Number.isFinite(tmpTime) ? tmpTime : null;
};

/**
 * JSON text → a value (the fallback when it does not parse).
 *
 * @param {any} pText
 * @param {any} pFallback
 * @return {any}
 */
const parseJSON = (pText, pFallback) =>
{
	if ((typeof(pText) !== 'string') || (pText.length < 1))
	{
		return pFallback;
	}
	try
	{
		return JSON.parse(pText);
	}
	catch (pError)
	{
		return pFallback;
	}
};

class RetoldFacetingStoreClickHouse extends libRetoldFacetingStoreBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingStoreClickHouse';

		// Set by configure(); null until then (nothing connects in the constructor).
		this.Client = null;
		this.Database = null;
		this._StoreOptions = null;
		this._Status = { Configured: false, Available: false, Reason: 'NotConfigured', Database: null, Version: null, LastError: null, ConnectedAt: null };
		// Entity → { Live: MirrorSpec|null, Shadows: { BuildID: MirrorSpec } }
		this._Specs = {};
		// '<table>' → Map(column → type), loaded lazily, dropped by every DDL on the table
		this._TableColumns = new Map();
		// Entity → the last state object read or written (writeState merges over it)
		this._States = {};
		this._StateVersionFloor = 0;
		// '<Entity>:<BuildID>' → 'Mirror' once the mirror half of a swap succeeded
		this._SwapProgress = {};
		// '<Entity>:<BuildID>' → { Mirror: uuid, Keymap: uuid } of the shadow tables (an Atomic table keeps
		// its UUID through RENAME / EXCHANGE: a retried swap tells which halves already landed)
		this._ShadowUUIDs = {};
		this._Counters = { Statements: 0, Inserts: 0, InsertedRows: 0, Errors: 0, Queries: 0, Busy: 0, Unreachable: 0 };
		this._ConfigFingerprint = null;
		// Request-path reads: their own client (reader credentials when configured, its own socket pool).
		this.ReadClient = null;
		this._ActiveReads = 0;
		// Store-wide health: network failures / time-outs within the window → Unreachable (a background
		// ping restores it); [ Date.now() … ]
		this._HealthFailures = [];
		this._PingTimer = null;
		// The source fingerprint the owner marker binds (set by the Materializer before ensureSchema).
		this.SourceFingerprint = null;
	}

	/**
	 * @return {string}
	 */
	get StoreName()
	{
		return STORE_NAME;
	}

	// ---- lifecycle --------------------------------------------------------------------------

	/**
	 * Resolve the Stores.ClickHouse section (§53.4, §54.2 step 3) over STORE_DEFAULTS: URLEnv /
	 * UserEnv / PasswordEnv, the database name ('rfs_' + InstanceKey unless Database is given), the
	 * client.  Never throws: a problem sets Available false, Reason 'Misconfigured' and logs an error
	 * that carries no secret.
	 *
	 * @param {Record<string, any>} pStoreOptions - the host's Stores.ClickHouse
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	configure(pStoreOptions)
	{
		// Idempotent (installStores runs again after every model reload): the same resolved section keeps
		// the client, its connection status and the caches.
		let tmpFingerprint = this._configFingerprint(pStoreOptions);
		if (tmpFingerprint && this.Client && (tmpFingerprint === this._ConfigFingerprint))
		{
			return { Configured: true, Available: this._Status.Available, Reason: this._Status.Reason };
		}
		this._ConfigFingerprint = null;
		if (this.Client)
		{
			this.Client.close();
		}
		if (this.ReadClient)
		{
			this.ReadClient.close();
		}
		this._stopPing();
		this._HealthFailures = [];
		this.Client = null;
		this.ReadClient = null;
		this.Database = null;
		this._StoreOptions = null;
		this._TableColumns = new Map();
		this._States = {};
		if (!libFacetUtil.isPlainObject(pStoreOptions))
		{
			this._Status = { Configured: false, Available: false, Reason: 'NotConfigured', Database: null, Version: null, LastError: null, ConnectedAt: null };
			return { Configured: false, Available: false, Reason: 'NotConfigured' };
		}
		let tmpDefaults = libOptions.STORE_DEFAULTS.ClickHouse;
		let tmpOptions = Object.assign({}, tmpDefaults, pStoreOptions);
		tmpOptions.QuerySettings = Object.assign({}, tmpDefaults.QuerySettings, libFacetUtil.isPlainObject(pStoreOptions.QuerySettings) ? pStoreOptions.QuerySettings : {});
		let fMisconfigured = (pProblem) =>
		{
			this._Status = { Configured: true, Available: false, Reason: 'Misconfigured', Database: this.Database, Version: null, LastError: pProblem, ConnectedAt: null };
			this.fable.log.error(`RetoldFaceting ClickHouse store is misconfigured (it stays unavailable; facets answer Live): ${pProblem}`);
			return { Configured: true, Available: false, Reason: 'Misconfigured' };
		};
		let fEnv = (pName) =>
		{
			if ((typeof(pName) !== 'string') || (pName.length < 1))
			{
				return null;
			}
			let tmpValue = process.env[pName];
			return ((typeof(tmpValue) === 'string') && (tmpValue.length > 0)) ? tmpValue : null;
		};
		let tmpURL = fEnv(tmpOptions.URLEnv) || tmpOptions.URL;
		let tmpUser = fEnv(tmpOptions.UserEnv) || tmpOptions.User || 'default';
		let tmpPassword = fEnv(tmpOptions.PasswordEnv);
		if (tmpPassword === null)
		{
			tmpPassword = (typeof(tmpOptions.Password) === 'string') ? tmpOptions.Password : '';
		}
		let tmpReaderUser = fEnv(tmpOptions.ReaderUserEnv) || ((typeof(tmpOptions.ReaderUser) === 'string') && (tmpOptions.ReaderUser.length > 0) ? tmpOptions.ReaderUser : null);
		let tmpReaderPassword = fEnv(tmpOptions.ReaderPasswordEnv);
		if (tmpReaderPassword === null)
		{
			tmpReaderPassword = (typeof(tmpOptions.ReaderPassword) === 'string') ? tmpOptions.ReaderPassword : '';
		}
		if ((typeof(tmpURL) !== 'string') || (tmpURL.length < 1))
		{
			return fMisconfigured((typeof(tmpOptions.URLEnv) === 'string') ? `no URL (the environment variable ${tmpOptions.URLEnv} is not set).` : 'no URL.');
		}
		let tmpExplicitDatabase = (typeof(tmpOptions.Database) === 'string') && (tmpOptions.Database.length > 0);
		let tmpInstanceID = this.options.InstanceID;
		if (!tmpExplicitDatabase && ((tmpInstanceID === null) || (typeof(tmpInstanceID) === 'undefined') || (String(tmpInstanceID) === libOptions.DEFAULTS.InstanceID)))
		{
			// The default name would be shared by every deployment left at the defaults (two apps, or
			// staging and production, on one ClickHouse): never guess it.
			return fMisconfigured(`set Stores.ClickHouse.Database or a non-default InstanceID (the default database name rfs_${libOptions.DEFAULTS.InstanceID} would be shared by every deployment left at the defaults).`);
		}
		try
		{
			this.Database = libDDL.databaseName(tmpInstanceID, tmpOptions.Database);
		}
		catch (pNameError)
		{
			this.Database = null;
			return fMisconfigured('the database name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$.');
		}
		if (!libFacetUtil.isPlainObject(tmpOptions.QuerySettings) || Object.keys(tmpOptions.QuerySettings).some(
			(pName) =>
			{
				let tmpValue = tmpOptions.QuerySettings[pName];
				return !libClickHouseClient.SETTING_NAME_PATTERN.test(pName) || ((tmpValue !== null) && (typeof(tmpValue) === 'object'));
			}))
		{
			return fMisconfigured('QuerySettings names must match ^[a-z_][a-z0-9_]*$ with scalar values.');
		}
		if (SOURCE_STRING_ORDERS.indexOf(tmpOptions.SourceStringOrder) < 0)
		{
			return fMisconfigured(`SourceStringOrder must be one of ${SOURCE_STRING_ORDERS.join(', ')}.`);
		}
		let tmpInsertRetries = Number.isInteger(tmpOptions.InsertRetries) ? Math.max(0, Math.min(tmpOptions.InsertRetries, 10)) : tmpDefaults.InsertRetries;
		let fPositive = (pValue, pDefault) => { return (Number.isFinite(pValue) && (pValue > 0)) ? pValue : pDefault; };
		let tmpMaxReads = Math.floor(fPositive(tmpOptions.MaxConcurrentReads, tmpDefaults.MaxConcurrentReads));
		let tmpReadLimits = Object.assign({}, tmpDefaults.ReadLimits, libFacetUtil.isPlainObject(pStoreOptions.ReadLimits) ? pStoreOptions.ReadLimits : {});
		let tmpHostText = '?';
		let tmpInsecure = false;
		try
		{
			let tmpTLS = { CA: tmpOptions.CA || null, Cert: tmpOptions.Cert || null, Key: tmpOptions.Key || null, RejectUnauthorized: (tmpOptions.RejectUnauthorized !== false) };
			this.Client = new libClickHouseClient(Object.assign(
				{
					URL: tmpURL,
					User: tmpUser,
					Password: tmpPassword,
					Database: null,
					TimeoutMS: tmpOptions.TimeoutMS,
					PingTimeoutMS: tmpOptions.PingTimeoutMS,
					MaxSockets: Math.floor(fPositive(tmpOptions.WriterMaxSockets, tmpDefaults.WriterMaxSockets))
				}, tmpTLS));
			// Request reads: their own socket pool (never queued behind the materializer's inserts, and the
			// other way round), reader credentials when configured.
			this.ReadClient = new libClickHouseClient(Object.assign(
				{
					URL: tmpURL,
					User: tmpReaderUser || tmpUser,
					Password: tmpReaderUser ? tmpReaderPassword : tmpPassword,
					Database: null,
					TimeoutMS: tmpOptions.TimeoutMS,
					PingTimeoutMS: tmpOptions.PingTimeoutMS,
					MaxSockets: tmpMaxReads
				}, tmpTLS));
			let tmpParsed = new URL(tmpURL);
			tmpHostText = `${tmpParsed.protocol}//${tmpParsed.host}`;
			tmpInsecure = !this.Client.isHttps() && !this.Client.isLoopback();
		}
		catch (pClientError)
		{
			this.Client = null;
			this.ReadClient = null;
			// Our own messages (never the URL text, which could hold credentials).
			return fMisconfigured((pClientError && /^ClickHouseClient: /.test(pClientError.message)) ? pClientError.message.replace(/^ClickHouseClient: /, '') : 'the URL is not a valid http(s) URL.');
		}
		if (tmpInsecure && (tmpOptions.AllowInsecure !== true))
		{
			this.fable.log.warn(`RetoldFaceting ClickHouse store: ${tmpHostText} is plain http to a host that is not loopback — the credentials and every bound value (tenant IDs, scope lists, filter values) cross the network in clear text.  Use https:// (Stores.ClickHouse.CA for a private CA), or set AllowInsecure: true when the network is trusted.`);
		}
		this._StoreOptions = Object.freeze(
			{
				URL: tmpHostText,
				User: tmpUser,
				ReaderUser: tmpReaderUser,
				Database: this.Database,
				TimeoutMS: this.Client.TimeoutMS,
				PingTimeoutMS: this.Client.PingTimeoutMS,
				RetryConnectMS: Number.isFinite(tmpOptions.RetryConnectMS) ? tmpOptions.RetryConnectMS : tmpDefaults.RetryConnectMS,
				InsertRetries: tmpInsertRetries,
				QuerySettings: Object.freeze(Object.assign({}, tmpOptions.QuerySettings)),
				SourceStringOrder: tmpOptions.SourceStringOrder,
				ExposeReasons: (tmpOptions.ExposeReasons === true),
				ExposeFreshness: ((tmpOptions.ExposeFreshness === true) || (tmpOptions.ExposeFreshness === false)) ? tmpOptions.ExposeFreshness : !libOptions.hasScopePolicy(this.options),
				MaxConcurrentReads: tmpMaxReads,
				ReadLimits: Object.freeze(tmpReadLimits),
				HealthMinTimeoutMS: fPositive(tmpOptions.HealthMinTimeoutMS, tmpDefaults.HealthMinTimeoutMS),
				UnreachableAfterFailures: Math.floor(fPositive(tmpOptions.UnreachableAfterFailures, tmpDefaults.UnreachableAfterFailures)),
				UnreachablePingMS: fPositive(tmpOptions.UnreachablePingMS, tmpDefaults.UnreachablePingMS),
				Insecure: tmpInsecure,
				Owner: (tmpOptions.Owner === 'Adopt') ? 'Adopt' : 'Check',
				InstanceID: String(tmpInstanceID)
			});
		this._Status = { Configured: true, Available: false, Reason: 'NotConnected', Database: this.Database, Version: null, LastError: null, ConnectedAt: null };
		this._ConfigFingerprint = tmpFingerprint;
		this.fable.log.info(`RetoldFaceting ClickHouse store configured: ${tmpHostText}, database ${this.Database}.`);
		return { Configured: true, Available: false, Reason: 'NotConnected' };
	}

	/**
	 * A fingerprint of a Stores.ClickHouse section with its environment variables resolved (the
	 * password only as a hash), or null when it is not an object.
	 *
	 * @param {any} pStoreOptions
	 * @return {string|null}
	 */
	_configFingerprint(pStoreOptions)
	{
		if (!libFacetUtil.isPlainObject(pStoreOptions))
		{
			return null;
		}
		let fEnv = (pName) => { return ((typeof(pName) === 'string') && (pName.length > 0) && (typeof(process.env[pName]) === 'string')) ? process.env[pName] : null; };
		let tmpMaterial = Object.assign({}, pStoreOptions,
			{
				URL: fEnv(pStoreOptions.URLEnv) || pStoreOptions.URL || null,
				User: fEnv(pStoreOptions.UserEnv) || pStoreOptions.User || null,
				Password: libCrypto.createHash('sha256').update(String(fEnv(pStoreOptions.PasswordEnv) || pStoreOptions.Password || ''), 'utf8').digest('hex'),
				ReaderUser: fEnv(pStoreOptions.ReaderUserEnv) || pStoreOptions.ReaderUser || null,
				ReaderPassword: libCrypto.createHash('sha256').update(String(fEnv(pStoreOptions.ReaderPasswordEnv) || pStoreOptions.ReaderPassword || ''), 'utf8').digest('hex'),
				Key: pStoreOptions.Key ? libCrypto.createHash('sha256').update(String(pStoreOptions.Key), 'utf8').digest('hex') : null,
				InstanceID: this.options.InstanceID
			});
		try
		{
			return libFacetClauses.canonicalJSON(tmpMaterial);
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * The resolved store options without secrets (null before a successful configure()).
	 *
	 * @return {Record<string, any>|null}
	 */
	resolvedOptions()
	{
		return this._StoreOptions;
	}

	/**
	 * Ping, then SELECT version(); Up: false (never an error) when the server is unreachable or
	 * refuses the credentials.
	 *
	 * @param {(pError?: Error, pResult?: { Up: boolean, Version: string|null }) => void} fCallback
	 */
	connect(fCallback)
	{
		if (!this.Client)
		{
			return fCallback(null, { Up: false, Version: null });
		}
		this.Client.ping(
			(pPingError, pUp) =>
			{
				if (!pUp)
				{
					this._setUnavailable('Unreachable', 'ping failed');
					return fCallback(null, { Up: false, Version: null });
				}
				this.Client.query('SELECT version() AS Version', null, null,
					(pError, pRows) =>
					{
						if (pError)
						{
							this._setUnavailable((pError.Code === AUTHENTICATION_FAILED) ? 'AuthenticationFailed' : 'ConnectFailed', pError.message);
							return fCallback(null, { Up: false, Version: null });
						}
						let tmpVersion = (pRows && pRows[0] && (typeof(pRows[0].Version) === 'string')) ? pRows[0].Version : null;
						this._HealthFailures = [];
						this._stopPing();
						this._Status = Object.assign({}, this._Status, { Available: true, Reason: null, Version: tmpVersion, LastError: null, ConnectedAt: Date.now() });
						return fCallback(null, { Up: true, Version: tmpVersion });
					});
			});
	}

	/**
	 * @param {string} pReason
	 * @param {string} pMessage
	 */
	_setUnavailable(pReason, pMessage)
	{
		let tmpWasAvailable = this._Status.Available;
		this._Status = Object.assign({}, this._Status, { Available: false, Reason: pReason, LastError: pMessage || null });
		if (tmpWasAvailable || (this._Status.LastLoggedReason !== pReason))
		{
			this.fable.log.warn(`RetoldFaceting ClickHouse store unavailable (${pReason}); facets answer Live.`);
		}
		this._Status.LastLoggedReason = pReason;
	}

	/**
	 * Tests only: the client fault injector (§57.4) on both clients (request reads and the writer).
	 *
	 * @param {Function|null} fInjector
	 */
	setFaultInjector(fInjector)
	{
		[ this.Client, this.ReadClient ].forEach((pClient) => { if (pClient) { pClient.setFaultInjector(fInjector); } });
	}

	/**
	 * Drop the clients' keep-alive sockets and destroy every request still in flight (shutdown).
	 */
	close()
	{
		this._stopPing();
		if (this.Client)
		{
			this.Client.close();
		}
		if (this.ReadClient)
		{
			this.ReadClient.close();
		}
	}

	// ---- store-wide health ------------------------------------------------------------------

	/**
	 * Is an error a sign the store itself is unwell (unreachable, timing out, failing at random) rather
	 * than of the statement that hit it (a parse / parameter / type error, a per-query limit, a statement
	 * whose caller gave it too little time, a refusal before sending)?
	 *
	 * @param {any} pError
	 * @param {number} [pBudgetMS] - the time the statement had (a time-out under HealthMinTimeoutMS is the caller's)
	 * @return {boolean}
	 */
	isHealthFailure(pError, pBudgetMS)
	{
		if (!pError || pError.Busy || pError.Deterministic || pError.Limit || pError.ParameterSize || pError.ShadowMissing)
		{
			return false;
		}
		let tmpMinTimeout = this._StoreOptions ? this._StoreOptions.HealthMinTimeoutMS : 1000;
		if (pError.TimedOut || (pError.NetworkCode === 'ETIMEDOUT'))
		{
			return !(Number.isFinite(pBudgetMS) && (pBudgetMS < tmpMinTimeout));
		}
		if (pError.Status === 0)
		{
			return true;
		}
		return (pError.Status >= 500) && (pError.Retryable === true);
	}

	/**
	 * Is an error a network failure or a time-out (the server unreachable or hung)?
	 *
	 * @param {any} pError
	 * @return {boolean}
	 */
	_isNetworkFailure(pError)
	{
		return !!pError && !pError.Deterministic && !pError.Busy && !pError.ParameterSize && ((pError.Status === 0) || (pError.TimedOut === true));
	}

	/**
	 * Count a statement outcome toward the store-wide health: UnreachableAfterFailures network failures /
	 * time-outs (each with at least HealthMinTimeoutMS of budget) within BreakerWindowMS mark the store
	 * Unavailable ('Unreachable': every facet answers Live at once, O(1)) until a background ping
	 * succeeds.
	 *
	 * @param {any} pError - null for a success
	 * @param {number} [pBudgetMS]
	 */
	noteOutcome(pError, pBudgetMS)
	{
		if (!pError)
		{
			if (this._HealthFailures.length > 0)
			{
				this._HealthFailures = [];
			}
			return;
		}
		if (!this._isNetworkFailure(pError) || !this.isHealthFailure(pError, pBudgetMS))
		{
			return;
		}
		let tmpNow = Date.now();
		let tmpWindow = ((this.options.Freshness && (this.options.Freshness.BreakerWindowMS > 0)) ? this.options.Freshness.BreakerWindowMS : 30000);
		this._HealthFailures = this._HealthFailures.filter((pAt) => { return (tmpNow - pAt) < tmpWindow; });
		this._HealthFailures.push(tmpNow);
		let tmpThreshold = this._StoreOptions ? this._StoreOptions.UnreachableAfterFailures : 2;
		if ((this._HealthFailures.length >= tmpThreshold) && this._Status.Available)
		{
			this._Counters.Unreachable++;
			this._setUnavailable('Unreachable', (pError && pError.message) ? pError.message : 'network failures');
			this._startPing();
		}
	}

	/**
	 * Ping in the background (unref'd) until the server answers, then Available again.
	 */
	_startPing()
	{
		if (this._PingTimer || !this.Client)
		{
			return;
		}
		let tmpEvery = this._StoreOptions ? this._StoreOptions.UnreachablePingMS : 2000;
		let tmpClient = this.Client;
		let fPing = () =>
		{
			this._PingTimer = null;
			if ((this.Client !== tmpClient) || this._Status.Available)
			{
				return;
			}
			tmpClient.ping(
				(pError, pUp) =>
				{
					if (this.Client !== tmpClient)
					{
						return;
					}
					if (pUp && (this._Status.Reason === 'Unreachable'))
					{
						this._HealthFailures = [];
						this._Status = Object.assign({}, this._Status, { Available: true, Reason: null, LastError: null });
						this.fable.log.info('RetoldFaceting ClickHouse store reachable again; the store answers again.');
						return;
					}
					if (this._Status.Reason === 'Unreachable')
					{
						this._PingTimer = setTimeout(fPing, tmpEvery);
						if (typeof(this._PingTimer.unref) === 'function')
						{
							this._PingTimer.unref();
						}
					}
				});
		};
		this._PingTimer = setTimeout(fPing, tmpEvery);
		if (typeof(this._PingTimer.unref) === 'function')
		{
			this._PingTimer.unref();
		}
	}

	/**
	 * Stop the background ping.
	 */
	_stopPing()
	{
		if (this._PingTimer)
		{
			clearTimeout(this._PingTimer);
			this._PingTimer = null;
		}
	}

	// ---- statement plumbing -----------------------------------------------------------------

	/**
	 * @param {(pError?: Error) => void} fCallback
	 * @return {boolean} true when the store has a client (else fCallback was called)
	 */
	_ready(fCallback)
	{
		if (!this.Client || !this.Database)
		{
			fCallback(storeError('The ClickHouse store is not configured.', null));
			return false;
		}
		return true;
	}

	/**
	 * Count, annotate and log a statement error.
	 *
	 * @param {Error} pError
	 * @param {string} pWhat
	 * @param {string} [pTable]
	 * @return {Error}
	 */
	_failed(pError, pWhat, pTable)
	{
		this._Counters.Errors++;
		if (pError && (WIPE_ERROR_CODES.indexOf(pError.Code) >= 0))
		{
			pError.Wipe = true;
			this._TableColumns = new Map();
		}
		else if (pError && (pError.Code === 16) && pTable)
		{
			this._TableColumns.delete(pTable);
		}
		this._Status.LastError = (pError && pError.message) ? pError.message : 'error';
		this.fable.log.warn(`RetoldFaceting ClickHouse ${pWhat} failed: ${this._Status.LastError}`);
		return pError;
	}

	/**
	 * A statement with no rows.
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {string} pWhat
	 * @param {(pError?: Error) => void} fCallback
	 */
	_command(pSQL, pParams, pWhat, fCallback)
	{
		this._Counters.Statements++;
		this.Client.command(pSQL, pParams, null,
			(pError) =>
			{
				this.noteOutcome(pError || null);
				return fCallback(pError ? this._failed(pError, pWhat) : null);
			});
	}

	/**
	 * A read of our own (no engine settings).
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {string} pWhat
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 * @param {string} [pTable]
	 * @param {Record<string, any>} [pSettings]
	 */
	_query(pSQL, pParams, pWhat, fCallback, pTable, pSettings)
	{
		this._Counters.Statements++;
		this.Client.query(pSQL, pParams, pSettings || null,
			(pError, pRows) =>
			{
				this.noteOutcome(pError || null);
				if (pError)
				{
					return fCallback(this._failed(pError, pWhat, pTable));
				}
				return fCallback(null, pRows || []);
			});
	}

	/**
	 * Run tasks in order; stop at the first error.
	 *
	 * @param {Array<(fNext: (pError?: Error) => void) => void>} pTasks
	 * @param {(pError?: Error) => void} fCallback
	 */
	_series(pTasks, fCallback)
	{
		let tmpIndex = 0;
		let fNext = (pError) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			if (tmpIndex >= pTasks.length)
			{
				return fCallback(null);
			}
			let tmpTask = pTasks[tmpIndex++];
			return tmpTask(fNext);
		};
		return fNext(null);
	}

	/**
	 * The columns of a table (cached): Map(name → type); an empty Map when the table does not exist.
	 *
	 * @param {string} pTable
	 * @param {(pError?: Error, pColumns?: Map<string, string>) => void} fCallback
	 */
	_columnsOf(pTable, fCallback)
	{
		if (this._TableColumns.has(pTable))
		{
			return fCallback(null, this._TableColumns.get(pTable));
		}
		this._query('SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position', { db: this.Database, t: pTable }, 'column read',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpColumns = new Map();
				pRows.forEach((pRow) => { tmpColumns.set(pRow.name, pRow.type); });
				if (tmpColumns.size > 0)
				{
					this._TableColumns.set(pTable, tmpColumns);
				}
				return fCallback(null, tmpColumns);
			});
	}

	/**
	 * The columns of an existing table, or an UNKNOWN_TABLE store error (a wipe).
	 *
	 * @param {string} pTable
	 * @param {(pError?: Error, pColumns?: Map<string, string>) => void} fCallback
	 */
	_existingColumns(pTable, fCallback)
	{
		this._columnsOf(pTable,
			(pError, pColumns) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pColumns || (pColumns.size < 1))
				{
					if (pTable.indexOf(libDDL.SHADOW_INFIX) > 0)
					{
						// A shadow that is gone (an aborted or finished rebuild) is not a wiped store.
						let tmpShadowError = storeError(`ClickHouse shadow table ${this.Database}.${pTable} does not exist.`, null);
						tmpShadowError.ShadowMissing = true;
						return fCallback(this._failed(tmpShadowError, 'table lookup'));
					}
					return fCallback(this._failed(storeError(`ClickHouse table ${this.Database}.${pTable} does not exist.`, 60), 'table lookup'));
				}
				return fCallback(null, pColumns);
			});
	}

	/**
	 * Forget the cached columns of an entity's tables.
	 *
	 * @param {string} pEntity
	 */
	_forgetTables(pEntity)
	{
		let tmpPrefixes = [ `${pEntity}`, `${libDDL.KEYMAP_PREFIX}${pEntity}` ];
		Array.from(this._TableColumns.keys()).forEach(
			(pTable) =>
			{
				if (tmpPrefixes.some((pPrefix) => { return (pTable === pPrefix) || (pTable.indexOf(`${pPrefix}${libDDL.SHADOW_INFIX}`) === 0); }))
				{
					this._TableColumns.delete(pTable);
				}
			});
	}

	/**
	 * Register the spec of an entity's live tables or of a shadow build.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {string|null} pBuildID
	 */
	_registerSpec(pEntity, pSpec, pBuildID)
	{
		if (!libFacetUtil.hasOwn(this._Specs, pEntity))
		{
			this._Specs[pEntity] = { Live: null, Shadows: {} };
		}
		if (pBuildID)
		{
			this._Specs[pEntity].Shadows[pBuildID] = pSpec;
		}
		else
		{
			this._Specs[pEntity].Live = pSpec;
		}
	}

	/**
	 * The spec and table names of a write / key-read target.
	 *
	 * @param {string} pEntity
	 * @param {string} pTarget - 'Live' | 'Shadow:<BuildID>'
	 * @return {{ Spec: Record<string, any>, BuildID: string|null, Mirror: string, Keymap: string } | { Error: Error }}
	 */
	_target(pEntity, pTarget)
	{
		let tmpBuildID = null;
		if (pTarget !== libRetoldFacetingStoreBase.TARGET_LIVE)
		{
			tmpBuildID = libRetoldFacetingStoreBase.isShadowTarget(pTarget);
			if (!tmpBuildID)
			{
				return { Error: storeError('A store target is Live or Shadow:<BuildID>.', null) };
			}
		}
		let tmpRegistered = libFacetUtil.hasOwn(this._Specs, pEntity) ? this._Specs[pEntity] : null;
		let tmpSpec = null;
		if (tmpRegistered)
		{
			tmpSpec = (tmpBuildID && libFacetUtil.hasOwn(tmpRegistered.Shadows, tmpBuildID)) ? tmpRegistered.Shadows[tmpBuildID] : tmpRegistered.Live;
		}
		if (!tmpSpec)
		{
			let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
			tmpSpec = (tmpMirrorSpec && (typeof(tmpMirrorSpec.spec) === 'function')) ? tmpMirrorSpec.spec(STORE_NAME, pEntity) : null;
		}
		if (!tmpSpec)
		{
			return { Error: storeError('The entity has no MirrorSpec in the ClickHouse store.', null) };
		}
		try
		{
			return { Spec: tmpSpec, BuildID: tmpBuildID, Mirror: libDDL.mirrorTableName(pEntity, tmpBuildID), Keymap: libDDL.keymapTableName(pEntity, tmpBuildID) };
		}
		catch (pNameError)
		{
			return { Error: storeError('An invalid entity name for the ClickHouse store.', null) };
		}
	}

	// ---- schema -----------------------------------------------------------------------------

	/**
	 * CREATE DATABASE … ENGINE = Atomic and _rfs_entity_state, then report per spec what exists
	 * (§54.3).  Live mirrors and keymaps are never created here (only a backfill's RENAME makes them).
	 *
	 * Report per entity: { MirrorExists, KeymapExists, SpecHash (mirror COMMENT), KeymapSpecHash,
	 * Columns: [ non-meta names ], ColumnTypes: { name: type }, SortKey: [ … ], KeymapColumns: [ … ],
	 * KeymapColumnTypes: { … }, KeymapSortKey: [ … ], Shadows: [ leftover shadow BuildIDs ] }.
	 *
	 * @param {Record<string, Record<string, any>>|Array<Record<string, any>>} pSpecs - { Entity: MirrorSpec }
	 * @param {(pError?: Error, pResult?: { Database: string, Entities: Record<string, any> }) => void} fCallback
	 */
	ensureSchema(pSpecs, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpSpecs = {};
		(Array.isArray(pSpecs) ? pSpecs : Object.keys(libFacetUtil.isPlainObject(pSpecs) ? pSpecs : {}).map((pEntity) => { return pSpecs[pEntity]; })).forEach(
			(pSpec) =>
			{
				if (pSpec && (typeof(pSpec.Entity) === 'string'))
				{
					tmpSpecs[pSpec.Entity] = pSpec;
				}
			});
		let tmpTables = [];
		let tmpColumns = [];
		this._series(
			[
				(fNext) => { this._command(libDDL.createDatabaseDDL(this.Database), null, 'CREATE DATABASE', fNext); },
				(fNext) =>
				{
					this._query('SELECT engine FROM system.databases WHERE name = {db:String}', { db: this.Database }, 'database check',
						(pError, pRows) =>
						{
							if (pError)
							{
								return fNext(pError);
							}
							if (!pRows[0] || (pRows[0].engine !== 'Atomic'))
							{
								return fNext(this._failed(storeError(`ClickHouse database ${this.Database} is not ENGINE = Atomic (EXCHANGE TABLES needs it).`, null), 'database check'));
							}
							return fNext();
						});
				},
				(fNext) => { this._command(libDDL.entityStateDDL(this.Database), null, 'CREATE state table', fNext); },
				(fNext) => { this._command(libDDL.leaseDDL(this.Database), null, 'CREATE lease table', fNext); },
				(fNext) => { this._command(libDDL.ownerDDL(this.Database), null, 'CREATE owner table', fNext); },
				(fNext) => { this._checkOwner(fNext); },
				(fNext) =>
				{
					this._query('SELECT name, comment, sorting_key FROM system.tables WHERE database = {db:String}', { db: this.Database }, 'table list',
						(pError, pRows) =>
						{
							tmpTables = pRows || [];
							return fNext(pError);
						});
				},
				(fNext) =>
				{
					this._query('SELECT table, name, type FROM system.columns WHERE database = {db:String} ORDER BY table, position', { db: this.Database }, 'column list',
						(pError, pRows) =>
						{
							tmpColumns = pRows || [];
							return fNext(pError);
						});
				}
			],
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpTableInfo = {};
				tmpTables.forEach((pRow) => { tmpTableInfo[pRow.name] = { Comment: pRow.comment, SortKey: String(pRow.sorting_key || '').split(',').map((pPart) => { return pPart.trim().replace(/^`|`$/g, ''); }).filter((pPart) => { return pPart.length > 0; }), Columns: new Map() }; });
				tmpColumns.forEach(
					(pRow) =>
					{
						if (libFacetUtil.hasOwn(tmpTableInfo, pRow.table))
						{
							tmpTableInfo[pRow.table].Columns.set(pRow.name, pRow.type);
						}
					});
				this._TableColumns = new Map();
				Object.keys(tmpTableInfo).forEach((pTable) => { this._TableColumns.set(pTable, tmpTableInfo[pTable].Columns); });
				let tmpReport = {};
				Object.keys(tmpSpecs).sort().forEach(
					(pEntity) =>
					{
						let tmpMirrorName = null;
						let tmpKeymapName = null;
						try
						{
							tmpMirrorName = libDDL.mirrorTableName(pEntity);
							tmpKeymapName = libDDL.keymapTableName(pEntity);
						}
						catch (pNameError)
						{
							return;
						}
						let tmpMirror = libFacetUtil.hasOwn(tmpTableInfo, tmpMirrorName) ? tmpTableInfo[tmpMirrorName] : null;
						let tmpKeymap = libFacetUtil.hasOwn(tmpTableInfo, tmpKeymapName) ? tmpTableInfo[tmpKeymapName] : null;
						let fNonMeta = (pInfo) =>
						{
							let tmpTypes = {};
							if (pInfo)
							{
								pInfo.Columns.forEach((pType, pName) => { if (libDDL.META_COLUMNS.indexOf(pName) < 0) { tmpTypes[pName] = pType; } });
							}
							return tmpTypes;
						};
						let tmpMirrorTypes = fNonMeta(tmpMirror);
						let tmpKeymapTypes = fNonMeta(tmpKeymap);
						let tmpMirrorComment = tmpMirror ? libDDL.parseSpecComment(tmpMirror.Comment) : null;
						let tmpKeymapComment = tmpKeymap ? libDDL.parseSpecComment(tmpKeymap.Comment) : null;
						let tmpShadowPattern = new RegExp(`^${pEntity}${libDDL.SHADOW_INFIX}([0-9a-f]{8})$`);
						tmpReport[pEntity] =
							{
								MirrorExists: !!tmpMirror,
								KeymapExists: !!tmpKeymap,
								SpecHash: tmpMirrorComment ? tmpMirrorComment.SpecHash : null,
								KeymapSpecHash: tmpKeymapComment ? tmpKeymapComment.SpecHash : null,
								Columns: Object.keys(tmpMirrorTypes),
								ColumnTypes: tmpMirrorTypes,
								SortKey: tmpMirror ? tmpMirror.SortKey : [],
								KeymapColumns: Object.keys(tmpKeymapTypes),
								KeymapColumnTypes: tmpKeymapTypes,
								KeymapSortKey: tmpKeymap ? tmpKeymap.SortKey : [],
								Shadows: Object.keys(tmpTableInfo).map((pTable) => { let tmpMatch = tmpShadowPattern.exec(pTable); return tmpMatch ? tmpMatch[1] : null; }).filter((pBuildID) => { return !!pBuildID; }).sort()
							};
						this._registerSpec(pEntity, tmpSpecs[pEntity], null);
					});
				return fCallback(null, { Database: this.Database, Entities: tmpReport });
			});
	}

	/**
	 * The database's owner marker (_rfs_owner): written on first use (this deployment's InstanceID and
	 * source fingerprint); a marker another deployment wrote refuses the store ('OwnerMismatch',
	 * Misconfigured — never retried, never written over) unless Stores.ClickHouse.Owner is 'Adopt'.  So
	 * two deployments pointed at one database (two apps with overlapping entity names, staging and
	 * production on one cluster) can never read or rewrite each other's mirrors.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	_checkOwner(fCallback)
	{
		let tmpInstanceID = this._StoreOptions ? this._StoreOptions.InstanceID : String(this.options.InstanceID);
		let tmpFingerprint = (typeof(this.SourceFingerprint) === 'string') ? this.SourceFingerprint : '';
		this._query(`SELECT \`InstanceID\`, \`Fingerprint\` FROM ${libDDL.qualified(this.Database, libDDL.OWNER_TABLE)} FINAL WHERE \`Store\` = {s:String}`, { s: STORE_NAME }, 'owner read',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpRow = pRows[0] || null;
				let tmpAdopt = this._StoreOptions && (this._StoreOptions.Owner === 'Adopt');
				if (tmpRow && !tmpAdopt)
				{
					let tmpSameInstance = (tmpRow.InstanceID === tmpInstanceID);
					let tmpSameSource = !tmpRow.Fingerprint || !tmpFingerprint || (tmpRow.Fingerprint === tmpFingerprint);
					if (tmpSameInstance && tmpSameSource)
					{
						return fCallback(null);
					}
					let tmpMismatch = storeError(`ClickHouse database ${this.Database} belongs to another deployment (${tmpSameInstance ? 'another source database' : 'another InstanceID'}); refusing it.  Point Stores.ClickHouse.Database elsewhere, or set Stores.ClickHouse.Owner: 'Adopt' to take it over.`, null);
					tmpMismatch.OwnerMismatch = true;
					this._Status = Object.assign({}, this._Status, { Available: false, Reason: 'Misconfigured', LastError: tmpMismatch.message });
					this.fable.log.error(`RetoldFaceting ${tmpMismatch.message}`);
					return fCallback(tmpMismatch);
				}
				if (tmpRow && tmpAdopt && (tmpRow.InstanceID === tmpInstanceID) && (tmpRow.Fingerprint === tmpFingerprint))
				{
					return fCallback(null);
				}
				let tmpVersion = Math.max(Date.now() * 1000, this._StateVersionFloor + 1);
				this._StateVersionFloor = tmpVersion;
				this._Counters.Statements++;
				this.Client.insert(libDDL.qualified(this.Database, libDDL.OWNER_TABLE), [ { Store: STORE_NAME, InstanceID: tmpInstanceID, Fingerprint: tmpFingerprint, _Version: tmpVersion } ], { Token: `owner:${tmpVersion}`, Retries: 1 },
					(pWriteError) =>
					{
						if (pWriteError)
						{
							return fCallback(this._failed(pWriteError, 'owner write'));
						}
						if (tmpRow && tmpAdopt)
						{
							this.fable.log.warn(`RetoldFaceting ClickHouse database ${this.Database} adopted by InstanceID ${tmpInstanceID} (Stores.ClickHouse.Owner 'Adopt').`);
						}
						return fCallback(null);
					});
			});
	}

	// ---- the materializer lease ---------------------------------------------------------------

	/**
	 * The lease row of this store (FINAL: the latest version), or null.
	 *
	 * @param {(pError?: Error, pLease?: { Owner: string, ExpiresAtMS: number|null, Released: boolean, Version: number }|null) => void} fCallback
	 */
	readLease(fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._query(`SELECT \`Owner\`, toString(\`ExpiresAt\`) AS ExpiresAt, \`Released\`, \`_Version\` FROM ${libDDL.qualified(this.Database, libDDL.LEASE_TABLE)} FINAL WHERE \`Store\` = {s:String}`, { s: STORE_NAME }, 'lease read',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpRow = pRows[0];
				if (!tmpRow)
				{
					return fCallback(null, null);
				}
				return fCallback(null, { Owner: String(tmpRow.Owner || ''), ExpiresAtMS: stateDateMS(tmpRow.ExpiresAt), Released: (Number(tmpRow.Released) === 1), Version: tmpRow._Version });
			});
	}

	/**
	 * Write the lease row (a claim, a heartbeat or a release), version from the caller's WriterClock.
	 *
	 * @param {{ Owner: string, ExpiresAtMS: number, Released?: boolean, Version: number }} pLease
	 * @param {(pError?: Error) => void} fCallback
	 * @param {{ TimeoutMS?: number }} [pCallOptions]
	 */
	writeLease(pLease, fCallback, pCallOptions)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpLease = libFacetUtil.isPlainObject(pLease) ? pLease : {};
		if ((typeof(tmpLease.Owner) !== 'string') || !Number.isSafeInteger(tmpLease.Version) || !Number.isFinite(tmpLease.ExpiresAtMS))
		{
			return fCallback(storeError('A lease needs an Owner, an ExpiresAtMS and a Version.', null));
		}
		this._StateVersionFloor = Math.max(this._StateVersionFloor, tmpLease.Version);
		this._Counters.Statements++;
		let tmpOptions = { Token: `lease:${tmpLease.Version}`, Retries: (pCallOptions && pCallOptions.TimeoutMS) ? 0 : 1 };
		if (pCallOptions && Number.isFinite(pCallOptions.TimeoutMS))
		{
			tmpOptions.TimeoutMS = pCallOptions.TimeoutMS;
		}
		this.Client.insert(libDDL.qualified(this.Database, libDDL.LEASE_TABLE),
			[ { Store: STORE_NAME, Owner: tmpLease.Owner, ExpiresAt: stateDateText(tmpLease.ExpiresAtMS), Released: tmpLease.Released ? 1 : 0, _Version: tmpLease.Version } ], tmpOptions,
			(pError) =>
			{
				this.noteOutcome(pError || null);
				return fCallback(pError ? this._failed(pError, 'lease write') : null);
			});
	}

	/**
	 * The live mirror and keymap IF NOT EXISTS — Facet-ClickHouse-Support.loadMirrors and tests only.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {(pError?: Error) => void} fCallback
	 */
	createLive(pEntity, pSpec, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpMirrorDDL;
		let tmpKeymapDDL;
		try
		{
			tmpMirrorDDL = libDDL.mirrorDDL(this.Database, pSpec);
			tmpKeymapDDL = libDDL.keymapDDL(this.Database, pSpec);
		}
		catch (pDDLError)
		{
			return fCallback(storeError(`The MirrorSpec of ${pEntity} cannot be rendered as DDL: ${pDDLError.message}`, null));
		}
		this._forgetTables(pEntity);
		this._series(
			[
				(fNext) => { this._command(tmpMirrorDDL, null, `CREATE ${pEntity}`, fNext); },
				(fNext) => { this._command(tmpKeymapDDL, null, `CREATE keymap of ${pEntity}`, fNext); }
			],
			(pError) =>
			{
				if (!pError)
				{
					this._registerSpec(pEntity, pSpec, null);
				}
				return fCallback(pError || null);
			});
	}

	/**
	 * Additive change (§55.4): ADD COLUMN IF NOT EXISTS on the mirror (and on the keymap for the
	 * spec's KeymapColumns among them), then both COMMENTs to the new SpecHash.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec - the new spec
	 * @param {Array<string|{ Column: string }>} pColumns - the added columns
	 * @param {(pError?: Error) => void} fCallback
	 */
	addColumns(pEntity, pSpec, pColumns, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpMirrorAdds = [];
		let tmpKeymapAdds = [];
		let tmpMirrorSQL;
		let tmpKeymapSQL;
		try
		{
			(Array.isArray(pColumns) ? pColumns : []).forEach(
				(pColumn) =>
				{
					let tmpName = (typeof(pColumn) === 'string') ? pColumn : (pColumn ? pColumn.Column : null);
					let tmpSpecColumn = libTypeMap.specColumn(pSpec, tmpName);
					if (!tmpSpecColumn)
					{
						throw new Error('an added column is not in the spec');
					}
					tmpMirrorAdds.push({ Column: tmpSpecColumn.Column, Mirror: tmpSpecColumn.Mirror });
					if (Array.isArray(pSpec.KeymapColumns) && (pSpec.KeymapColumns.indexOf(tmpSpecColumn.Column) >= 0))
					{
						tmpKeymapAdds.push({ Column: tmpSpecColumn.Column, Mirror: tmpSpecColumn.Mirror });
					}
				});
			tmpMirrorSQL = libDDL.addColumnsDDL(this.Database, libDDL.mirrorTableName(pEntity), tmpMirrorAdds, libDDL.specComment('mirror', pEntity, pSpec.SpecHash));
			tmpKeymapSQL = libDDL.addColumnsDDL(this.Database, libDDL.keymapTableName(pEntity), tmpKeymapAdds, libDDL.specComment('keymap', pEntity, pSpec.SpecHash));
		}
		catch (pDDLError)
		{
			return fCallback(storeError(`The additive change of ${pEntity} cannot be rendered: ${pDDLError.message}`, null));
		}
		this._forgetTables(pEntity);
		this._series(
			[
				(fNext) => { this._command(tmpMirrorSQL, null, `ALTER ${pEntity}`, fNext); },
				(fNext) => { this._command(tmpKeymapSQL, null, `ALTER keymap of ${pEntity}`, fNext); }
			],
			(pError) =>
			{
				this._forgetTables(pEntity);
				if (!pError)
				{
					this._registerSpec(pEntity, pSpec, null);
				}
				return fCallback(pError || null);
			});
	}

	/**
	 * @param {(pError?: Error, pHealth?: { Up: boolean, Version: string|null, Database: string|null, Tables: number, ActivePartsMax: number }) => void} fCallback
	 */
	health(fCallback)
	{
		if (!this.Client)
		{
			return fCallback(null, { Up: false, Version: null, Database: this.Database, Tables: 0, ActivePartsMax: 0 });
		}
		this.connect(
			(pConnectError, pConnected) =>
			{
				if (!pConnected || !pConnected.Up)
				{
					return fCallback(null, { Up: false, Version: null, Database: this.Database, Tables: 0, ActivePartsMax: 0 });
				}
				this._query('SELECT (SELECT count() FROM system.tables WHERE database = {db:String}) AS Tables, (SELECT max(Parts) FROM (SELECT count() AS Parts FROM system.parts WHERE database = {db:String} AND active GROUP BY table)) AS ActivePartsMax',
					{ db: this.Database }, 'health',
					(pError, pRows) =>
					{
						if (pError)
						{
							return fCallback(pError);
						}
						let tmpRow = pRows[0] || {};
						return fCallback(null, { Up: true, Version: pConnected.Version, Database: this.Database, Tables: Number(tmpRow.Tables) || 0, ActivePartsMax: Number(tmpRow.ActivePartsMax) || 0 });
					});
			});
	}

	/**
	 * The largest _Version in any table of the database (0 when none): the WriterClock floor (§58.4).
	 *
	 * @param {(pError?: Error, pMaxVersion?: number) => void} fCallback
	 */
	maxVersion(fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._query("SELECT table FROM system.columns WHERE database = {db:String} AND name = '_Version' ORDER BY table", { db: this.Database }, 'version tables',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpParts = [];
				pRows.forEach(
					(pRow) =>
					{
						try
						{
							tmpParts.push(`SELECT max(\`_Version\`) AS V FROM ${libDDL.qualified(this.Database, pRow.table)}`);
						}
						catch (pNameError)
						{
							// A table we did not create (an odd name): not ours, so not part of the floor.
						}
					});
				if (tmpParts.length < 1)
				{
					return fCallback(null, Math.max(0, this._StateVersionFloor));
				}
				this._query(`SELECT max(V) AS V FROM (${tmpParts.join(' UNION ALL ')})`, null, 'max version',
					(pMaxError, pMaxRows) =>
					{
						if (pMaxError)
						{
							return fCallback(pMaxError);
						}
						let tmpMax = (pMaxRows[0] && Number.isSafeInteger(pMaxRows[0].V)) ? pMaxRows[0].V : 0;
						this._StateVersionFloor = Math.max(this._StateVersionFloor, tmpMax);
						return fCallback(null, tmpMax);
					});
			});
	}

	// ---- write side -------------------------------------------------------------------------

	/**
	 * Keymap rows → Map<ID, [ { Key, Tracked, UpdateDate, Version } ]>.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Array<Record<string, any>>} pRows
	 * @param {Map<number, Array<Record<string, any>>>} pMap
	 */
	_keyEntries(pSpec, pRows, pMap)
	{
		for (let i = 0; i < pRows.length; i++)
		{
			let tmpRow = pRows[i];
			let tmpID = tmpRow[pSpec.Identity];
			let tmpEntry =
				{
					Key: libTypeMap.keyOf(pSpec, tmpRow),
					Tracked: libTypeMap.trackedOf(pSpec, tmpRow),
					UpdateDate: libFacetUtil.hasOwn(tmpRow, 'UpdateDate') ? tmpRow.UpdateDate : null,
					Version: tmpRow._Version
				};
			if (!pMap.has(tmpID))
			{
				pMap.set(tmpID, []);
			}
			pMap.get(tmpID).push(tmpEntry);
		}
	}

	/**
	 * The keymap SELECT list of a target (the spec's keymap columns the table has, plus _Version and
	 * _IsDeleted).
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Map<string, string>} pColumns
	 * @return {string}
	 */
	_keymapSelect(pSpec, pColumns)
	{
		let tmpNames = libDDL.keymapColumns(pSpec).map((pColumn) => { return pColumn.Column; }).filter((pName) => { return pColumns.has(pName); });
		return tmpNames.concat([ '_Version', '_IsDeleted' ]).map(libDDL.quoteIdentifier).join(', ');
	}

	/**
	 * Keymap rows read WITHOUT FINAL → the live keys: per (ID, sort-key scope values) the row with the
	 * highest _Version wins (on a tie the retirement: it is always inserted after the intent), and the key
	 * is live iff that row is not deleted — exactly what FINAL with `_IsDeleted` = 0 returns, without
	 * FINAL's merge-on-read (an ID has only a few keymap rows; FINAL read ~20× the rows at 20M, measured).
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Array<Record<string, any>>} pRows
	 * @param {Map<number, Array<Record<string, any>>>} pMap
	 */
	_liveKeyEntries(pSpec, pRows, pMap)
	{
		let tmpLatest = new Map();
		let tmpKeyColumns = libTypeMap.keyColumnsOf(pSpec);
		for (let i = 0; i < pRows.length; i++)
		{
			let tmpRow = pRows[i];
			let tmpText = JSON.stringify([ tmpRow[pSpec.Identity] ].concat(tmpKeyColumns.map((pColumn) => { return libFacetUtil.hasOwn(tmpRow, pColumn) ? tmpRow[pColumn] : null; })));
			let tmpKept = tmpLatest.get(tmpText);
			let tmpVersion = Number(tmpRow._Version);
			if (!tmpKept || (tmpVersion > Number(tmpKept._Version)) || ((tmpVersion === Number(tmpKept._Version)) && (Number(tmpRow._IsDeleted) === 1)))
			{
				tmpLatest.set(tmpText, tmpRow);
			}
		}
		let tmpLive = [];
		tmpLatest.forEach((pRow) => { if (Number(pRow._IsDeleted) !== 1) { tmpLive.push(pRow); } });
		this._keyEntries(pSpec, tmpLive, pMap);
	}

	/**
	 * Keymap point read (§54.3): every live key of each ID (latest version per key, not deleted; read
	 * without FINAL, see _liveKeyEntries).
	 *
	 * @param {string} pEntity
	 * @param {Array<number>} pIDs
	 * @param {string} pTarget
	 * @param {(pError?: Error, pKeys?: Map<number, Array<Record<string, any>>>) => void} fCallback
	 */
	readKeys(pEntity, pIDs, pTarget, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpTarget = this._target(pEntity, pTarget);
		if (tmpTarget.Error)
		{
			return fCallback(tmpTarget.Error);
		}
		let tmpIDs = Array.from(new Set((Array.isArray(pIDs) ? pIDs : []).filter((pID) => { return Number.isSafeInteger(pID); })));
		let tmpMap = new Map();
		if (tmpIDs.length < 1)
		{
			return fCallback(null, tmpMap);
		}
		this._existingColumns(tmpTarget.Keymap,
			(pColumnsError, pColumns) =>
			{
				if (pColumnsError)
				{
					return fCallback(pColumnsError);
				}
				let tmpSQL = `SELECT ${this._keymapSelect(tmpTarget.Spec, pColumns)} FROM ${libDDL.qualified(this.Database, tmpTarget.Keymap)} `
					+ `WHERE ${libDDL.quoteIdentifier(tmpTarget.Spec.Identity)} IN {ids:Array(Int64)}`;
				let tmpTasks = [];
				for (let i = 0; i < tmpIDs.length; i += ID_CHUNK)
				{
					let tmpChunk = tmpIDs.slice(i, i + ID_CHUNK);
					tmpTasks.push(
						(fNext) =>
						{
							this._query(tmpSQL, { ids: tmpChunk }, `keymap read of ${pEntity}`,
								(pError, pRows) =>
								{
									if (!pError)
									{
										this._liveKeyEntries(tmpTarget.Spec, pRows, tmpMap);
									}
									return fNext(pError);
								}, tmpTarget.Keymap);
						});
				}
				this._series(tmpTasks, (pError) => { return fCallback(pError || null, pError ? undefined : tmpMap); });
			});
	}

	/**
	 * The identity range predicate (AfterID exclusive, ToID inclusive; null = open).
	 *
	 * @param {string} pIdentity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {Record<string, any>} pParams - receives fAfter / fTo
	 * @return {string} '' or ' AND …'
	 */
	_rangePredicate(pIdentity, pAfterID, pToID, pParams)
	{
		let tmpSQL = '';
		if ((pAfterID !== null) && (typeof(pAfterID) !== 'undefined'))
		{
			pParams.fAfter = pAfterID;
			tmpSQL += ` AND ${libDDL.quoteIdentifier(pIdentity)} > {fAfter:Int64}`;
		}
		if ((pToID !== null) && (typeof(pToID) !== 'undefined'))
		{
			pParams.fTo = pToID;
			tmpSQL += ` AND ${libDDL.quoteIdentifier(pIdentity)} <= {fTo:Int64}`;
		}
		return tmpSQL;
	}

	/**
	 * @param {any} pValue
	 * @return {boolean} null / undefined or a safe integer
	 */
	_validBound(pValue)
	{
		return (pValue === null) || (typeof(pValue) === 'undefined') || Number.isSafeInteger(pValue);
	}

	/**
	 * Keymap range read: every live key of every ID in (AfterID, ToID].
	 *
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {string} pTarget
	 * @param {(pError?: Error, pKeys?: Map<number, Array<Record<string, any>>>) => void} fCallback
	 */
	readKeyRange(pEntity, pAfterID, pToID, pTarget, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpTarget = this._target(pEntity, pTarget);
		if (tmpTarget.Error)
		{
			return fCallback(tmpTarget.Error);
		}
		if (!this._validBound(pAfterID) || !this._validBound(pToID))
		{
			return fCallback(storeError('A key range bound is a safe integer or null.', null));
		}
		this._existingColumns(tmpTarget.Keymap,
			(pColumnsError, pColumns) =>
			{
				if (pColumnsError)
				{
					return fCallback(pColumnsError);
				}
				let tmpParams = {};
				let tmpIdentity = libDDL.quoteIdentifier(tmpTarget.Spec.Identity);
				let tmpRange = this._rangePredicate(tmpTarget.Spec.Identity, pAfterID, pToID, tmpParams);
				let tmpSQL = `SELECT ${this._keymapSelect(tmpTarget.Spec, pColumns)} FROM ${libDDL.qualified(this.Database, tmpTarget.Keymap)} `
					+ `WHERE 1${tmpRange} ORDER BY ${tmpIdentity}`;
				this._query(tmpSQL, tmpParams, `keymap range read of ${pEntity}`,
					(pError, pRows) =>
					{
						if (pError)
						{
							return fCallback(pError);
						}
						let tmpMap = new Map();
						this._liveKeyEntries(tmpTarget.Spec, pRows, tmpMap);
						return fCallback(null, tmpMap);
					}, tmpTarget.Keymap);
			});
	}

	/**
	 * A batch entry's version (a non-negative safe integer) or null.
	 *
	 * @param {Record<string, any>} pEntry
	 * @return {number|null}
	 */
	_versionOf(pEntry)
	{
		let tmpVersion = libFacetUtil.hasOwn(pEntry, '_Version') ? pEntry._Version : pEntry.Version;
		return (Number.isSafeInteger(tmpVersion) && (tmpVersion >= 0)) ? tmpVersion : null;
	}

	/**
	 * A row restricted to a table's columns; a value whose spec type differs from the table's type
	 * (a retyped column of an old live table during a SpecChange rebuild) is written NULL.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Map<string, string>} pColumns
	 * @param {Record<string, any>} pValues
	 * @return {Record<string, any>}
	 */
	_project(pSpec, pColumns, pValues)
	{
		let tmpRow = {};
		let tmpNames = Object.keys(pValues);
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpName = tmpNames[i];
			if (!pColumns.has(tmpName))
			{
				continue;
			}
			let tmpValue = pValues[tmpName];
			if (libDDL.META_COLUMNS.indexOf(tmpName) < 0)
			{
				let tmpSpecColumn = libTypeMap.specColumn(pSpec, tmpName);
				if (tmpSpecColumn && (tmpSpecColumn.Mirror !== pColumns.get(tmpName)) && (tmpValue !== null))
				{
					tmpValue = /^Nullable\(/.test(pColumns.get(tmpName)) ? null : tmpValue;
				}
			}
			tmpRow[tmpName] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
		}
		return tmpRow;
	}

	/**
	 * Identity + Key (+ optional extras) of a keyed batch entry ({ ID, Key, … } or a flat row).
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pEntry
	 * @return {Record<string, any>|null}
	 */
	_keyedValues(pSpec, pEntry)
	{
		let tmpValues = {};
		let tmpKeyColumns = libTypeMap.keyColumnsOf(pSpec);
		if (libFacetUtil.hasOwn(pEntry, 'ID') && libFacetUtil.isPlainObject(pEntry.Key))
		{
			tmpValues[pSpec.Identity] = pEntry.ID;
			tmpKeyColumns.forEach((pColumn) => { tmpValues[pColumn] = libFacetUtil.hasOwn(pEntry.Key, pColumn) ? pEntry.Key[pColumn] : null; });
		}
		else
		{
			tmpValues[pSpec.Identity] = pEntry[pSpec.Identity];
			tmpKeyColumns.forEach((pColumn) => { tmpValues[pColumn] = libFacetUtil.hasOwn(pEntry, pColumn) ? pEntry[pColumn] : null; });
		}
		return Number.isSafeInteger(tmpValues[pSpec.Identity]) ? tmpValues : null;
	}

	/**
	 * Build the three insert row lists of a batch for one target.
	 *
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pBatch
	 * @param {Map<string, string>} pMirrorColumns
	 * @param {Map<string, string>} pKeymapColumns
	 * @return {{ Intents: Array<Record<string, any>>, Mirror: Array<Record<string, any>>, Retires: Array<Record<string, any>>, Rows: number, Tombstones: number } | { Error: string }}
	 */
	_batchRows(pSpec, pBatch, pMirrorColumns, pKeymapColumns)
	{
		let tmpBatch = libFacetUtil.isPlainObject(pBatch) ? pBatch : {};
		let tmpMirror = [];
		let tmpIntents = [];
		let tmpRetires = [];
		let tmpRows = Array.isArray(tmpBatch.Rows) ? tmpBatch.Rows : [];
		let tmpTombstones = Array.isArray(tmpBatch.Tombstones) ? tmpBatch.Tombstones : [];
		let tmpKeyIntents = Array.isArray(tmpBatch.KeyIntents) ? tmpBatch.KeyIntents : [];
		let tmpKeyRetires = Array.isArray(tmpBatch.KeyRetires) ? tmpBatch.KeyRetires : [];
		for (let i = 0; i < tmpRows.length; i++)
		{
			let tmpEntry = tmpRows[i];
			if (!libFacetUtil.isPlainObject(tmpEntry))
			{
				return { Error: 'a Row is not an object' };
			}
			let tmpValues = (libFacetUtil.isPlainObject(tmpEntry.Row) && !libFacetUtil.hasOwn(tmpEntry, '_Version')) ? Object.assign({}, tmpEntry.Row) : Object.assign({}, tmpEntry);
			let tmpVersion = this._versionOf(tmpEntry);
			if ((tmpVersion === null) || !Number.isSafeInteger(tmpValues[pSpec.Identity]))
			{
				return { Error: 'a Row needs a safe integer identity and a _Version' };
			}
			tmpValues._Version = tmpVersion;
			tmpValues._IsDeleted = 0;
			delete tmpValues._AppliedAt;
			tmpMirror.push(this._project(pSpec, pMirrorColumns, tmpValues));
		}
		for (let i = 0; i < tmpTombstones.length; i++)
		{
			let tmpEntry = tmpTombstones[i];
			let tmpValues = libFacetUtil.isPlainObject(tmpEntry) ? this._keyedValues(pSpec, tmpEntry) : null;
			let tmpVersion = libFacetUtil.isPlainObject(tmpEntry) ? this._versionOf(tmpEntry) : null;
			if (!tmpValues || (tmpVersion === null))
			{
				return { Error: 'a Tombstone needs an ID, its Key and a Version' };
			}
			tmpValues._Version = tmpVersion;
			tmpValues._IsDeleted = 1;
			tmpMirror.push(this._project(pSpec, pMirrorColumns, tmpValues));
		}
		for (let i = 0; i < tmpKeyIntents.length; i++)
		{
			let tmpEntry = tmpKeyIntents[i];
			let tmpValues = libFacetUtil.isPlainObject(tmpEntry) ? this._keyedValues(pSpec, tmpEntry) : null;
			let tmpVersion = libFacetUtil.isPlainObject(tmpEntry) ? this._versionOf(tmpEntry) : null;
			if (!tmpValues || (tmpVersion === null))
			{
				return { Error: 'a KeyIntent needs an ID, its Key and a Version' };
			}
			let tmpWrapped = libFacetUtil.hasOwn(tmpEntry, 'ID') && libFacetUtil.isPlainObject(tmpEntry.Key);
			let tmpExtras = tmpWrapped ? (libFacetUtil.isPlainObject(tmpEntry.Tracked) ? tmpEntry.Tracked : {}) : tmpEntry;
			(Array.isArray(pSpec.TrackedKeyColumns) ? pSpec.TrackedKeyColumns : []).forEach(
				(pColumn) =>
				{
					if (!libFacetUtil.hasOwn(tmpValues, pColumn) && libFacetUtil.hasOwn(tmpExtras, pColumn))
					{
						tmpValues[pColumn] = tmpExtras[pColumn];
					}
				});
			if (libFacetUtil.hasOwn(tmpEntry, 'UpdateDate'))
			{
				tmpValues.UpdateDate = tmpEntry.UpdateDate;
			}
			tmpValues._Version = tmpVersion;
			tmpValues._IsDeleted = 0;
			tmpIntents.push(this._project(pSpec, pKeymapColumns, tmpValues));
		}
		for (let i = 0; i < tmpKeyRetires.length; i++)
		{
			let tmpEntry = tmpKeyRetires[i];
			let tmpValues = libFacetUtil.isPlainObject(tmpEntry) ? this._keyedValues(pSpec, tmpEntry) : null;
			let tmpVersion = libFacetUtil.isPlainObject(tmpEntry) ? this._versionOf(tmpEntry) : null;
			if (!tmpValues || (tmpVersion === null))
			{
				return { Error: 'a KeyRetire needs an ID, its Key and a Version' };
			}
			tmpValues._Version = tmpVersion;
			tmpValues._IsDeleted = 1;
			tmpRetires.push(this._project(pSpec, pKeymapColumns, tmpValues));
		}
		return { Intents: tmpIntents, Mirror: tmpMirror, Retires: tmpRetires, Rows: tmpRows.length, Tombstones: tmpTombstones.length };
	}

	/**
	 * The exact-float insert of a table that has Float64 columns: INSERT INTO t (…) SELECT …,
	 * toFloat64(<f>) … FROM input('… <f> Nullable(String) …') FORMAT JSONEachRow, sent with
	 * precise_float_parsing = 1 (the JSON parser is not exact; see READ_SETTINGS).  null when the table
	 * has no Float64 column (a plain JSONEachRow insert).
	 *
	 * @param {string} pTable
	 * @param {Map<string, string>} pColumns - the table's columns (name → type)
	 * @return {{ Query: string, Float: Array<string> }|null}
	 */
	_insertQuery(pTable, pColumns)
	{
		let tmpFloat = [];
		pColumns.forEach((pType, pName) => { if (/^(?:Nullable\()?Float64\)?$/.test(pType)) { tmpFloat.push(pName); } });
		if (tmpFloat.length < 1)
		{
			return null;
		}
		// _AppliedAt keeps its table DEFAULT (now64(3)).
		let tmpNames = Array.from(pColumns.keys()).filter((pName) => { return pName !== '_AppliedAt'; });
		let tmpStructure = tmpNames.map(
			(pName) =>
			{
				let tmpType = pColumns.get(pName);
				if (tmpFloat.indexOf(pName) >= 0)
				{
					tmpType = /^Nullable\(/.test(tmpType) ? 'Nullable(String)' : 'String';
				}
				return `${libDDL.quoteIdentifier(pName)} ${tmpType}`;
			}).join(', ');
		let tmpSelect = tmpNames.map((pName) => { return (tmpFloat.indexOf(pName) >= 0) ? `toFloat64(${libDDL.quoteIdentifier(pName)})` : libDDL.quoteIdentifier(pName); }).join(', ');
		let tmpQualified = libDDL.qualified(this.Database, pTable);
		return (
			{
				Query: `INSERT INTO ${tmpQualified} (${tmpNames.map(libDDL.quoteIdentifier).join(', ')}) SELECT ${tmpSelect} FROM input('${tmpStructure.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}') FORMAT JSONEachRow`,
				Float: tmpFloat
			});
	}

	/**
	 * The chunked inserts of one phase.
	 *
	 * @param {string} pTable
	 * @param {Map<string, string>} pColumns - the table's columns
	 * @param {Array<Record<string, any>>} pRows
	 * @param {string} pTokenBase - '<Entity>:<FlushID>:<Target>:<Phase>'
	 * @param {string} pWhat
	 * @param {Record<string, any>} pResult - Inserts counter
	 * @return {Array<(fNext: (pError?: Error) => void) => void>}
	 */
	_insertTasks(pTable, pColumns, pRows, pTokenBase, pWhat, pResult)
	{
		let tmpChunk = Math.max(1, this.options.Materializer.FlushRows || 50000);
		let tmpTasks = [];
		let tmpQualified = libDDL.qualified(this.Database, pTable);
		let tmpExact = this._insertQuery(pTable, pColumns);
		let tmpRows = pRows;
		if (tmpExact)
		{
			// Float64 values travel as their shortest round-trip text (String(v)), converted exactly server side.
			tmpRows = pRows.map(
				(pRow) =>
				{
					let tmpRow = Object.assign({}, pRow);
					tmpExact.Float.forEach((pName) => { if (typeof(tmpRow[pName]) === 'number') { tmpRow[pName] = String(tmpRow[pName]); } });
					return tmpRow;
				});
		}
		for (let i = 0, tmpIndex = 0; i < tmpRows.length; i += tmpChunk, tmpIndex++)
		{
			let tmpSlice = tmpRows.slice(i, i + tmpChunk);
			let tmpToken = `${pTokenBase}${tmpIndex}`;
			let tmpInsertOptions = { Token: tmpToken, Retries: this._StoreOptions ? this._StoreOptions.InsertRetries : 2 };
			if (tmpExact)
			{
				tmpInsertOptions.Query = tmpExact.Query;
				tmpInsertOptions.Settings = { precise_float_parsing: 1 };
			}
			tmpTasks.push(
				(fNext) =>
				{
					this._Counters.Statements++;
					this._Counters.Inserts++;
					this.Client.insert(tmpQualified, tmpSlice, tmpInsertOptions,
						(pError) =>
						{
							this.noteOutcome(pError || null);
							if (pError)
							{
								pError.Phase = pTokenBase.slice(-1);
								return fNext(this._failed(pError, pWhat, pTable));
							}
							this._Counters.InsertedRows += tmpSlice.length;
							pResult.Inserts++;
							return fNext();
						});
				});
		}
		return tmpTasks;
	}

	/**
	 * The flush protocol for one target (§58.6): keymap intents (token <pToken>:K<i>), then ONE mirror
	 * INSERT per chunk carrying rows AND tombstones (<pToken>:M<i>), then keymap retirements
	 * (<pToken>:R<i>); each INSERT retried up to InsertRetries times with its own token.
	 *
	 * @param {string} pEntity
	 * @param {{ Rows: Array<Record<string, any>>, Tombstones: Array<Record<string, any>>, KeyIntents: Array<Record<string, any>>, KeyRetires: Array<Record<string, any>> }} pBatch
	 * @param {string} pToken - '<Entity>:<FlushID>:<Target>'
	 * @param {string} pTarget
	 * @param {(pError?: Error, pResult?: { Rows: number, Tombstones: number, KeyIntents: number, KeyRetires: number, Inserts: number }) => void} fCallback
	 */
	writeBatch(pEntity, pBatch, pToken, pTarget, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		if ((typeof(pToken) !== 'string') || (pToken.length < 1) || (pToken.length > 256))
		{
			return fCallback(storeError('A flush token is a non-empty string.', null));
		}
		let tmpTarget = this._target(pEntity, pTarget);
		if (tmpTarget.Error)
		{
			return fCallback(tmpTarget.Error);
		}
		this._existingColumns(tmpTarget.Mirror,
			(pMirrorError, pMirrorColumns) =>
			{
				if (pMirrorError)
				{
					return fCallback(pMirrorError);
				}
				this._existingColumns(tmpTarget.Keymap,
					(pKeymapError, pKeymapColumns) =>
					{
						if (pKeymapError)
						{
							return fCallback(pKeymapError);
						}
						let tmpRows = this._batchRows(tmpTarget.Spec, pBatch, pMirrorColumns, pKeymapColumns);
						if (tmpRows.Error)
						{
							return fCallback(storeError(`An invalid flush batch for ${pEntity}: ${tmpRows.Error}.`, null));
						}
						let tmpResult = { Rows: tmpRows.Rows, Tombstones: tmpRows.Tombstones, KeyIntents: tmpRows.Intents.length, KeyRetires: tmpRows.Retires.length, Inserts: 0 };
						let tmpTasks = []
							.concat(this._insertTasks(tmpTarget.Keymap, pKeymapColumns, tmpRows.Intents, `${pToken}:K`, `keymap intents of ${pEntity}`, tmpResult))
							.concat(this._insertTasks(tmpTarget.Mirror, pMirrorColumns, tmpRows.Mirror, `${pToken}:M`, `mirror insert of ${pEntity}`, tmpResult))
							.concat(this._insertTasks(tmpTarget.Keymap, pKeymapColumns, tmpRows.Retires, `${pToken}:R`, `keymap retirements of ${pEntity}`, tmpResult));
						this._series(tmpTasks,
							(pError) =>
							{
								if (pError)
								{
									pError.Result = tmpResult;
									return fCallback(pError);
								}
								return fCallback(null, tmpResult);
							});
					});
			});
	}

	/**
	 * CREATE <E>__shadow_<b> and its keymap from the spec (leftovers of the same name dropped first).
	 *
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {Record<string, any>} pSpec
	 * @param {(pError?: Error) => void} fCallback
	 */
	beginShadow(pEntity, pBuildID, pSpec, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpStatements;
		try
		{
			tmpStatements =
				[
					libDDL.dropTableDDL(this.Database, libDDL.mirrorTableName(pEntity, pBuildID)),
					libDDL.dropTableDDL(this.Database, libDDL.keymapTableName(pEntity, pBuildID)),
					libDDL.mirrorDDL(this.Database, pSpec, pBuildID),
					libDDL.keymapDDL(this.Database, pSpec, pBuildID)
				];
		}
		catch (pDDLError)
		{
			return fCallback(storeError(`The shadow of ${pEntity} cannot be rendered: ${pDDLError.message}`, null));
		}
		this._forgetTables(pEntity);
		delete this._SwapProgress[`${pEntity}:${pBuildID}`];
		this._series(tmpStatements.map((pSQL) => { return (fNext) => { this._command(pSQL, null, `shadow DDL of ${pEntity}`, fNext); }; }),
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				this._registerSpec(pEntity, pSpec, pBuildID);
				this._tableUUIDs([ libDDL.mirrorTableName(pEntity, pBuildID), libDDL.keymapTableName(pEntity, pBuildID) ],
					(pUUIDError, pUUIDs) =>
					{
						if (!pUUIDError && pUUIDs)
						{
							this._ShadowUUIDs[`${pEntity}:${pBuildID}`] = { Mirror: pUUIDs[libDDL.mirrorTableName(pEntity, pBuildID)] || null, Keymap: pUUIDs[libDDL.keymapTableName(pEntity, pBuildID)] || null };
						}
						return fCallback(null);
					});
			});
	}

	/**
	 * The UUIDs of tables of the database ({ name: uuid }; a missing table is absent).
	 *
	 * @param {Array<string>} pTables
	 * @param {(pError?: Error, pUUIDs?: Record<string, string>) => void} fCallback
	 */
	_tableUUIDs(pTables, fCallback)
	{
		this._query('SELECT name, toString(uuid) AS uuid FROM system.tables WHERE database = {db:String} AND name IN {names:Array(String)}', { db: this.Database, names: pTables }, 'table UUIDs',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpUUIDs = {};
				pRows.forEach((pRow) => { tmpUUIDs[pRow.name] = pRow.uuid; });
				return fCallback(null, tmpUUIDs);
			});
	}

	/**
	 * Swap a finished shadow in (§59.1–§59.2): first enable → RENAME shadow → live (mirror, then
	 * keymap; an existing live table is EXCHANGEd instead); otherwise EXCHANGE TABLES (mirror, then
	 * keymap).  A retry after a half-done swap only completes the keymap half.
	 *
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {boolean} pFirstEnable
	 * @param {(pError?: Error) => void} fCallback
	 */
	swapShadow(pEntity, pBuildID, pFirstEnable, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpNames;
		try
		{
			tmpNames =
				{
					Mirror: libDDL.mirrorTableName(pEntity),
					MirrorShadow: libDDL.mirrorTableName(pEntity, pBuildID),
					Keymap: libDDL.keymapTableName(pEntity),
					KeymapShadow: libDDL.keymapTableName(pEntity, pBuildID)
				};
		}
		catch (pNameError)
		{
			return fCallback(storeError('An invalid entity name or BuildID for a swap.', null));
		}
		let tmpProgressKey = `${pEntity}:${pBuildID}`;
		let fSwap = (pLive, pShadow, fNext) =>
		{
			if (!pFirstEnable)
			{
				return this._command(libDDL.exchangeDDL(this.Database, pLive, pShadow), null, `EXCHANGE of ${pEntity}`, fNext);
			}
			this.Client.command(libDDL.renameDDL(this.Database, pShadow, pLive), null, null,
				(pRenameError) =>
				{
					this._Counters.Statements++;
					if (pRenameError && (pRenameError.Code === TABLE_ALREADY_EXISTS))
					{
						// A live table appeared (a leftover): swap instead; dropShadow removes the old one.
						return this._command(libDDL.exchangeDDL(this.Database, pLive, pShadow), null, `EXCHANGE of ${pEntity}`, fNext);
					}
					return fNext(pRenameError ? this._failed(pRenameError, `RENAME of ${pEntity}`) : null);
				});
		};
		this._forgetTables(pEntity);
		let tmpShadowUUIDs = this._ShadowUUIDs[tmpProgressKey] || null;
		// A half already swapped (a retry after an error the client saw — even one raised after the
		// statement landed): the live name now holds the shadow table's UUID.
		let fLanded = (pLive, pShadowUUID, fNext) =>
		{
			if (!pShadowUUID)
			{
				return fNext(null, false);
			}
			this._tableUUIDs([ pLive ], (pError, pUUIDs) => { return fNext(null, !pError && !!pUUIDs && (pUUIDs[pLive] === pShadowUUID)); });
		};
		this._series(
			[
				(fNext) =>
				{
					if (this._SwapProgress[tmpProgressKey] === 'Mirror')
					{
						return fNext();
					}
					fLanded(tmpNames.Mirror, tmpShadowUUIDs ? tmpShadowUUIDs.Mirror : null,
						(pCheckError, pLanded) =>
						{
							if (pLanded)
							{
								this._SwapProgress[tmpProgressKey] = 'Mirror';
								return fNext();
							}
							fSwap(tmpNames.Mirror, tmpNames.MirrorShadow,
								(pError) =>
								{
									if (!pError)
									{
										this._SwapProgress[tmpProgressKey] = 'Mirror';
									}
									return fNext(pError);
								});
						});
				},
				(fNext) =>
				{
					fLanded(tmpNames.Keymap, tmpShadowUUIDs ? tmpShadowUUIDs.Keymap : null,
						(pCheckError, pLanded) =>
						{
							if (pLanded)
							{
								return fNext();
							}
							fSwap(tmpNames.Keymap, tmpNames.KeymapShadow, fNext);
						});
				}
			],
			(pError) =>
			{
				this._forgetTables(pEntity);
				if (pError)
				{
					return fCallback(pError);
				}
				delete this._SwapProgress[tmpProgressKey];
				delete this._ShadowUUIDs[tmpProgressKey];
				let tmpRegistered = this._Specs[pEntity];
				if (tmpRegistered && libFacetUtil.hasOwn(tmpRegistered.Shadows, pBuildID))
				{
					tmpRegistered.Live = tmpRegistered.Shadows[pBuildID];
				}
				return fCallback(null);
			});
	}

	/**
	 * DROP both shadow tables (after a swap they hold the old data).
	 *
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {(pError?: Error) => void} fCallback
	 */
	dropShadow(pEntity, pBuildID, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpStatements;
		try
		{
			tmpStatements =
				[
					libDDL.dropTableDDL(this.Database, libDDL.mirrorTableName(pEntity, pBuildID)),
					libDDL.dropTableDDL(this.Database, libDDL.keymapTableName(pEntity, pBuildID))
				];
		}
		catch (pNameError)
		{
			return fCallback(storeError('An invalid entity name or BuildID for a shadow drop.', null));
		}
		this._forgetTables(pEntity);
		this._series(tmpStatements.map((pSQL) => { return (fNext) => { this._command(pSQL, null, `shadow drop of ${pEntity}`, fNext); }; }),
			(pError) =>
			{
				if (!pError && this._Specs[pEntity])
				{
					delete this._Specs[pEntity].Shadows[pBuildID];
				}
				delete this._SwapProgress[`${pEntity}:${pBuildID}`];
				delete this._ShadowUUIDs[`${pEntity}:${pBuildID}`];
				return fCallback(pError || null);
			});
	}

	// ---- state ------------------------------------------------------------------------------

	/**
	 * The latest state row of an entity (§56.2), or null.  JSON columns parsed; DateTime columns as
	 * epoch milliseconds; CleanShutdown 0 / 1; Version = the row's _Version.
	 *
	 * @param {string} pEntity
	 * @param {(pError?: Error, pState?: Record<string, any>|null) => void} fCallback
	 */
	readState(pEntity, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._query(`SELECT * FROM ${libDDL.qualified(this.Database, libDDL.STATE_TABLE)} FINAL WHERE \`Store\` = {s:String} AND \`Entity\` = {e:String}`,
			{ s: STORE_NAME, e: String(pEntity) }, `state read of ${pEntity}`,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pRows[0])
				{
					delete this._States[pEntity];
					return fCallback(null, null);
				}
				let tmpRow = pRows[0];
				let tmpState =
					{
						Store: tmpRow.Store,
						Entity: tmpRow.Entity,
						State: tmpRow.State,
						Epoch: Number(tmpRow.Epoch) || 0,
						SpecHash: tmpRow.SpecHash || '',
						AppliedSeq: parseJSON(tmpRow.AppliedSeq, {}),
						CleanShutdown: (Number(tmpRow.CleanShutdown) === 1) ? 1 : 0,
						LossyColumns: parseJSON(tmpRow.LossyColumns, {}),
						FillingColumns: parseJSON(tmpRow.FillingColumns, []),
						SweepWatermark: ((typeof(tmpRow.SweepWatermark) === 'string') && (tmpRow.SweepWatermark.charAt(0) === '{')) ? parseJSON(tmpRow.SweepWatermark, tmpRow.SweepWatermark) : tmpRow.SweepWatermark,
						ScrubCursor: Number.isSafeInteger(tmpRow.ScrubCursor) ? tmpRow.ScrubCursor : null,
						Detail: parseJSON(tmpRow.Detail, {}),
						Version: tmpRow._Version,
						UpdatedAt: stateDateMS(tmpRow._UpdatedAt)
					};
				STATE_DATE_COLUMNS.forEach((pColumn) => { tmpState[pColumn] = stateDateMS(tmpRow[pColumn]); });
				// The merge cache never goes backwards: a read that finishes after a newer writeState (its row
				// was read before that write landed) keeps the newer state for the next partial write.
				let tmpCached = this._States[pEntity];
				if (!tmpCached || !Number.isSafeInteger(tmpCached.Version) || !Number.isSafeInteger(tmpState.Version) || (tmpState.Version >= tmpCached.Version))
				{
					this._States[pEntity] = tmpState;
				}
				if (Number.isSafeInteger(tmpState.Version))
				{
					this._StateVersionFloor = Math.max(this._StateVersionFloor, tmpState.Version);
				}
				return fCallback(null, Object.assign({}, tmpState));
			});
	}

	/**
	 * Write the state row (a full row: pState merged over the last state this store read or wrote for
	 * the entity, so a partial update keeps the other fields).  Version: pState.Version (the caller's
	 * WriterClock), else max(now µs, the highest version seen + 1).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pState
	 * @param {(pError?: Error, pWritten?: Record<string, any>) => void} fCallback
	 */
	writeState(pEntity, pState, fCallback, pCallOptions)
	{
		return this.writeStates([ { Entity: pEntity, State: pState } ], (pError, pWritten) => { return fCallback(pError || null, pError ? undefined : pWritten[0]); }, pCallOptions);
	}

	/**
	 * One state row (writeState's merge), not written.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pState
	 * @return {{ Row: Record<string, any>, Merged: Record<string, any> }}
	 */
	_stateRow(pEntity, pState)
	{
		let tmpPatch = libFacetUtil.isPlainObject(pState) ? pState : {};
		let tmpMerged = Object.assign({}, STATE_DEFAULTS, this._States[pEntity] || {}, tmpPatch);
		let tmpVersion = Number.isSafeInteger(tmpPatch.Version) ? tmpPatch.Version : (Number.isSafeInteger(tmpPatch._Version) ? tmpPatch._Version : null);
		if (tmpVersion === null)
		{
			tmpVersion = Math.max(Date.now() * 1000, this._StateVersionFloor + 1);
		}
		this._StateVersionFloor = Math.max(this._StateVersionFloor, tmpVersion);
		let tmpRow =
			{
				Store: STORE_NAME,
				Entity: String(pEntity),
				State: String(tmpMerged.State || 'Absent'),
				Epoch: (Number.isInteger(tmpMerged.Epoch) && (tmpMerged.Epoch >= 0)) ? tmpMerged.Epoch : 0,
				SpecHash: String(tmpMerged.SpecHash || ''),
				CleanShutdown: ((tmpMerged.CleanShutdown === 1) || (tmpMerged.CleanShutdown === true)) ? 1 : 0,
				SweepWatermark: ((tmpMerged.SweepWatermark === null) || (typeof(tmpMerged.SweepWatermark) === 'undefined')) ? null
					: ((typeof(tmpMerged.SweepWatermark) === 'string') ? tmpMerged.SweepWatermark : JSON.stringify(tmpMerged.SweepWatermark)),
				ScrubCursor: Number.isSafeInteger(tmpMerged.ScrubCursor) ? tmpMerged.ScrubCursor : null,
				_Version: tmpVersion
			};
		STATE_JSON_COLUMNS.forEach(
			(pColumn) =>
			{
				let tmpValue = tmpMerged[pColumn];
				tmpRow[pColumn] = (typeof(tmpValue) === 'string') ? tmpValue : JSON.stringify((tmpValue === null) || (typeof(tmpValue) === 'undefined') ? STATE_DEFAULTS[pColumn] : tmpValue);
			});
		STATE_DATE_COLUMNS.forEach((pColumn) => { tmpRow[pColumn] = stateDateText(tmpMerged[pColumn]); });
		return { Row: tmpRow, Merged: tmpMerged };
	}

	/**
	 * Write the state rows of several entities in ONE insert (the shared _rfs_entity_state table gets
	 * one part per write, not one per entity): each row is writeState's merge.  pCallOptions.TimeoutMS
	 * bounds the insert and turns its retries off (a shutdown's last write).
	 *
	 * @param {Array<{ Entity: string, State: Record<string, any> }>} pEntries
	 * @param {(pError?: Error, pWritten?: Array<Record<string, any>>) => void} fCallback
	 * @param {{ TimeoutMS?: number }} [pCallOptions]
	 */
	writeStates(pEntries, fCallback, pCallOptions)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpEntries = (Array.isArray(pEntries) ? pEntries : []).filter((pEntry) => { return pEntry && (typeof(pEntry.Entity) === 'string'); });
		if (tmpEntries.length < 1)
		{
			return fCallback(null, []);
		}
		let tmpBuilt = tmpEntries.map((pEntry) => { return Object.assign({ Entity: pEntry.Entity }, this._stateRow(pEntry.Entity, pEntry.State)); });
		let tmpRows = tmpBuilt.map((pBuilt) => { return pBuilt.Row; });
		let tmpToken = `state:${tmpRows.map((pRow) => { return `${pRow.Entity}@${pRow._Version}`; }).join(',')}`;
		if (tmpToken.length > 200)
		{
			tmpToken = `state:${libCrypto.createHash('sha256').update(tmpToken, 'utf8').digest('hex').slice(0, 32)}`;
		}
		let tmpOptions = { Token: tmpToken, Retries: this._StoreOptions ? this._StoreOptions.InsertRetries : 2 };
		if (pCallOptions && Number.isFinite(pCallOptions.TimeoutMS) && (pCallOptions.TimeoutMS > 0))
		{
			tmpOptions.TimeoutMS = pCallOptions.TimeoutMS;
			tmpOptions.Retries = 0;
		}
		this._Counters.Statements++;
		this._Counters.Inserts++;
		this.Client.insert(libDDL.qualified(this.Database, libDDL.STATE_TABLE), tmpRows, tmpOptions,
			(pError) =>
			{
				this.noteOutcome(pError || null);
				if (pError)
				{
					return fCallback(this._failed(pError, `state write of ${tmpBuilt.map((pBuilt) => { return pBuilt.Entity; }).join(', ')}`));
				}
				let tmpWritten = tmpBuilt.map(
					(pBuilt) =>
					{
						let tmpRow = pBuilt.Row;
						let tmpState = Object.assign({}, pBuilt.Merged, { Store: STORE_NAME, Entity: String(pBuilt.Entity), Version: tmpRow._Version, CleanShutdown: tmpRow.CleanShutdown });
						STATE_DATE_COLUMNS.forEach((pColumn) => { tmpState[pColumn] = stateDateMS(tmpRow[pColumn]); });
						delete tmpState._Version;
						this._States[pBuilt.Entity] = tmpState;
						return Object.assign({}, tmpState);
					});
				return fCallback(null, tmpWritten);
			});
	}

	// ---- reconcile reads --------------------------------------------------------------------

	/**
	 * { '<bucket>': { Count, IDSum } } over the keymap's live DISTINCT IDs, bucket = intDiv(ID,
	 * LeafRange) (§60.2; intDiv truncates toward zero like SQLite and PostgreSQL integer division).
	 *
	 * @param {string} pEntity
	 * @param {number} pLeafRange
	 * @param {string} pTarget
	 * @param {(pError?: Error, pBuckets?: Record<string, { Count: number, IDSum: number|string }>) => void} fCallback
	 */
	bucketChecksums(pEntity, pLeafRange, pTarget, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		if (!Number.isSafeInteger(pLeafRange) || (pLeafRange < 1))
		{
			return fCallback(storeError('LeafRange is a positive integer.', null));
		}
		let tmpTarget = this._target(pEntity, pTarget || libRetoldFacetingStoreBase.TARGET_LIVE);
		if (tmpTarget.Error)
		{
			return fCallback(tmpTarget.Error);
		}
		let tmpIdentity = libDDL.quoteIdentifier(tmpTarget.Spec.Identity);
		// The distinct live IDs by an in-order GROUP BY on the sort-key prefix (FINAL streams in key order;
		// optimize_aggregation_in_order keeps the memory flat) instead of a hash DISTINCT over every ID.
		let tmpSQL = `SELECT intDiv(ID, {fLeaf:Int64}) AS Bucket, count() AS Count, sum(ID) AS IDSum FROM (SELECT ${tmpIdentity} AS ID FROM ${libDDL.qualified(this.Database, tmpTarget.Keymap)} FINAL WHERE \`_IsDeleted\` = 0 GROUP BY ${tmpIdentity}) GROUP BY Bucket ORDER BY Bucket`;
		this._query(tmpSQL, { fLeaf: pLeafRange }, `bucket checksums of ${pEntity}`,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpBuckets = {};
				pRows.forEach((pRow) => { tmpBuckets[String(pRow.Bucket)] = { Count: Number(pRow.Count), IDSum: pRow.IDSum }; });
				return fCallback(null, tmpBuckets);
			}, tmpTarget.Keymap, { optimize_aggregation_in_order: 1 });
	}

	/**
	 * Mirror FINAL, _IsDeleted = 0 rows of (AfterID, ToID] in identity order: the spec's columns (or
	 * pColumns: spec columns and _Version), store values.
	 *
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {Array<string>|null} pColumns
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	readLeafRows(pEntity, pAfterID, pToID, pColumns, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpTarget = this._target(pEntity, libRetoldFacetingStoreBase.TARGET_LIVE);
		if (tmpTarget.Error)
		{
			return fCallback(tmpTarget.Error);
		}
		if (!this._validBound(pAfterID) || !this._validBound(pToID))
		{
			return fCallback(storeError('A leaf range bound is a safe integer or null.', null));
		}
		let tmpSpecNames = tmpTarget.Spec.Columns.map((pColumn) => { return pColumn.Column; });
		let tmpWanted = Array.isArray(pColumns) ? pColumns.filter((pName) => { return (tmpSpecNames.indexOf(pName) >= 0) || (pName === '_Version'); }) : tmpSpecNames;
		this._existingColumns(tmpTarget.Mirror,
			(pColumnsError, pTableColumns) =>
			{
				if (pColumnsError)
				{
					return fCallback(pColumnsError);
				}
				let tmpNames = tmpWanted.filter((pName) => { return pTableColumns.has(pName); });
				if (tmpNames.indexOf(tmpTarget.Spec.Identity) < 0)
				{
					tmpNames.unshift(tmpTarget.Spec.Identity);
				}
				let tmpParams = {};
				let tmpSQL = `SELECT ${tmpNames.map(libDDL.quoteIdentifier).join(', ')} FROM ${libDDL.qualified(this.Database, tmpTarget.Mirror)} FINAL `
					+ `WHERE \`_IsDeleted\` = 0${this._rangePredicate(tmpTarget.Spec.Identity, pAfterID, pToID, tmpParams)} ORDER BY ${libDDL.quoteIdentifier(tmpTarget.Spec.Identity)}`;
				this._query(tmpSQL, tmpParams, `leaf read of ${pEntity}`, fCallback, tmpTarget.Mirror);
			});
	}

	// ---- statements and the query side --------------------------------------------------------

	/**
	 * A read: the §57.3 read settings, then Stores.ClickHouse.QuerySettings, then pSettings, then
	 * readonly = 2 (forced last: a read never writes or runs DDL, whatever the credential could do) and
	 * the ReadLimits; rows normalized (§57.2).  pTypes is informational (the SQL carries {name:Type}).
	 *
	 * pCallOptions.Request (the engine's request-path statements) runs on the read client (its own socket
	 * pool and, when configured, the reader credential), at most MaxConcurrentReads at once — beyond
	 * that the call fails at once with .Busy (the facet answers Live; never queued); pCallOptions.TimeoutMS
	 * bounds the call from the moment it is issued.  Every outcome feeds the store-wide health.
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, string>|null} pTypes
	 * @param {Record<string, any>|null} pSettings
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>, pMeta?: Array<Record<string, any>>) => void} fCallback
	 * @param {{ Request?: boolean, TimeoutMS?: number }} [pCallOptions]
	 */
	queryRows(pSQL, pParams, pTypes, pSettings, fCallback, pCallOptions)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpCallOptions = libFacetUtil.isPlainObject(pCallOptions) ? pCallOptions : {};
		let tmpRequest = (tmpCallOptions.Request === true);
		let tmpLimits = (this._StoreOptions && this._StoreOptions.ReadLimits) ? this._StoreOptions.ReadLimits : {};
		let tmpForced = { readonly: 2 };
		if (tmpLimits.MaxMemoryBytes > 0)
		{
			tmpForced.max_memory_usage = tmpLimits.MaxMemoryBytes;
		}
		if (tmpLimits.MaxRowsToRead > 0)
		{
			tmpForced.max_rows_to_read = tmpLimits.MaxRowsToRead;
		}
		if (tmpLimits.MaxBytesToRead > 0)
		{
			tmpForced.max_bytes_to_read = tmpLimits.MaxBytesToRead;
		}
		let tmpSettings = Object.assign({}, READ_SETTINGS, this._StoreOptions ? this._StoreOptions.QuerySettings : {}, pSettings || {}, tmpForced);
		let tmpClient = (tmpRequest && this.ReadClient) ? this.ReadClient : this.Client;
		if (tmpRequest)
		{
			let tmpMax = this._StoreOptions ? this._StoreOptions.MaxConcurrentReads : 32;
			if (this._ActiveReads >= tmpMax)
			{
				this._Counters.Busy++;
				let tmpBusy = storeError('The ClickHouse store is at MaxConcurrentReads; answering Live.', null);
				tmpBusy.Busy = true;
				return setImmediate(() => { return fCallback(tmpBusy); });
			}
			this._ActiveReads++;
		}
		let tmpBudget = (Number.isFinite(tmpCallOptions.TimeoutMS) && (tmpCallOptions.TimeoutMS > 0)) ? tmpCallOptions.TimeoutMS : (this._StoreOptions ? this._StoreOptions.TimeoutMS : 20000);
		this._Counters.Statements++;
		this._Counters.Queries++;
		tmpClient.query(pSQL, pParams || null, tmpSettings, { TimeoutMS: tmpBudget },
			(pError, pRows, pMeta) =>
			{
				if (tmpRequest)
				{
					this._ActiveReads = Math.max(0, this._ActiveReads - 1);
				}
				this.noteOutcome(pError || null, tmpBudget);
				if (pError)
				{
					this._Counters.Errors++;
					if (WIPE_ERROR_CODES.indexOf(pError.Code) >= 0)
					{
						pError.Wipe = true;
					}
					pError.BudgetMS = tmpBudget;
					this._Status.LastError = pError.message;
					return fCallback(pError);
				}
				return fCallback(null, pRows || [], pMeta || []);
			});
	}

	/**
	 * A DDL / admin statement (rebuild, wipe tests).
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {Record<string, any>|null} pSettings
	 * @param {(pError?: Error) => void} fCallback
	 */
	command(pSQL, pParams, pSettings, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._Counters.Statements++;
		this._TableColumns = new Map();
		this.Client.command(pSQL, pParams || null, pSettings || null,
			(pError) =>
			{
				return fCallback(pError ? this._failed(pError, 'command') : null);
			});
	}

	/**
	 * DROP DATABASE IF EXISTS <db> SYNC — tests and the wipe scenario only.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	dropDatabase(fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._TableColumns = new Map();
		this._States = {};
		this._SwapProgress = {};
		this._command(`DROP DATABASE IF EXISTS ${libDDL.quoteIdentifier(this.Database)} SYNC`, null, 'DROP DATABASE', fCallback);
	}

	/**
	 * @return {{ Folds: Array<string>, Predicates: string, Paths: string, CountModes: Array<string>, TimeZones: Array<string> }}
	 */
	capabilities()
	{
		return { Folds: FOLDS.slice(), Predicates: 'Portable', Paths: 'Subquery', CountModes: [ 'Rows', 'PivotDistinct', 'KeyDistinct' ], TimeZones: [ 'UTC' ] };
	}

	/**
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null, Database: string|null, Version: string|null, LastError: string|null, ConnectedAt: number|null }}
	 */
	status()
	{
		return (
			{
				Configured: this._Status.Configured,
				Available: this._Status.Available,
				Reason: this._Status.Reason,
				Database: this._Status.Database,
				Version: this._Status.Version,
				LastError: this._Status.LastError,
				ConnectedAt: this._Status.ConnectedAt
			});
	}

	/**
	 * Counters for Describe / status (statements, inserts, rows, errors).
	 *
	 * @return {Record<string, number>}
	 */
	stats()
	{
		return Object.assign({}, this._Counters, { ActiveReads: this._ActiveReads });
	}

	/**
	 * The most active parts of any table of the database (the insert-rate back-pressure signal), no
	 * ping first; 0 when unknown.
	 *
	 * @param {(pError?: Error, pParts?: number) => void} fCallback
	 */
	activeParts(fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._query('SELECT max(Parts) AS P FROM (SELECT count() AS Parts FROM system.parts WHERE database = {db:String} AND active GROUP BY table)', { db: this.Database }, 'parts',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, Number((pRows[0] || {}).P) || 0);
			});
	}

	/**
	 * The approximate row count of an entity's live keymap (system.parts rows of its active parts: an
	 * upper bound — superseded and retired rows count until merged), for pacing; null when unknown.
	 *
	 * @param {string} pEntity
	 * @param {(pError?: Error, pRows?: number|null) => void} fCallback
	 */
	approximateRows(pEntity, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		let tmpTable;
		try
		{
			tmpTable = libDDL.mirrorTableName(pEntity);
		}
		catch (pNameError)
		{
			return fCallback(null, null);
		}
		this._query('SELECT sum(rows) AS R FROM system.parts WHERE database = {db:String} AND table = {t:String} AND active', { db: this.Database, t: tmpTable }, 'row estimate',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpRows = Number((pRows[0] || {}).R);
				return fCallback(null, Number.isFinite(tmpRows) ? tmpRows : null);
			});
	}

	/**
	 * Does the database exist, and which of these entities' live mirror and keymap exist (a wipe is
	 * confirmed before anything is rebuilt)?
	 *
	 * @param {Array<string>} pEntities
	 * @param {(pError?: Error, pResult?: { Database: boolean, Entities: Record<string, boolean> }) => void} fCallback
	 */
	tablesExist(pEntities, fCallback)
	{
		if (!this._ready(fCallback))
		{
			return;
		}
		this._query('SELECT name FROM system.databases WHERE name = {db:String}', { db: this.Database }, 'database lookup',
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpResult = { Database: (pRows.length > 0), Entities: {} };
				if (!tmpResult.Database)
				{
					(pEntities || []).forEach((pEntity) => { tmpResult.Entities[pEntity] = false; });
					return fCallback(null, tmpResult);
				}
				this._query('SELECT name FROM system.tables WHERE database = {db:String}', { db: this.Database }, 'table lookup',
					(pTablesError, pTables) =>
					{
						if (pTablesError)
						{
							return fCallback(pTablesError);
						}
						let tmpNames = new Set(pTables.map((pRow) => { return pRow.name; }));
						(pEntities || []).forEach(
							(pEntity) =>
							{
								let tmpBoth = false;
								try
								{
									tmpBoth = tmpNames.has(libDDL.mirrorTableName(pEntity)) && tmpNames.has(libDDL.keymapTableName(pEntity));
								}
								catch (pNameError)
								{
									tmpBoth = false;
								}
								tmpResult.Entities[pEntity] = tmpBoth;
							});
						return fCallback(null, tmpResult);
					});
			});
	}
}

module.exports = RetoldFacetingStoreClickHouse;
module.exports.serviceType = 'RetoldFacetingStoreClickHouse';
module.exports.STORE_NAME = STORE_NAME;
module.exports.WIPE_ERROR_CODES = WIPE_ERROR_CODES;
module.exports.READ_SETTINGS = READ_SETTINGS;
module.exports.isWipeError = isWipeError;
