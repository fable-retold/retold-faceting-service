/**
 * ClickHouse-Client — a small dependency-free client over ClickHouse's HTTP interface.
 *
 * Lifted from Sluice's Clickhouse-Client (modules/private/sluice/source/server/importers/nntp/
 * Clickhouse-Client.js: HTTP interface, values as query parameters, JSONEachRow inserts, ping) and
 * extended for the faceting store (design 04 §5.1): callbacks instead of promises, a settings
 * argument on every call, 64-bit integer normalization driven by the result meta,
 * insert_deduplication_token with same-token retries, typed error objects whose messages never carry
 * a bound value, keep-alive connections, a test-only fault injector.
 *
 * Values NEVER enter SQL text: every value travels as a query parameter `param_<name>` and the SQL
 * references it as `{name:Type}`; formatParam() renders scalars in ClickHouse's Escaped text format
 * (backslashes doubled, TAB / LF / CR / NUL / BS / FF as escape sequences: a {p:String} value is parsed
 * as escaped text) and arrays as literals (strings quoted, `\` and `'` backslash-escaped).  A parameter
 * longer than MAX_PARAM_TEXT is refused before anything is sent.  Credentials travel in the
 * X-ClickHouse-User / X-ClickHouse-Key headers, never in the URL or a log line; parameter VALUES travel in
 * the request URI (a proxy in front of ClickHouse must not log query strings).
 *
 * Every call is bounded by TimeoutMS (or a shorter per-call TimeoutMS) from the moment it is issued —
 * time spent queued for a socket included — and a timed-out call is destroyed (.TimedOut).  Errors are
 * classified: .Retryable (network, time-out, a 5xx with a non-deterministic code), .Deterministic (4xx,
 * parse / parameter errors, client-side refusals), .Limit (a per-query limit), .TimedOut.
 *
 * A plain class (no fable, nothing required outside node's http / https), so it can move unchanged to
 * the planned meadow-connection-clickhouse module (internal-contracts §53.3, §68 #1).
 *
 *   let tmpClient = new ClickHouseClient({ URL, User, Password, Database, TimeoutMS, PingTimeoutMS, Settings, KeepAlive, RetryDelayMS,
 *                                          MaxSockets, CA, Cert, Key, RejectUnauthorized });
 *   tmpClient.ping((pError, pUp) => …)
 *   tmpClient.query(pSQL, pParams, pSettings, [{ TimeoutMS }], (pError, pRows, pMeta) => …)
 *   tmpClient.command(pSQL, pParams, pSettings, [{ TimeoutMS }], (pError) => …)
 *   tmpClient.insert(pQualifiedTable, pRows, { Token, Settings, Retries, Query, TimeoutMS }, (pError, pCount) => …)
 *   tmpClient.formatParam(pValue) → string
 *   tmpClient.setFaultInjector(fInjector | null)        // tests only (internal-contracts §57.4)
 *   tmpClient.stats() → { Requests, Retries, Errors }
 *   tmpClient.close()                                    // drop keep-alive sockets (shutdown)
 *
 * Database: null (or '') sends no `database=` parameter (the user's default database); the store
 * passes null and qualifies every name, so a statement never depends on a database that may not
 * exist yet.
 *
 * Contract: internal-contracts §57.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libHttp = require('http');
const libHttps = require('https');

// Query-parameter and setting names (they become URL parameter names).
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTING_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

// A pre-quoted, database-qualified table name as ClickHouse-DDL.qualified builds it.
const QUALIFIED_TABLE_PATTERN = /^`[A-Za-z_][A-Za-z0-9_]{0,63}`\.`[A-Za-z_][A-Za-z0-9_]{0,127}`$/;

// Integer types whose JSON output we normalize from the meta (quoted when quote_64bit_integers = 1).
const WIDE_INTEGER_PATTERN = /^(?:Nullable\(|LowCardinality\()*(?:U?Int(?:64|128|256))\)*$/;
// Arrays of them (groupArray, …): normalized element by element.
const WIDE_INTEGER_ARRAY_PATTERN = /^Array\((?:Nullable\(|LowCardinality\()*(?:U?Int(?:64|128|256))\)*\)$/;

// Characters of a ClickHouse error message we keep.
const MAX_ERROR_TEXT = 400;

// ClickHouse error codes whose message text names only our own SQL / identifiers / limits (never a
// bound value or an inserted row): their detail is kept in the error message.  Every other code —
// parse and conversion errors (CANNOT_PARSE_*, BAD_QUERY_PARAMETER, TYPE_MISMATCH, …) can echo a
// parameter value or an inserted row — is reported by code and name only.
const DETAIL_SAFE_CODES = Object.freeze(
	[
		1, 10, 16, 36, 42, 43, 44, 46, 47, 48, 49, 57, 60, 62, 81, 82, 115, 159, 164, 179, 184, 202,
		209, 210, 215, 241, 252, 352, 394, 396, 456, 497, 516
	]);

// ClickHouse error codes that are deterministic (the same statement fails the same way again): a 5xx
// carrying one of them is not retryable (ClickHouse answers BAD_QUERY_PARAMETER, CANNOT_PARSE_*, … with
// a 500).  1000 is the HTTP layer's POCO_EXCEPTION ("Field value too long": a parameter over
// http_max_field_value_size).
const DETERMINISTIC_CODES = Object.freeze(
	[
		1, 6, 10, 16, 25, 26, 27, 36, 38, 41, 42, 43, 44, 46, 47, 48, 49, 53, 57, 60, 62, 69, 70, 72, 81, 82,
		115, 117, 130, 131, 164, 179, 184, 215, 321, 352, 396, 456, 457, 497, 516, 1000
	]);

// ClickHouse error codes of a statement that hit a per-query limit the caller set (rows, bytes, result
// size, memory): the caller's statement, not the store's health.
const LIMIT_CODES = Object.freeze([ 158, 241, 307, 396 ]);

// ClickHouse error codes of a server-side time-out (max_execution_time).
const TIMEOUT_CODES = Object.freeze([ 159, 160 ]);

// The longest parameter text (param_<name>, decoded) a statement may carry: ClickHouse's HTTP layer
// refuses a field over http_max_field_value_size (128 KiB by default; verified on 24.8 to fail just below
// 131072 bytes) with a 500 POCO_EXCEPTION.  Bigger values are refused before anything is sent.
const MAX_PARAM_TEXT = 100000;

// Statement kinds that may be re-sent once when a reused keep-alive socket was reset before any
// response (the server closed an idle connection): reads, pings and token-deduplicated inserts.
const IDEMPOTENT_KINDS = Object.freeze([ 'Ping', 'Query', 'Insert' ]);

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PING_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_DELAY_MS = 100;

class ClickHouseClient
{
	/**
	 * @param {{ URL?: string, User?: string, Password?: string, Database?: string|null, TimeoutMS?: number, PingTimeoutMS?: number, Settings?: Record<string, any>, KeepAlive?: boolean, RetryDelayMS?: number, MaxSockets?: number, CA?: string, Cert?: string, Key?: string, RejectUnauthorized?: boolean }} pOptions
	 */
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.URL = tmpOptions.URL || 'http://127.0.0.1:8123';
		this.User = tmpOptions.User || 'default';
		this.Password = tmpOptions.Password || '';
		this.Database = (Object.prototype.hasOwnProperty.call(tmpOptions, 'Database') && ((tmpOptions.Database === null) || (tmpOptions.Database === ''))) ? null : (tmpOptions.Database || 'default');
		this.TimeoutMS = (Number.isFinite(tmpOptions.TimeoutMS) && (tmpOptions.TimeoutMS > 0)) ? tmpOptions.TimeoutMS : DEFAULT_TIMEOUT_MS;
		this.PingTimeoutMS = (Number.isFinite(tmpOptions.PingTimeoutMS) && (tmpOptions.PingTimeoutMS > 0)) ? tmpOptions.PingTimeoutMS : DEFAULT_PING_TIMEOUT_MS;
		this.RetryDelayMS = (Number.isFinite(tmpOptions.RetryDelayMS) && (tmpOptions.RetryDelayMS >= 0)) ? tmpOptions.RetryDelayMS : DEFAULT_RETRY_DELAY_MS;
		this.Settings = Object.assign({}, tmpOptions.Settings || {});
		let tmpParsed = new URL(this.URL);
		if ((tmpParsed.protocol !== 'http:') && (tmpParsed.protocol !== 'https:'))
		{
			throw new Error('ClickHouseClient: the URL must use http:// or https://.');
		}
		if (tmpParsed.username || tmpParsed.password)
		{
			throw new Error('ClickHouseClient: credentials never go in the URL (use User / Password).');
		}
		if ((tmpParsed.pathname && (tmpParsed.pathname !== '/')) || tmpParsed.search)
		{
			throw new Error('ClickHouseClient: the URL is a server origin (no path or query).');
		}
		if ((this.Database !== null) && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(this.Database))
		{
			throw new Error('ClickHouseClient: an invalid database name.');
		}
		this._IsHttps = (tmpParsed.protocol === 'https:');
		this._Host = tmpParsed.hostname.replace(/^\[(.*)\]$/, '$1');
		this._Port = tmpParsed.port ? parseInt(tmpParsed.port, 10) : (this._IsHttps ? 443 : 80);
		// TLS (https only): a CA bundle to trust (PEM text), whether to reject an unverifiable certificate
		// (default true), and an optional client certificate / key (PEM text).
		this._TLS = {};
		if (this._IsHttps)
		{
			if (tmpOptions.CA)
			{
				this._TLS.ca = tmpOptions.CA;
			}
			if (tmpOptions.Cert)
			{
				this._TLS.cert = tmpOptions.Cert;
			}
			if (tmpOptions.Key)
			{
				this._TLS.key = tmpOptions.Key;
			}
			this._TLS.rejectUnauthorized = (tmpOptions.RejectUnauthorized !== false);
		}
		this.MaxSockets = (Number.isInteger(tmpOptions.MaxSockets) && (tmpOptions.MaxSockets > 0)) ? tmpOptions.MaxSockets : 16;
		this._KeepAlive = (tmpOptions.KeepAlive !== false);
		// Keep-alive (default on): free sockets are unref'd by node, so an idle client never holds the
		// process open; close() drops them.
		this._Agent = this._KeepAlive ? this._newAgent() : null;
		this._FaultInjector = null;
		this._Attempts = 0;
		this._InFlight = new Set();
		this._Stats = { Requests: 0, Retries: 0, Errors: 0 };
	}

	/**
	 * A keep-alive agent for this client (its own socket pool: MaxSockets).
	 *
	 * @return {any}
	 */
	_newAgent()
	{
		let tmpAgentLib = this._IsHttps ? libHttps : libHttp;
		return new tmpAgentLib.Agent(Object.assign({ keepAlive: true, maxSockets: this.MaxSockets, maxFreeSockets: Math.min(4, this.MaxSockets) }, this._TLS));
	}

	/**
	 * Is the server a loopback address (plain http to it never crosses a network)?
	 *
	 * @return {boolean}
	 */
	isLoopback()
	{
		let tmpHost = String(this._Host || '').toLowerCase();
		return (tmpHost === 'localhost') || /^127\./.test(tmpHost) || (tmpHost === '::1') || /\.localhost$/.test(tmpHost);
	}

	/**
	 * @return {boolean} the URL is https://
	 */
	isHttps()
	{
		return this._IsHttps;
	}

	/**
	 * Tests only: called before every HTTP request (internal-contracts §57.4).
	 *
	 * @param {null | ((pRequest: Record<string, any>) => null | Record<string, any>)} fInjector
	 */
	setFaultInjector(fInjector)
	{
		this._FaultInjector = (typeof(fInjector) === 'function') ? fInjector : null;
		this._Attempts = 0;
	}

	/**
	 * @return {{ Requests: number, Retries: number, Errors: number }}
	 */
	stats()
	{
		return Object.assign({}, this._Stats);
	}

	/**
	 * Drop every keep-alive socket (shutdown only: a request still in flight fails).
	 */
	close()
	{
		this._InFlight.forEach((pRequest) => { try { pRequest.destroy(new Error('ClickHouse client closed.')); } catch (pError) { /* closing anyway */ } });
		this._InFlight.clear();
		if (this._Agent)
		{
			this._Agent.destroy();
			this._Agent = this._newAgent();
		}
	}

	/**
	 * The text of one query parameter (param_<name>=…).
	 *
	 * @param {any} pValue
	 * @return {string}
	 */
	formatParam(pValue)
	{
		return ClickHouseClient.formatParamText(pValue);
	}

	/**
	 * One element of an array literal.
	 *
	 * @param {any} pItem
	 * @return {string}
	 */
	formatArrayItem(pItem)
	{
		return ClickHouseClient.formatArrayItemText(pItem);
	}

	/**
	 * A scalar String parameter in ClickHouse's Escaped text format (a {p:String} value is parsed as
	 * escaped text, verified on 24.8: `a\tb` arrives as a TAB, `\N` as NULL, `\\` as one backslash, a
	 * trailing backslash or a raw TAB / LF fails to parse): every backslash doubled, the control
	 * characters the format escapes written as their escape sequences.  `'` needs no escape there.
	 *
	 * @param {string} pText
	 * @return {string}
	 */
	static escapeScalar(pText)
	{
		return String(pText).replace(/[\\\t\n\r\0\b\f]/g,
			(pCharacter) =>
			{
				switch (pCharacter)
				{
					case '\\': return '\\\\';
					case '\t': return '\\t';
					case '\n': return '\\n';
					case '\r': return '\\r';
					case '\0': return '\\0';
					case '\b': return '\\b';
					default: return '\\f';
				}
			});
	}

	/**
	 * The text of one query parameter (static: the fold compiler measures parameters with it).
	 *
	 * @param {any} pValue
	 * @return {string}
	 */
	static formatParamText(pValue)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined'))
		{
			return '\\N';
		}
		if (Array.isArray(pValue))
		{
			return `[${pValue.map((pItem) => { return ClickHouseClient.formatArrayItemText(pItem); }).join(',')}]`;
		}
		if (typeof(pValue) === 'boolean')
		{
			return pValue ? '1' : '0';
		}
		if ((typeof(pValue) === 'number') || (typeof(pValue) === 'bigint'))
		{
			if ((typeof(pValue) === 'number') && !Number.isFinite(pValue))
			{
				throw new Error('ClickHouseClient: a non-finite number cannot be a parameter.');
			}
			return String(pValue);
		}
		if (pValue instanceof Date)
		{
			return pValue.toISOString().slice(0, 23).replace('T', ' ');
		}
		return ClickHouseClient.escapeScalar(pValue);
	}

	/**
	 * One element of an array literal (quoted, `\` and `'` backslash-escaped; control characters escaped).
	 *
	 * @param {any} pItem
	 * @return {string}
	 */
	static formatArrayItemText(pItem)
	{
		if ((pItem === null) || (typeof(pItem) === 'undefined'))
		{
			return 'NULL';
		}
		if (Array.isArray(pItem))
		{
			return `[${pItem.map((pInner) => { return ClickHouseClient.formatArrayItemText(pInner); }).join(',')}]`;
		}
		if (typeof(pItem) === 'boolean')
		{
			return pItem ? '1' : '0';
		}
		if ((typeof(pItem) === 'number') || (typeof(pItem) === 'bigint'))
		{
			if ((typeof(pItem) === 'number') && !Number.isFinite(pItem))
			{
				throw new Error('ClickHouseClient: a non-finite number cannot be a parameter.');
			}
			return String(pItem);
		}
		let tmpText = (pItem instanceof Date) ? pItem.toISOString().slice(0, 23).replace('T', ' ') : String(pItem);
		return `'${ClickHouseClient.escapeScalar(tmpText).replace(/'/g, "\\'")}'`;
	}

	/**
	 * GET /ping → (null, true) when the server answers "Ok."; never an error for an unreachable server.
	 *
	 * @param {(pError?: Error, pUp?: boolean) => void} fCallback
	 */
	ping(fCallback)
	{
		this._request({ Kind: 'Ping', Method: 'GET', Path: '/ping', Body: null, Authenticate: false, TimeoutMS: this.PingTimeoutMS },
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(null, false);
				}
				return fCallback(null, (pResponse.Status === 200) && (pResponse.Text.indexOf('Ok') >= 0));
			});
	}

	/**
	 * A read: FORMAT JSON → normalized rows and the meta.
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {Record<string, any>|null} pSettings
	 * @param {{ TimeoutMS?: number }|Function} pCallOptions - optional: TimeoutMS bounds this call (from
	 *        the moment it is issued, agent queue time included); or the callback
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>, pMeta?: Array<{ name: string, type: string }>) => void} [fCallback]
	 */
	query(pSQL, pParams, pSettings, pCallOptions, fCallback)
	{
		if (typeof(pCallOptions) === 'function')
		{
			fCallback = pCallOptions;
			pCallOptions = null;
		}
		let tmpSettings = Object.assign({ default_format: 'JSON', output_format_json_quote_64bit_integers: 1 }, pSettings || {});
		this._statement('Query', pSQL, pParams, tmpSettings, null,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpParsed = null;
				try
				{
					tmpParsed = JSON.parse(pResponse.Text);
				}
				catch (pParseError)
				{
					// A failure after the headers were sent arrives as a 200 whose body ends in the exception.
					return fCallback(this._error(0, ClickHouseClient.exceptionText(pResponse.Text) || 'ClickHouse returned a response that is not JSON.', pResponse.Text, 'Query', null));
				}
				if (tmpParsed && (typeof(tmpParsed.exception) === 'string'))
				{
					return fCallback(this._error(500, tmpParsed.exception, tmpParsed.exception, 'Query', null));
				}
				let tmpMeta = (tmpParsed && Array.isArray(tmpParsed.meta)) ? tmpParsed.meta : [];
				let tmpRows = (tmpParsed && Array.isArray(tmpParsed.data)) ? tmpParsed.data : [];
				return fCallback(null, ClickHouseClient.normalizeRows(tmpRows, tmpMeta), tmpMeta);
			}, null, pCallOptions);
	}

	/**
	 * A statement with no result rows (DDL, EXCHANGE, DROP, …).
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {Record<string, any>|null} pSettings
	 * @param {{ TimeoutMS?: number }|Function} pCallOptions - optional, or the callback
	 * @param {(pError?: Error) => void} [fCallback]
	 */
	command(pSQL, pParams, pSettings, pCallOptions, fCallback)
	{
		if (typeof(pCallOptions) === 'function')
		{
			fCallback = pCallOptions;
			pCallOptions = null;
		}
		this._statement('Command', pSQL, pParams, pSettings || {}, null,
			(pError) =>
			{
				return fCallback(pError || null);
			}, null, pCallOptions);
	}

	/**
	 * INSERT INTO <pTable> FORMAT JSONEachRow; pOptions.Token → insert_deduplication_token.  With a
	 * Token, a retryable failure (network, timeout, 5xx) is re-sent up to pOptions.Retries times with
	 * the SAME token, so an insert that landed before the failure is a no-op the second time.
	 *
	 * @param {string} pTable - pre-quoted, database-qualified (ClickHouse-DDL.qualified)
	 * @param {Array<Record<string, any>>} pRows
	 * @param {{ Token?: string, Settings?: Record<string, any>, Retries?: number, Query?: string, TimeoutMS?: number }} pOptions - Query: an
	 *        INSERT INTO <pTable> (…) SELECT … FROM input('…') FORMAT JSONEachRow of the same table;
	 *        TimeoutMS bounds each attempt (a shutdown's last state write)
	 * @param {(pError?: Error, pCount?: number) => void} fCallback
	 */
	insert(pTable, pRows, pOptions, fCallback)
	{
		let tmpOptions = pOptions || {};
		if (!Array.isArray(pRows) || (pRows.length < 1))
		{
			return fCallback(null, 0);
		}
		if ((typeof(pTable) !== 'string') || !QUALIFIED_TABLE_PATTERN.test(pTable))
		{
			return fCallback(this._error(0, 'ClickHouseClient: insert needs a quoted, qualified table name.', null, 'Insert', null));
		}
		let tmpBody;
		try
		{
			tmpBody = pRows.map((pRow) => { return JSON.stringify(pRow); }).join('\n');
		}
		catch (pSerializeError)
		{
			return fCallback(this._error(0, 'ClickHouseClient: a row could not be serialized.', null, 'Insert', null));
		}
		let tmpHasToken = (typeof(tmpOptions.Token) === 'string') && (tmpOptions.Token.length > 0);
		let tmpSettings = Object.assign({ insert_deduplicate: 1 }, tmpOptions.Settings || {});
		if (tmpHasToken)
		{
			tmpSettings.insert_deduplication_token = tmpOptions.Token;
		}
		if (typeof(tmpOptions.Query) === 'string')
		{
			// A caller-built INSERT … SELECT … FROM input(…) FORMAT JSONEachRow into the same table (the store
			// uses it to convert Float64 text with precise_float_parsing: the JSON parser is not exact).
			if ((tmpOptions.Query.indexOf(`INSERT INTO ${pTable} `) !== 0) || !/ FORMAT JSONEachRow$/.test(tmpOptions.Query))
			{
				return fCallback(this._error(0, 'ClickHouseClient: an insert Query must be INSERT INTO <the table> … FORMAT JSONEachRow.', null, 'Insert', null, false));
			}
			tmpSettings.query = tmpOptions.Query;
		}
		else
		{
			tmpSettings.query = `INSERT INTO ${pTable} FORMAT JSONEachRow`;
		}
		// Without a token a re-send could duplicate rows: no retry then.
		let tmpRetries = (tmpHasToken && Number.isInteger(tmpOptions.Retries) && (tmpOptions.Retries > 0)) ? tmpOptions.Retries : 0;
		let tmpAttempt = 0;
		let fAttempt = () =>
		{
			tmpAttempt++;
			this._statement('Insert', null, null, tmpSettings, tmpBody,
				(pError) =>
				{
					if (pError)
					{
						if (pError.Retryable && (tmpAttempt <= tmpRetries))
						{
							this._Stats.Retries++;
							let tmpTimer = setTimeout(fAttempt, this.RetryDelayMS * tmpAttempt);
							if (tmpTimer && (typeof(tmpTimer.unref) === 'function'))
							{
								tmpTimer.unref();
							}
							return;
						}
						pError.Attempts = tmpAttempt;
						return fCallback(pError);
					}
					return fCallback(null, pRows.length);
				},
				{ Table: pTable, Token: tmpHasToken ? tmpOptions.Token : null, Attempt: tmpAttempt },
				(Number.isFinite(tmpOptions.TimeoutMS) && (tmpOptions.TimeoutMS > 0)) ? { TimeoutMS: tmpOptions.TimeoutMS } : null);
		};
		fAttempt();
	}

	/**
	 * Build and send one statement.
	 *
	 * @param {string} pKind
	 * @param {string|null} pSQL - the body (null for an insert, whose query is a URL parameter)
	 * @param {Record<string, any>|null} pParams
	 * @param {Record<string, any>} pSettings
	 * @param {string|null} pInsertBody
	 * @param {(pError?: Error, pResponse?: { Status: number, Text: string }) => void} fCallback
	 * @param {Record<string, any>} [pFaultInfo]
	 * @param {{ TimeoutMS?: number }|null} [pCallOptions]
	 */
	_statement(pKind, pSQL, pParams, pSettings, pInsertBody, fCallback, pFaultInfo, pCallOptions)
	{
		let tmpPairs = [];
		if (this.Database !== null)
		{
			tmpPairs.push(`database=${encodeURIComponent(this.Database)}`);
		}
		try
		{
			if ((pInsertBody === null) && ((typeof(pSQL) !== 'string') || (pSQL.trim().length < 1)))
			{
				throw new Error('ClickHouseClient: an empty statement.');
			}
			let tmpSettings = Object.assign({}, this.Settings, pSettings || {});
			let tmpSettingNames = Object.keys(tmpSettings);
			for (let i = 0; i < tmpSettingNames.length; i++)
			{
				let tmpName = tmpSettingNames[i];
				let tmpValue = tmpSettings[tmpName];
				if ((tmpName !== 'query') && !SETTING_NAME_PATTERN.test(tmpName))
				{
					throw new Error('ClickHouseClient: an invalid setting name.');
				}
				if ((tmpValue === null) || (typeof(tmpValue) === 'undefined'))
				{
					continue;
				}
				if (typeof(tmpValue) === 'object')
				{
					throw new Error('ClickHouseClient: a setting value must be a scalar.');
				}
				tmpPairs.push(`${encodeURIComponent(tmpName)}=${encodeURIComponent((typeof(tmpValue) === 'boolean') ? (tmpValue ? '1' : '0') : String(tmpValue))}`);
			}
			let tmpParamNames = Object.keys(pParams || {});
			for (let i = 0; i < tmpParamNames.length; i++)
			{
				if (!PARAM_NAME_PATTERN.test(tmpParamNames[i]))
				{
					throw new Error('ClickHouseClient: an invalid parameter name.');
				}
				let tmpText = this.formatParam(pParams[tmpParamNames[i]]);
				if (Buffer.byteLength(tmpText, 'utf8') > MAX_PARAM_TEXT)
				{
					let tmpTooLong = new Error('ClickHouseClient: a parameter is longer than the server accepts.');
					tmpTooLong.ParameterSize = true;
					throw tmpTooLong;
				}
				tmpPairs.push(`param_${encodeURIComponent(tmpParamNames[i])}=${encodeURIComponent(tmpText)}`);
			}
		}
		catch (pBuildError)
		{
			let tmpBuildError = this._error(0, pBuildError.message, null, pKind, null, false);
			tmpBuildError.Deterministic = true;
			tmpBuildError.ParameterSize = !!pBuildError.ParameterSize;
			return fCallback(tmpBuildError);
		}
		let tmpBody = (pInsertBody !== null) ? pInsertBody : pSQL;
		let tmpFaultInfo = Object.assign({ Kind: pKind, SQL: pSQL }, pFaultInfo || {});
		let tmpTimeoutMS = (pCallOptions && Number.isFinite(pCallOptions.TimeoutMS) && (pCallOptions.TimeoutMS > 0)) ? Math.min(pCallOptions.TimeoutMS, this.TimeoutMS) : this.TimeoutMS;
		this._request({ Kind: pKind, Method: 'POST', Path: `/?${tmpPairs.join('&')}`, Body: tmpBody, Authenticate: true, TimeoutMS: tmpTimeoutMS, Fault: tmpFaultInfo },
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if ((pResponse.Status < 200) || (pResponse.Status >= 300))
				{
					return fCallback(this._error(pResponse.Status, pResponse.Text, pResponse.Text, pKind, pResponse.ExceptionCode));
				}
				return fCallback(null, pResponse);
			});
	}

	/**
	 * One HTTP request, through the fault injector when one is set.  A reused keep-alive socket that
	 * is reset before any response is retried once on a fresh socket for idempotent kinds.
	 *
	 * @param {{ Kind: string, Method: string, Path: string, Body: string|null, Authenticate: boolean, TimeoutMS: number, Fault?: Record<string, any> }} pRequest
	 * @param {(pError?: Error, pResponse?: { Status: number, Text: string, ExceptionCode: number|null }) => void} fCallback
	 */
	_request(pRequest, fCallback)
	{
		let tmpFault = null;
		if (this._FaultInjector)
		{
			this._Attempts++;
			try
			{
				// Attempt: this statement's attempt (an insert's same-token retries count up); Sequence: every
				// request this client sent since the injector was set.
				tmpFault = this._FaultInjector(Object.assign({ Attempt: 1, Sequence: this._Attempts }, pRequest.Fault || { Kind: pRequest.Kind }));
			}
			catch (pInjectorError)
			{
				tmpFault = null;
			}
		}
		this._Stats.Requests++;
		if (tmpFault && tmpFault.Error)
		{
			let tmpError = this._error(0, (tmpFault.Error && tmpFault.Error.message) || 'Injected network error.', null, pRequest.Kind, null);
			this._Stats.Errors++;
			return setImmediate(() => { return fCallback(tmpError); });
		}
		if (tmpFault && (tmpFault.When !== 'After'))
		{
			this._Stats.Errors++;
			return setImmediate(() => { return fCallback(null, { Status: tmpFault.Status || 500, Text: tmpFault.Text || 'Injected failure.', ExceptionCode: null }); });
		}
		this._send(pRequest, true,
			(pError, pResponse) =>
			{
				if (!pError && tmpFault && (tmpFault.When === 'After'))
				{
					// The request landed; report the injected failure anyway (the dedup-token case).
					this._Stats.Errors++;
					return fCallback(null, { Status: tmpFault.Status || 500, Text: tmpFault.Text || 'Injected failure after send.', ExceptionCode: null });
				}
				if (pError || (pResponse && ((pResponse.Status < 200) || (pResponse.Status >= 300))))
				{
					this._Stats.Errors++;
				}
				return fCallback(pError || null, pResponse);
			});
	}

	/**
	 * Send one HTTP request.
	 *
	 * @param {Record<string, any>} pRequest
	 * @param {boolean} pMayRetryReset - a reset reused socket may be retried once (idempotent kinds)
	 * @param {(pError?: Error, pResponse?: { Status: number, Text: string, ExceptionCode: number|null }) => void} fCallback
	 */
	_send(pRequest, pMayRetryReset, fCallback)
	{
		let tmpLib = this._IsHttps ? libHttps : libHttp;
		let tmpHeaders = {};
		if (pRequest.Authenticate)
		{
			tmpHeaders['X-ClickHouse-User'] = this.User;
			if (this.Password)
			{
				tmpHeaders['X-ClickHouse-Key'] = this.Password;
			}
		}
		let tmpBuffer = (typeof(pRequest.Body) === 'string') ? Buffer.from(pRequest.Body, 'utf8') : null;
		if (tmpBuffer)
		{
			tmpHeaders['Content-Length'] = tmpBuffer.length;
			tmpHeaders['Content-Type'] = 'text/plain; charset=utf-8';
		}
		let tmpDone = false;
		let tmpResponded = false;
		let tmpRequest = null;
		let tmpTimedOut = false;
		// The whole call is bounded from the moment it is issued (time queued in the agent for a socket
		// included): the socket timeout alone only fires on inactivity once a socket was assigned.
		let tmpDeadlineTimer = null;
		let fFinish = (pError, pResponse) =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpDone = true;
			if (tmpDeadlineTimer)
			{
				clearTimeout(tmpDeadlineTimer);
				tmpDeadlineTimer = null;
			}
			if (tmpRequest)
			{
				this._InFlight.delete(tmpRequest);
			}
			if (pError && !tmpResponded && !tmpTimedOut && pMayRetryReset && tmpRequest && tmpRequest.reusedSocket
				&& ((pError.NetworkCode === 'ECONNRESET') || (pError.NetworkCode === 'EPIPE')) && (IDEMPOTENT_KINDS.indexOf(pRequest.Kind) >= 0))
			{
				this._Stats.Retries++;
				return this._send(pRequest, false, fCallback);
			}
			return fCallback(pError || null, pResponse);
		};
		let fNetworkError = (pError) =>
		{
			let tmpError = this._error(0, (pError && pError.message) || 'ClickHouse network error.', null, pRequest.Kind, null);
			tmpError.NetworkCode = (pError && (typeof(pError.code) === 'string')) ? pError.code : null;
			if (tmpTimedOut)
			{
				tmpError.TimedOut = true;
				tmpError.NetworkCode = 'ETIMEDOUT';
				tmpError.TimeoutMS = pRequest.TimeoutMS;
			}
			return tmpError;
		};
		try
		{
			let tmpRequestOptions = { host: this._Host, port: this._Port, method: pRequest.Method, path: pRequest.Path, headers: tmpHeaders, timeout: pRequest.TimeoutMS };
			if (this._Agent)
			{
				tmpRequestOptions.agent = this._Agent;
			}
			else if (this._IsHttps)
			{
				Object.assign(tmpRequestOptions, this._TLS);
			}
			tmpRequest = tmpLib.request(tmpRequestOptions,
				(pResponse) =>
				{
					tmpResponded = true;
					let tmpChunks = [];
					let tmpExceptionCode = parseInt(pResponse.headers['x-clickhouse-exception-code'], 10);
					pResponse.on('data', (pChunk) => { tmpChunks.push(pChunk); });
					pResponse.on('end', () => { return fFinish(null, { Status: pResponse.statusCode, Text: Buffer.concat(tmpChunks).toString('utf8'), ExceptionCode: Number.isInteger(tmpExceptionCode) ? tmpExceptionCode : null }); });
					pResponse.on('error', (pError) => { return fFinish(fNetworkError(pError)); });
					// A response cut off (the deadline destroyed the request mid-body): never left hanging.
					pResponse.on('close', () => { return fFinish(fNetworkError(new Error('ClickHouse response closed before it ended.'))); });
				});
		}
		catch (pRequestError)
		{
			return setImmediate(() => { return fFinish(fNetworkError(pRequestError)); });
		}
		this._InFlight.add(tmpRequest);
		let fTimeout = () =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpTimedOut = true;
			tmpRequest.destroy(new Error(`ClickHouse request timed out after ${pRequest.TimeoutMS}ms.`));
		};
		tmpDeadlineTimer = setTimeout(fTimeout, Math.max(1, pRequest.TimeoutMS));
		if (typeof(tmpDeadlineTimer.unref) === 'function')
		{
			tmpDeadlineTimer.unref();
		}
		tmpRequest.on('error', (pError) => { return fFinish(fNetworkError(pError)); });
		tmpRequest.on('timeout', fTimeout);
		if (tmpBuffer)
		{
			tmpRequest.write(tmpBuffer);
		}
		tmpRequest.end();
	}

	/**
	 * A store error: .StoreError, .Status (0 = network / timeout / client-side), .Code (the ClickHouse
	 * error code when known; a network failure's node code is .NetworkCode), .Name (the exception name),
	 * .Retryable (network, timeout, a 5xx whose code is not deterministic).  The message never carries the password, and for any code
	 * outside DETAIL_SAFE_CODES (and every insert) it carries no server detail, so a bound value or an
	 * inserted row can never reach a log through it.
	 *
	 * @param {number} pStatus
	 * @param {string} pText
	 * @param {string|null} pServerText
	 * @param {string} [pKind]
	 * @param {number|null} [pExceptionCode] - the X-ClickHouse-Exception-Code header
	 * @param {boolean} [pRetryable] - overrides the status rule (client-side build errors are never retryable)
	 * @return {Error}
	 */
	_error(pStatus, pText, pServerText, pKind, pExceptionCode, pRetryable)
	{
		let tmpServerText = (typeof(pServerText) === 'string') ? pServerText : null;
		let tmpRaw = String(pText || '');
		if (tmpServerText && /^\s*\{/.test(tmpServerText))
		{
			// FORMAT JSON reports a failure mid-stream as { …, "exception": "Code: 60. DB::Exception: …" }.
			try
			{
				let tmpParsed = JSON.parse(tmpServerText);
				if (tmpParsed && (typeof(tmpParsed.exception) === 'string'))
				{
					tmpServerText = tmpParsed.exception;
					tmpRaw = tmpParsed.exception;
				}
			}
			catch (pParseError)
			{
				tmpRaw = String(pText || '');
			}
		}
		let tmpCodeMatch = tmpServerText ? /Code:\s*(\d+)/.exec(tmpServerText) : null;
		let tmpCode = Number.isInteger(pExceptionCode) ? pExceptionCode : (tmpCodeMatch ? parseInt(tmpCodeMatch[1], 10) : null);
		let tmpNameMatch = tmpServerText ? /\(([A-Z][A-Z0-9_]+)\)(?:\s*\(version .*\))?\s*$/.exec(tmpServerText.trim().split('\n')[0]) : null;
		let tmpName = tmpNameMatch ? tmpNameMatch[1] : null;
		let tmpText;
		if (tmpServerText && ((pKind === 'Insert') || (tmpCode === null) || (DETAIL_SAFE_CODES.indexOf(tmpCode) < 0)))
		{
			tmpText = `Code: ${(tmpCode === null) ? '?' : tmpCode}.${tmpName ? ` ${tmpName}` : ''} (detail withheld: it may carry a bound value)`;
		}
		else
		{
			tmpText = ClickHouseClient.redact(((tmpServerText !== null) ? tmpServerText : tmpRaw).trim().split('\n')[0], this.Password).slice(0, MAX_ERROR_TEXT);
		}
		let tmpError = new Error((pStatus > 0) ? `ClickHouse ${pStatus}: ${tmpText}` : tmpText);
		tmpError.StoreError = true;
		tmpError.Status = pStatus;
		tmpError.Code = tmpCode;
		tmpError.Name = tmpName;
		tmpError.Kind = pKind || null;
		tmpError.Retryable = (typeof(pRetryable) === 'boolean') ? pRetryable
			: ((pStatus === 0) || ((pStatus >= 500) && ((tmpCode === null) || (DETERMINISTIC_CODES.indexOf(tmpCode) < 0))));
		// Deterministic: the same statement fails the same way again (a 4xx, a parse / type / parameter
		// error, a client-side refusal) — the caller's statement, never the store's health.
		tmpError.Deterministic = ((pStatus >= 400) && (pStatus < 500)) || ((tmpCode !== null) && (DETERMINISTIC_CODES.indexOf(tmpCode) >= 0)) || (pRetryable === false);
		// Limit: a per-query limit the caller set (rows, bytes, result size, memory).
		tmpError.Limit = (tmpCode !== null) && (LIMIT_CODES.indexOf(tmpCode) >= 0);
		if ((tmpCode !== null) && (TIMEOUT_CODES.indexOf(tmpCode) >= 0))
		{
			tmpError.TimedOut = true;
		}
		return tmpError;
	}

	/**
	 * The exception text at the end of a broken JSON body (a failure after the headers were sent).
	 *
	 * @param {string} pText
	 * @return {string|null}
	 */
	static exceptionText(pText)
	{
		let tmpMatch = /(Code:\s*\d+\..*)$/s.exec(String(pText || ''));
		return tmpMatch ? tmpMatch[1].trim() : null;
	}

	/**
	 * Strip a password a server or a library echoed into a message.
	 *
	 * @param {string} pText
	 * @param {string} [pPassword]
	 * @return {string}
	 */
	static redact(pText, pPassword)
	{
		let tmpText = String(pText || '');
		if ((typeof(pPassword) === 'string') && (pPassword.length > 0))
		{
			tmpText = tmpText.split(pPassword).join('<redacted>');
		}
		return tmpText;
	}

	/**
	 * A wide-integer JSON value → a JS number when safe, else its decimal text.
	 *
	 * @param {any} pValue
	 * @return {any}
	 */
	static normalizeWideInteger(pValue)
	{
		if ((typeof(pValue) === 'string') && /^-?\d+$/.test(pValue))
		{
			let tmpNumber = Number(pValue);
			if (Number.isSafeInteger(tmpNumber))
			{
				return tmpNumber;
			}
		}
		return pValue;
	}

	/**
	 * Wide integers (quoted by output_format_json_quote_64bit_integers = 1) → JS numbers when safe,
	 * else kept as decimal strings (arrays of them element by element); every other value as returned.
	 *
	 * @param {Array<Record<string, any>>} pRows
	 * @param {Array<{ name: string, type: string }>} pMeta
	 * @return {Array<Record<string, any>>}
	 */
	static normalizeRows(pRows, pMeta)
	{
		let tmpWide = [];
		let tmpWideArrays = [];
		for (let i = 0; i < pMeta.length; i++)
		{
			if (!pMeta[i] || (typeof(pMeta[i].type) !== 'string'))
			{
				continue;
			}
			if (WIDE_INTEGER_PATTERN.test(pMeta[i].type))
			{
				tmpWide.push(pMeta[i].name);
			}
			else if (WIDE_INTEGER_ARRAY_PATTERN.test(pMeta[i].type))
			{
				tmpWideArrays.push(pMeta[i].name);
			}
		}
		if ((tmpWide.length < 1) && (tmpWideArrays.length < 1))
		{
			return pRows;
		}
		for (let i = 0; i < pRows.length; i++)
		{
			for (let j = 0; j < tmpWide.length; j++)
			{
				pRows[i][tmpWide[j]] = ClickHouseClient.normalizeWideInteger(pRows[i][tmpWide[j]]);
			}
			for (let j = 0; j < tmpWideArrays.length; j++)
			{
				let tmpArray = pRows[i][tmpWideArrays[j]];
				if (Array.isArray(tmpArray))
				{
					pRows[i][tmpWideArrays[j]] = tmpArray.map(ClickHouseClient.normalizeWideInteger);
				}
			}
		}
		return pRows;
	}
}

module.exports = ClickHouseClient;
module.exports.PARAM_NAME_PATTERN = PARAM_NAME_PATTERN;
module.exports.SETTING_NAME_PATTERN = SETTING_NAME_PATTERN;
module.exports.QUALIFIED_TABLE_PATTERN = QUALIFIED_TABLE_PATTERN;
module.exports.DETAIL_SAFE_CODES = DETAIL_SAFE_CODES;
module.exports.DETERMINISTIC_CODES = DETERMINISTIC_CODES;
module.exports.LIMIT_CODES = LIMIT_CODES;
module.exports.TIMEOUT_CODES = TIMEOUT_CODES;
module.exports.MAX_PARAM_TEXT = MAX_PARAM_TEXT;
