/**
 * Retold Faceting - MaterializeSource (in-process)
 *
 * The materializer's trusted reader (design 04 §6.1 step 3, D-26, 06 §12; internal-contracts §58.7):
 * Host.getDAL(Entity) — the DAL, never the route-bound controller — a fresh DAL.query,
 * setDisableDeleteTracking(true) so soft-deleted rows are seen, an explicit projection of the spec's
 * SourceColumns (never SELECT *, never a Sensitive column), NO behaviors, provider.Read directly (raw
 * rows copied to plain objects), always an explicit cap.  Its output only ever lands in a store that
 * carries every scope column, never in a user response.
 *
 *   readRows(pEntity, pIDs, { Columns }, fCallback)                    Identity IN (chunks of ReadChunkIDs)
 *   readRange(pEntity, pAfterID, pCap, { Columns, ToID }, fCallback)   keyset by identity (ORDER BY identity LIMIT Cap)
 *   readIDs(pEntity, pAfterID, pToID, fCallback)                       [ { ID, Live } ] (Bisect leaves)
 *   sweep(pEntity, { Column, From: { At, ID }, Cap }, fCallback)       compound (At, ID) keyset → { Rows: [ { ID, At } ], Next }
 *   checksums(pEntity, pLeafRange, fCallback)                          { bucket: { Count, IDSum } } over LIVE rows
 *   idsByFilter(pEntity, pFilterEntries, { Cap }, fCallback)           notifyByFilter resolution (source side)
 *   maxStamp(pEntity, pColumn, fCallback)                              MAX(stamp) as the source's text (a backfill's Sweep watermark)
 *   fingerprint(pEntities)                                             the source database's identity (the owner marker)
 *   dialect(pEntity)                                                   'SQLite' | 'PostgreSQL'
 *
 * DateTime columns of a PostgreSQL source are read as text (to_char … 'YYYY-MM-DD HH24:MI:SS.US'), never
 * as a driver Date: node-pg parses a `timestamp` in the process time zone (every value would shift by
 * the host offset when TZ is not UTC) and truncates microseconds; the type map flags a sub-millisecond
 * fraction 'Compare' (it buckets identically, but compares differently than at the source).
 *
 * Liveness (§56.4): the delete column exactly 0 and, for a Tenant / Personal entity, the tenant set.
 * Aggregate and sweep statements are queryOverride reads built only from validated identifiers and bound
 * values (like the Live shells).  Sweep `At` values are the source's own text (PostgreSQL: to_char with
 * microseconds, so a compound keyset never stalls on sub-millisecond stamps).
 *
 * Contract: internal-contracts §58.7.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');

const IDENTIFIER_PATTERN = libFacetRequest.IDENTIFIER_PATTERN;

// FoxHound operators a filter-scoped hint may carry (idsByFilter).
const FILTER_OPERATORS = Object.freeze([ '=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS', 'IS NOT', 'IS NULL', 'IS NOT NULL', '(', ')' ]);

// MeadowSchema types whose values are text (the checksum's tenant-set test differs).
const TEXT_SCHEMA_TYPES = Object.freeze([ 'String', 'Text', 'AutoGUID', 'JSON', 'JSONProxy' ]);

// MeadowSchema types of a DateTime column (read as text on PostgreSQL: see _projection).
const DATE_SCHEMA_TYPES = Object.freeze([ 'DateTime', 'CreateDate', 'UpdateDate', 'DeleteDate' ]);

// The PostgreSQL text of a timestamp, with microseconds (the naive wall clock, never a JS Date: node-pg
// would read a `timestamp` in the PROCESS time zone and drop the microseconds).
const PG_TIMESTAMP_TEXT = "'YYYY-MM-DD HH24:MI:SS.US'";

// The default page of idsByFilter.
const IDS_PAGE = 5000;

/**
 * A source error (never carries bound values).
 *
 * @param {string} pMessage
 * @return {Error}
 */
const sourceError = (pMessage) =>
{
	let tmpError = new Error(`RetoldFaceting MaterializeSource: ${pMessage}`);
	tmpError.SourceError = true;
	return tmpError;
};

/**
 * Normalize an identity value read from a source row (bigint / numeric text → number when safe).
 *
 * @param {any} pValue
 * @return {number|null}
 */
const toID = (pValue) =>
{
	if ((typeof(pValue) === 'number') && Number.isSafeInteger(pValue))
	{
		return pValue;
	}
	if ((typeof(pValue) === 'bigint') && Number.isSafeInteger(Number(pValue)))
	{
		return Number(pValue);
	}
	if ((typeof(pValue) === 'string') && /^\s*-?[0-9]+\s*$/.test(pValue) && Number.isSafeInteger(Number(pValue)))
	{
		return Number(pValue);
	}
	return null;
};

/**
 * Exactly zero, as SQL `C = 0` sees it (the explicit soft delete).
 *
 * @param {any} pValue
 * @return {boolean}
 */
const isZero = (pValue) =>
{
	if (typeof(pValue) === 'number')
	{
		return pValue === 0;
	}
	if (typeof(pValue) === 'bigint')
	{
		return pValue === BigInt(0);
	}
	if (typeof(pValue) === 'string')
	{
		return /^\s*[+-]?0*(\.0*)?\s*$/.test(pValue) && /0/.test(pValue);
	}
	return false;
};

/**
 * A number from a driver aggregate (pg returns bigint / numeric as text).
 *
 * @param {any} pValue
 * @return {number}
 */
const toNumber = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return 0;
	}
	let tmpNumber = Number(pValue);
	return Number.isFinite(tmpNumber) ? tmpNumber : 0;
};

/**
 * A two-digit field.
 *
 * @param {number} pNumber
 * @param {number} [pWidth]
 * @return {string}
 */
const pad = (pNumber, pWidth) =>
{
	return String(pNumber).padStart(pWidth || 2, '0');
};

/**
 * A sweep watermark value as text ('YYYY-MM-DD HH:mm:ss[.fraction]'): a JS Date (read in UTC) or the
 * source's own text.
 *
 * @param {any} pValue
 * @return {string|null}
 */
const atText = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return null;
	}
	if (pValue instanceof Date)
	{
		if (isNaN(pValue.getTime()))
		{
			return null;
		}
		return `${pValue.getUTCFullYear()}-${pad(pValue.getUTCMonth() + 1)}-${pad(pValue.getUTCDate())} ${pad(pValue.getUTCHours())}:${pad(pValue.getUTCMinutes())}:${pad(pValue.getUTCSeconds())}.${pad(pValue.getUTCMilliseconds(), 3)}`;
	}
	return String(pValue);
};

class RetoldFacetingMaterializeSourceInProcess extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingMaterializeSourceInProcess';

		// The host adapter (null: RetoldFacetingService.Host, resolved per call).
		this.Host = null;

		let tmpMaterializer = this.options.Materializer || {};
		this.ReadChunkIDs = ((typeof(tmpMaterializer.ReadChunkIDs) === 'number') && (tmpMaterializer.ReadChunkIDs > 0)) ? tmpMaterializer.ReadChunkIDs : 1000;

		// Statements run (diagnostics, tests).
		this.Statements = 0;
	}

	// ---- plumbing ------------------------------------------------------------------------------

	/**
	 * @return {any|null}
	 */
	_host()
	{
		if (this.Host)
		{
			return this.Host;
		}
		let tmpService = this.fable.RetoldFacetingService;
		return (tmpService && tmpService.Host) ? tmpService.Host : null;
	}

	/**
	 * What a read of one entity needs: the DAL, its identity, its scope columns and dialect.
	 *
	 * @param {string} pEntity
	 * @return {{ DAL: any, Identity: string, DeleteColumn: string|null, TenantColumn: string|null, Kind: string, Dialect: string, TenantIsText: boolean }}
	 */
	_entity(pEntity)
	{
		if ((typeof(pEntity) !== 'string') || !IDENTIFIER_PATTERN.test(pEntity))
		{
			throw sourceError('an entity name is not an identifier.');
		}
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.getDAL) !== 'function'))
		{
			throw sourceError('no host is bound.');
		}
		let tmpDAL = tmpHost.getDAL(pEntity);
		if (!tmpDAL || !tmpDAL.provider || (typeof(tmpDAL.provider.Read) !== 'function'))
		{
			throw sourceError(`the entity ${pEntity} has no DAL.`);
		}
		let tmpScope = (typeof(tmpHost.entityScopeColumns) === 'function') ? tmpHost.entityScopeColumns(pEntity) : {};
		let tmpIdentity = tmpScope.PrimaryKey
			|| ((typeof(tmpHost.getPrimaryKey) === 'function') ? tmpHost.getPrimaryKey(pEntity) : null)
			|| tmpDAL.defaultIdentifier;
		if ((typeof(tmpIdentity) !== 'string') || !IDENTIFIER_PATTERN.test(tmpIdentity))
		{
			throw sourceError(`the entity ${pEntity} has no identity column.`);
		}
		let tmpDialect = this.dialect(pEntity) || 'SQLite';
		let tmpTenantColumn = ((tmpScope.Kind === 'Tenant') || (tmpScope.Kind === 'Personal')) ? (tmpScope.TenantColumn || null) : null;
		let tmpTenantIsText = false;
		if (tmpTenantColumn && Array.isArray(tmpDAL.schema))
		{
			let tmpEntry = tmpDAL.schema.find((pEntry) => { return pEntry && (pEntry.Column === tmpTenantColumn); });
			tmpTenantIsText = !!tmpEntry && (TEXT_SCHEMA_TYPES.indexOf(tmpEntry.Type) >= 0);
		}
		let tmpDeleteColumn = tmpScope.DeleteColumn || ((typeof(tmpHost.getDeleteColumn) === 'function') ? tmpHost.getDeleteColumn(pEntity) : null);
		let tmpDateColumns = [];
		if (Array.isArray(tmpDAL.schema))
		{
			tmpDAL.schema.forEach((pEntry) => { if (pEntry && (typeof(pEntry.Column) === 'string') && (DATE_SCHEMA_TYPES.indexOf(pEntry.Type) >= 0)) { tmpDateColumns.push(pEntry.Column); } });
		}
		return (
			{
				DateColumns: tmpDateColumns,
				DAL: tmpDAL,
				Identity: tmpIdentity,
				DeleteColumn: ((typeof(tmpDeleteColumn) === 'string') && IDENTIFIER_PATTERN.test(tmpDeleteColumn)) ? tmpDeleteColumn : null,
				TenantColumn: ((typeof(tmpTenantColumn) === 'string') && IDENTIFIER_PATTERN.test(tmpTenantColumn)) ? tmpTenantColumn : null,
				Kind: tmpScope.Kind || 'Unscoped',
				Dialect: tmpDialect,
				TenantIsText: tmpTenantIsText
			});
	}

	/**
	 * Validate a projection: identifiers only, the identity always first.
	 *
	 * @param {Array<string>} pColumns
	 * @param {string} pIdentity
	 * @return {Array<string>}
	 */
	_columns(pColumns, pIdentity)
	{
		let tmpColumns = [ pIdentity ];
		(Array.isArray(pColumns) ? pColumns : []).forEach(
			(pColumn) =>
			{
				if ((typeof(pColumn) !== 'string') || !IDENTIFIER_PATTERN.test(pColumn))
				{
					throw sourceError('a projected column is not an identifier.');
				}
				if (tmpColumns.indexOf(pColumn) < 0)
				{
					tmpColumns.push(pColumn);
				}
			});
		return tmpColumns;
	}

	/**
	 * The projection of a row read: setDataElements, and on PostgreSQL — when a DateTime column is
	 * projected — a queryOverride whose select list reads those columns as text with microseconds (the
	 * naive wall clock; see the module comment).
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {any} pQuery
	 * @param {Array<string>} pColumns - validated identifiers, the identity first
	 */
	_projection(pEntityInfo, pQuery, pColumns)
	{
		pQuery.setDataElements(pColumns);
		if ((pEntityInfo.Dialect !== 'PostgreSQL') || !pColumns.some((pColumn) => { return pEntityInfo.DateColumns.indexOf(pColumn) >= 0; }))
		{
			return;
		}
		let tmpList = pColumns.map(
			(pColumn) =>
			{
				let tmpQuoted = this._quote(pEntityInfo, pColumn);
				return (pEntityInfo.DateColumns.indexOf(pColumn) >= 0) ? `to_char(${tmpQuoted}, ${PG_TIMESTAMP_TEXT}) AS ${tmpQuoted}` : tmpQuoted;
			}).join(', ');
		pQuery.parameters.queryOverride = `SELECT ${tmpList} FROM<%= TableName %><%= Where %><%= OrderBy %><%= Limit %>`;
	}

	/**
	 * A fresh, behavior-free query on the entity's DAL that sees soft-deleted rows.
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @return {any} a FoxHound query
	 */
	_query(pEntityInfo)
	{
		let tmpQuery = pEntityInfo.DAL.query;
		tmpQuery.setDisableDeleteTracking(true);
		tmpQuery.setBegin(0);
		return tmpQuery;
	}

	/**
	 * Quote an identifier for the entity's dialect (validated identifiers only).
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {string} pIdentifier
	 * @return {string}
	 */
	_quote(pEntityInfo, pIdentifier)
	{
		if (!IDENTIFIER_PATTERN.test(pIdentifier))
		{
			throw sourceError('an identifier is not valid.');
		}
		return `"${pIdentifier}"`;
	}

	/**
	 * Run a FoxHound query through provider.Read (synchronous providers continued after Read returns);
	 * rows copied to plain objects.
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {any} pQuery
	 * @param {string} pWhat
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	_read(pEntityInfo, pQuery, pWhat, fCallback)
	{
		this.Statements++;
		let tmpCalledBack = false;
		let tmpSynchronous = true;
		let tmpPending = null;
		let fFinish = (pError) =>
		{
			if (pError)
			{
				this.fable.log.error(`RetoldFaceting MaterializeSource ${pWhat} failed: ${pError.message}`);
				let tmpError = sourceError(`${pWhat} failed.`);
				tmpError.Cause = pError.message;
				return fCallback(tmpError);
			}
			let tmpResult = pQuery.parameters.result || {};
			let tmpRows = Array.isArray(tmpResult.value) ? tmpResult.value : [];
			return fCallback(null, tmpRows.map((pRow) => { return Object.assign({}, pRow); }));
		};
		let fReadDone = () =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			let tmpResult = pQuery.parameters.result || {};
			let tmpError = tmpResult.error ? tmpResult.error : null;
			if (tmpSynchronous)
			{
				tmpPending = { Error: tmpError };
				return;
			}
			return fFinish(tmpError);
		};
		try
		{
			pEntityInfo.DAL.provider.Read(pQuery, fReadDone);
		}
		catch (pReadError)
		{
			if (!tmpCalledBack)
			{
				tmpCalledBack = true;
				tmpPending = { Error: pReadError };
			}
		}
		tmpSynchronous = false;
		if (tmpPending)
		{
			return fFinish(tmpPending.Error);
		}
	}

	/**
	 * Run a sequence of reads one after the other.
	 *
	 * @param {Array<(fNext: (pError?: Error, pRows?: Array<any>) => void) => void>} pSteps
	 * @param {(pError?: Error, pRows?: Array<any>) => void} fCallback - all rows concatenated
	 */
	_series(pSteps, fCallback)
	{
		let tmpRows = [];
		let tmpIndex = 0;
		let fNext = () =>
		{
			if (tmpIndex >= pSteps.length)
			{
				return fCallback(null, tmpRows);
			}
			let tmpStep = pSteps[tmpIndex++];
			tmpStep(
				(pError, pRows) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					for (let i = 0; i < pRows.length; i++)
					{
						tmpRows.push(pRows[i]);
					}
					// Never grow the stack with synchronous providers.
					return setImmediate(fNext);
				});
		};
		fNext();
	}

	// ---- reads ----------------------------------------------------------------------------------

	/**
	 * The source rows of these IDs (missing IDs = hard-deleted), soft-deleted rows included.
	 *
	 * @param {string} pEntity
	 * @param {Array<any>} pIDs
	 * @param {{ Columns: Array<string> }} pOptions
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	readRows(pEntity, pIDs, pOptions, fCallback)
	{
		let tmpInfo;
		let tmpColumns;
		let tmpIDs = [];
		try
		{
			tmpInfo = this._entity(pEntity);
			tmpColumns = this._columns((pOptions || {}).Columns, tmpInfo.Identity);
			(Array.isArray(pIDs) ? pIDs : []).forEach(
				(pID) =>
				{
					let tmpID = toID(pID);
					if (tmpID === null)
					{
						throw sourceError('an ID is not a safe integer.');
					}
					tmpIDs.push(tmpID);
				});
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		if (tmpIDs.length < 1)
		{
			return fCallback(null, []);
		}
		let tmpSteps = [];
		for (let i = 0; i < tmpIDs.length; i += this.ReadChunkIDs)
		{
			let tmpChunk = tmpIDs.slice(i, i + this.ReadChunkIDs);
			tmpSteps.push(
				(fNext) =>
				{
					let tmpQuery;
					try
					{
						tmpQuery = this._query(tmpInfo);
						this._projection(tmpInfo, tmpQuery, tmpColumns);
						tmpQuery.addFilter(tmpInfo.Identity, tmpChunk, 'IN', 'AND', 'MSIDs');
						tmpQuery.setCap(tmpChunk.length);
					}
					catch (pBuildError)
					{
						return fNext(sourceError(`could not build the row read of ${pEntity}.`));
					}
					return this._read(tmpInfo, tmpQuery, `readRows(${pEntity})`, fNext);
				});
		}
		return this._series(tmpSteps, fCallback);
	}

	/**
	 * One keyset page: Identity > AfterID [AND ≤ ToID] ORDER BY Identity LIMIT Cap.
	 *
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number} pCap
	 * @param {{ Columns: Array<string>, ToID?: number|null }} pOptions
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	readRange(pEntity, pAfterID, pCap, pOptions, fCallback)
	{
		let tmpInfo;
		let tmpQuery;
		try
		{
			tmpInfo = this._entity(pEntity);
			let tmpOptions = pOptions || {};
			let tmpColumns = this._columns(tmpOptions.Columns, tmpInfo.Identity);
			let tmpCap = ((typeof(pCap) === 'number') && Number.isSafeInteger(pCap) && (pCap > 0)) ? pCap : null;
			if (tmpCap === null)
			{
				throw sourceError('a range read needs a positive Cap.');
			}
			tmpQuery = this._query(tmpInfo);
			this._projection(tmpInfo, tmpQuery, tmpColumns);
			this._rangeFilters(tmpInfo, tmpQuery, pAfterID, tmpOptions.ToID);
			tmpQuery.setSort([ { Column: tmpInfo.Identity, Direction: 'Ascending' } ]);
			tmpQuery.setCap(tmpCap);
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		return this._read(tmpInfo, tmpQuery, `readRange(${pEntity})`, fCallback);
	}

	/**
	 * Identity > AfterID [AND Identity ≤ ToID].
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {any} pQuery
	 * @param {number|null} pAfterID
	 * @param {number|null|undefined} pToID
	 */
	_rangeFilters(pEntityInfo, pQuery, pAfterID, pToID)
	{
		if ((pAfterID !== null) && (typeof(pAfterID) !== 'undefined'))
		{
			let tmpAfter = toID(pAfterID);
			if (tmpAfter === null)
			{
				throw sourceError('AfterID is not a safe integer.');
			}
			pQuery.addFilter(pEntityInfo.Identity, tmpAfter, '>', 'AND', 'MSAfter');
		}
		if ((pToID !== null) && (typeof(pToID) !== 'undefined'))
		{
			let tmpTo = toID(pToID);
			if (tmpTo === null)
			{
				throw sourceError('ToID is not a safe integer.');
			}
			pQuery.addFilter(pEntityInfo.Identity, tmpTo, '<=', 'AND', 'MSTo');
		}
	}

	/**
	 * Is a raw source row live (§56.4)?
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {Record<string, any>} pRow
	 * @return {boolean}
	 */
	_isLive(pEntityInfo, pRow)
	{
		if (pEntityInfo.DeleteColumn && !isZero(pRow[pEntityInfo.DeleteColumn]))
		{
			return false;
		}
		if (pEntityInfo.TenantColumn)
		{
			let tmpScope = this.options.Scope || {};
			return !libRetoldFacetingUtil.isUnsetScopeValue(pRow[pEntityInfo.TenantColumn], tmpScope.UnsetValues);
		}
		return true;
	}

	/**
	 * Every source ID of AfterID < ID ≤ ToID with its liveness (a Bisect leaf).
	 *
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {(pError?: Error, pIDs?: Array<{ ID: number, Live: boolean }>) => void} fCallback
	 */
	readIDs(pEntity, pAfterID, pToID, fCallback)
	{
		let tmpInfo;
		try
		{
			tmpInfo = this._entity(pEntity);
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		let tmpColumns = [ tmpInfo.DeleteColumn, tmpInfo.TenantColumn ].filter((pColumn) => { return !!pColumn; });
		let tmpIDs = [];
		let tmpPage = IDS_PAGE;
		let fPage = (pAfter) =>
		{
			this.readRange(pEntity, pAfter, tmpPage, { Columns: tmpColumns, ToID: pToID },
				(pError, pRows) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					let tmpLast = pAfter;
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpID = toID(pRows[i][tmpInfo.Identity]);
						if (tmpID === null)
						{
							continue;
						}
						tmpLast = tmpID;
						tmpIDs.push({ ID: tmpID, Live: this._isLive(tmpInfo, pRows[i]) });
					}
					if (pRows.length < tmpPage)
					{
						return fCallback(null, tmpIDs);
					}
					return setImmediate(() => { fPage(tmpLast); });
				});
		};
		fPage(pAfterID);
	}

	/**
	 * One compound-keyset page over a watermark column (04 §9.1): rows with Column > From.At, or
	 * Column = From.At and Identity > From.ID, ordered (Column, Identity); NULL stamps are never swept.
	 * Next is the last row's { At, ID } when the page is full, else null.
	 *
	 * @param {string} pEntity
	 * @param {{ Column: string, From?: { At: any, ID?: number|null }|null, Cap: number }} pOptions
	 * @param {(pError?: Error, pPage?: { Rows: Array<{ ID: number, At: string|null }>, Next: Record<string, any>|null }) => void} fCallback
	 */
	sweep(pEntity, pOptions, fCallback)
	{
		let tmpInfo;
		let tmpQuery;
		let tmpCap;
		try
		{
			tmpInfo = this._entity(pEntity);
			let tmpOptions = pOptions || {};
			let tmpColumn = tmpOptions.Column;
			if ((typeof(tmpColumn) !== 'string') || !IDENTIFIER_PATTERN.test(tmpColumn))
			{
				throw sourceError('the sweep column is not an identifier.');
			}
			tmpCap = ((typeof(tmpOptions.Cap) === 'number') && Number.isSafeInteger(tmpOptions.Cap) && (tmpOptions.Cap > 0)) ? tmpOptions.Cap : null;
			if (tmpCap === null)
			{
				throw sourceError('a sweep needs a positive Cap.');
			}
			let tmpFrom = (tmpOptions.From && (typeof(tmpOptions.From) === 'object')) ? tmpOptions.From : null;
			let tmpAt = (tmpFrom && (tmpFrom.At !== null) && (typeof(tmpFrom.At) !== 'undefined')) ? atText(tmpFrom.At) : null;
			let tmpFromID = (tmpFrom && (tmpFrom.ID !== null) && (typeof(tmpFrom.ID) !== 'undefined')) ? toID(tmpFrom.ID) : null;
			tmpQuery = this._query(tmpInfo);
			if (tmpAt === null)
			{
				tmpQuery.addFilter(tmpColumn, '', 'IS NOT NULL', 'AND', 'SwNN');
			}
			else if (tmpFromID === null)
			{
				tmpQuery.addFilter(tmpColumn, tmpAt, '>=', 'AND', 'SwAt0');
			}
			else
			{
				tmpQuery.addFilter('', '', '(', 'AND');
				tmpQuery.addFilter(tmpColumn, tmpAt, '>', 'AND', 'SwAt1');
				tmpQuery.addFilter('', '', '(', 'OR');
				tmpQuery.addFilter(tmpColumn, tmpAt, '=', 'AND', 'SwAt2');
				tmpQuery.addFilter(tmpInfo.Identity, tmpFromID, '>', 'AND', 'SwID');
				tmpQuery.addFilter('', '', ')');
				tmpQuery.addFilter('', '', ')');
			}
			tmpQuery.setSort([ { Column: tmpColumn, Direction: 'Ascending' }, { Column: tmpInfo.Identity, Direction: 'Ascending' } ]);
			tmpQuery.setCap(tmpCap);
			let tmpAtExpression = (tmpInfo.Dialect === 'PostgreSQL')
				? `to_char(${this._quote(tmpInfo, tmpColumn)}, 'YYYY-MM-DD HH24:MI:SS.US')`
				: this._quote(tmpInfo, tmpColumn);
			tmpQuery.parameters.queryOverride = `SELECT ${this._quote(tmpInfo, tmpInfo.Identity)} AS "MSID", ${tmpAtExpression} AS "MSAt" FROM<%= TableName %><%= Where %><%= OrderBy %><%= Limit %>`;
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		return this._read(tmpInfo, tmpQuery, `sweep(${pEntity})`,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpRows = [];
				for (let i = 0; i < pRows.length; i++)
				{
					let tmpID = toID(pRows[i].MSID);
					if (tmpID !== null)
					{
						tmpRows.push({ ID: tmpID, At: atText(pRows[i].MSAt) });
					}
				}
				let tmpNext = ((pRows.length >= tmpCap) && (tmpRows.length > 0)) ? { At: tmpRows[tmpRows.length - 1].At, ID: tmpRows[tmpRows.length - 1].ID } : null;
				return fCallback(null, { Rows: tmpRows, Next: tmpNext });
			});
	}

	/**
	 * { '<bucket>': { Count, IDSum } } over the LIVE rows, bucket = floor(ID / LeafRange): one aggregate
	 * statement.
	 *
	 * @param {string} pEntity
	 * @param {number} pLeafRange
	 * @param {(pError?: Error, pBuckets?: Record<string, { Count: number, IDSum: number }>) => void} fCallback
	 */
	checksums(pEntity, pLeafRange, fCallback)
	{
		let tmpInfo;
		let tmpQuery;
		try
		{
			tmpInfo = this._entity(pEntity);
			if (!Number.isSafeInteger(pLeafRange) || (pLeafRange < 1))
			{
				throw sourceError('LeafRange must be a positive integer.');
			}
			tmpQuery = this._query(tmpInfo);
			let tmpIdentity = this._quote(tmpInfo, tmpInfo.Identity);
			let tmpWhere = this._liveWhere(tmpInfo, tmpQuery);
			tmpQuery.query.parameters.MSLeaf = pLeafRange;
			// Integer division on both dialects (a JS number may bind as a double on SQLite).
			tmpQuery.parameters.queryOverride = `SELECT (${tmpIdentity} / CAST(:MSLeaf AS INTEGER)) AS "MSBucket", COUNT(*) AS "MSCount", SUM(${tmpIdentity}) AS "MSIDSum" FROM<%= TableName %>${tmpWhere} GROUP BY 1`;
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		return this._read(tmpInfo, tmpQuery, `checksums(${pEntity})`,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpBuckets = {};
				for (let i = 0; i < pRows.length; i++)
				{
					let tmpBucket = String(Math.floor(toNumber(pRows[i].MSBucket)));
					if (!tmpBuckets[tmpBucket])
					{
						tmpBuckets[tmpBucket] = { Count: 0, IDSum: 0 };
					}
					tmpBuckets[tmpBucket].Count += toNumber(pRows[i].MSCount);
					tmpBuckets[tmpBucket].IDSum += toNumber(pRows[i].MSIDSum);
				}
				return fCallback(null, tmpBuckets);
			});
	}

	/**
	 * The WHERE of a live-rows aggregate (§56.4), rendered here (TRIM / CAST forms FoxHound has no
	 * entry for); the configured extra unset values are bound.
	 *
	 * @param {Record<string, any>} pEntityInfo
	 * @param {any} pQuery - receives the binds
	 * @return {string} ' WHERE …' or ''
	 */
	_liveWhere(pEntityInfo, pQuery)
	{
		let tmpParts = [];
		if (pEntityInfo.DeleteColumn)
		{
			tmpParts.push(`${this._quote(pEntityInfo, pEntityInfo.DeleteColumn)} = 0`);
		}
		if (pEntityInfo.TenantColumn)
		{
			let tmpTenant = this._quote(pEntityInfo, pEntityInfo.TenantColumn);
			tmpParts.push(`${tmpTenant} IS NOT NULL`);
			if (pEntityInfo.Dialect === 'PostgreSQL')
			{
				tmpParts.push(pEntityInfo.TenantIsText ? `TRIM(${tmpTenant}) NOT IN ('', '0')` : `${tmpTenant} <> 0`);
			}
			else
			{
				tmpParts.push(`TRIM(CAST(${tmpTenant} AS TEXT)) NOT IN ('', '0')`);
				if (!pEntityInfo.TenantIsText)
				{
					tmpParts.push(`${tmpTenant} <> 0`);
				}
			}
			let tmpScope = this.options.Scope || {};
			let tmpUnset = Array.isArray(tmpScope.UnsetValues) ? tmpScope.UnsetValues : [];
			let tmpExtra = 0;
			tmpUnset.forEach(
				(pValue) =>
				{
					let tmpValue = libRetoldFacetingUtil.normalizeScopeValue(pValue);
					if ((tmpValue === null) || (tmpValue === 0) || (tmpValue === ''))
					{
						// Always unset: already excluded above.
						return;
					}
					if ((pEntityInfo.Dialect === 'PostgreSQL') && ((typeof(tmpValue) === 'number') === pEntityInfo.TenantIsText))
					{
						// A typed PostgreSQL column cannot hold (or compare with) a value of the other kind.
						return;
					}
					let tmpName = `MSUnset${tmpExtra++}`;
					pQuery.query.parameters[tmpName] = tmpValue;
					tmpParts.push(`${tmpTenant} <> :${tmpName}`);
				});
		}
		return (tmpParts.length > 0) ? ` WHERE ${tmpParts.join(' AND ')}` : '';
	}

	/**
	 * The IDs whose source rows match FoxHound filter entries (soft-deleted rows included), keyset-paged;
	 * at most Cap + 1 IDs (more than Cap = the caller collapses to a whole-entity Resync).
	 *
	 * @param {string} pEntity
	 * @param {Array<Record<string, any>>} pFilterEntries - FoxHound filter entries
	 * @param {{ Cap?: number }} pOptions
	 * @param {(pError?: Error, pIDs?: Array<number>) => void} fCallback
	 */
	idsByFilter(pEntity, pFilterEntries, pOptions, fCallback)
	{
		let tmpInfo;
		let tmpEntries;
		try
		{
			tmpInfo = this._entity(pEntity);
			if (!Array.isArray(pFilterEntries))
			{
				throw sourceError('the filter must be an array of FoxHound entries.');
			}
			tmpEntries = pFilterEntries.map(
				(pEntry) =>
				{
					if (!pEntry || (typeof(pEntry) !== 'object') || (FILTER_OPERATORS.indexOf(pEntry.Operator) < 0))
					{
						throw sourceError('a filter entry has an unsupported operator.');
					}
					if ((pEntry.Operator !== '(') && (pEntry.Operator !== ')'))
					{
						let tmpColumn = libRetoldFacetingUtil.stripColumn(pEntry.Column);
						if (!IDENTIFIER_PATTERN.test(tmpColumn))
						{
							throw sourceError('a filter entry column is not an identifier.');
						}
						return { Column: tmpColumn, Operator: pEntry.Operator, Value: pEntry.Value, Connector: (pEntry.Connector === 'OR') ? 'OR' : 'AND' };
					}
					return { Column: '', Operator: pEntry.Operator, Value: '', Connector: (pEntry.Connector === 'OR') ? 'OR' : 'AND' };
				});
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		let tmpCap = ((pOptions && (typeof(pOptions.Cap) === 'number') && (pOptions.Cap > 0)) ? pOptions.Cap : 100000);
		let tmpIDs = [];
		let fPage = (pAfter) =>
		{
			let tmpPage = Math.min(IDS_PAGE, (tmpCap + 1) - tmpIDs.length);
			let tmpQuery;
			try
			{
				tmpQuery = this._query(tmpInfo);
				tmpQuery.setDataElements([ tmpInfo.Identity ]);
				if (tmpEntries.length > 0)
				{
					tmpQuery.addFilter('', '', '(', 'AND');
					tmpEntries.forEach(
						(pEntry, pIndex) =>
						{
							if ((pEntry.Operator === '(') || (pEntry.Operator === ')'))
							{
								tmpQuery.addFilter('', '', pEntry.Operator, pEntry.Connector);
								return;
							}
							tmpQuery.addFilter(pEntry.Column, pEntry.Value, pEntry.Operator, pEntry.Connector, `MSF${pIndex}`);
						});
					tmpQuery.addFilter('', '', ')');
				}
				this._rangeFilters(tmpInfo, tmpQuery, pAfter, null);
				tmpQuery.setSort([ { Column: tmpInfo.Identity, Direction: 'Ascending' } ]);
				tmpQuery.setCap(tmpPage);
			}
			catch (pBuildError)
			{
				return fCallback(pBuildError.SourceError ? pBuildError : sourceError(`could not build the filter read of ${pEntity}.`));
			}
			this._read(tmpInfo, tmpQuery, `idsByFilter(${pEntity})`,
				(pError, pRows) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					let tmpLast = pAfter;
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpID = toID(pRows[i][tmpInfo.Identity]);
						if (tmpID !== null)
						{
							tmpIDs.push(tmpID);
							tmpLast = tmpID;
						}
					}
					if ((pRows.length < tmpPage) || (tmpIDs.length > tmpCap))
					{
						return fCallback(null, tmpIDs);
					}
					return setImmediate(() => { fPage(tmpLast); });
				});
		};
		fPage(null);
	}

	/**
	 * The largest stamp of a column (the source's own text; PostgreSQL with microseconds), or null when
	 * the entity has no stamped row: the Sweep watermark a backfill records before its first page.
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @param {(pError?: Error, pMax?: string|null) => void} fCallback
	 */
	maxStamp(pEntity, pColumn, fCallback)
	{
		let tmpInfo;
		let tmpQuery;
		try
		{
			tmpInfo = this._entity(pEntity);
			if ((typeof(pColumn) !== 'string') || !IDENTIFIER_PATTERN.test(pColumn))
			{
				throw sourceError('the stamp column is not an identifier.');
			}
			tmpQuery = this._query(tmpInfo);
			let tmpColumn = this._quote(tmpInfo, pColumn);
			let tmpExpression = (tmpInfo.Dialect === 'PostgreSQL') ? `to_char(MAX(${tmpColumn}), ${PG_TIMESTAMP_TEXT})` : `MAX(${tmpColumn})`;
			tmpQuery.parameters.queryOverride = `SELECT ${tmpExpression} AS "MSMax" FROM<%= TableName %>`;
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		return this._read(tmpInfo, tmpQuery, `maxStamp(${pEntity})`,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpMax = (pRows[0] && (pRows[0].MSMax !== null) && (pRows[0].MSMax !== undefined)) ? atText(pRows[0].MSMax) : null;
				return fCallback(null, tmpMax);
			});
	}

	/**
	 * A stable fingerprint of the source database the entities are read from (dialect, server, port,
	 * database / file), or null when the connection does not say: the store's owner marker binds it, so
	 * a second deployment pointed at the same ClickHouse database is refused.  Never a credential.
	 *
	 * @param {Array<string>} pEntities
	 * @return {string|null}
	 */
	fingerprint(pEntities)
	{
		let tmpEntities = Array.isArray(pEntities) ? pEntities : [];
		for (let i = 0; i < tmpEntities.length; i++)
		{
			try
			{
				let tmpInfo = this._entity(tmpEntities[i]);
				let tmpProvider = tmpInfo.DAL.provider;
				let tmpConnection = (tmpProvider && (typeof(tmpProvider.getProvider) === 'function')) ? tmpProvider.getProvider() : null;
				let tmpOptions = (tmpConnection && tmpConnection.options && (typeof(tmpConnection.options) === 'object')) ? tmpConnection.options : {};
				let tmpPG = (tmpOptions.PostgreSQL && (typeof(tmpOptions.PostgreSQL) === 'object')) ? tmpOptions.PostgreSQL : {};
				let tmpMaterial =
					[
						tmpInfo.Dialect,
						tmpPG.host || tmpOptions.host || tmpOptions.Server || null,
						tmpPG.port || tmpOptions.port || tmpOptions.Port || null,
						tmpPG.database || tmpOptions.database || tmpOptions.Database || null,
						tmpOptions.SQLiteFilePath || null
					];
				if (tmpMaterial.slice(1).some((pValue) => { return (pValue !== null) && (pValue !== undefined) && (pValue !== ''); }))
				{
					return `sf:${libCrypto.createHash('sha256').update(JSON.stringify(tmpMaterial), 'utf8').digest('hex').slice(0, 16)}`;
				}
			}
			catch (pError)
			{
				// No fingerprint from this entity: try the next.
			}
		}
		return null;
	}

	/**
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	dialect(pEntity)
	{
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.getDialectProfile) !== 'function'))
		{
			return null;
		}
		let tmpProfile = tmpHost.getDialectProfile(pEntity);
		return tmpProfile ? tmpProfile.Name : null;
	}

	/**
	 * Is a raw source row live (§56.4)?  (For the WriterLoop's diff and the support module.)
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pRow
	 * @return {boolean}
	 */
	isLive(pEntity, pRow)
	{
		return this._isLive(this._entity(pEntity), pRow);
	}
}

module.exports = RetoldFacetingMaterializeSourceInProcess;
module.exports.serviceType = 'RetoldFacetingMaterializeSourceInProcess';
module.exports.toID = toID;
module.exports.isZero = isZero;
module.exports.atText = atText;
