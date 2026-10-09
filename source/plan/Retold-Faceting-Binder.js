/**
 * Retold Faceting - Binder
 *
 * Server-side $-value binding (01 §4.4, 06 §2.3): turns the canonical { Field, Op, Bind } leaves
 * of definitions and named scopes into bound { Field, Op, Value } leaves.
 *
 *   $CurrentUser.IDUser | .IDCustomer | .<Scope.UserRecordFields entry>   ← the Principal ONLY
 *   $Scope.<PolicyColumn>                                                 ← Principal.ScopeValues
 *   $Now | $Today | $StartOf.<day|week|month|quarter|year>               ← pContext.Now floored to Cache.NowBucketMS
 *   $Param.<Name>                                                         ← request Params validated against the declaring scope / facet
 *
 * A client can never supply any of them: clause values are data and are never parsed for '$'.
 * An unset $CurrentUser / $Scope value (Scope.UnsetValues) is 401 FACET_UNAUTHENTICATED.  Every
 * value actually bound is recorded so BindHash covers exactly what the answer depends on.
 *
 * Binding walks the whole canonical tree: column leaves, And / Or, the existence nodes (Exists,
 * NotExists, HavingCount) and every PathPlan step Where inside them, tracking the entity each leaf
 * is evaluated on (the pivot / scope entity at the top, a step's target inside a step Where, the
 * path's last entity inside an existence Where, a TuplePivot side through From / Alias) so a bound
 * value is coerced by its column's DataType exactly like a clause value (ClauseCompiler.coerceValue,
 * element-wise for lists).  The canonical tree (owned by the registry) is never mutated.
 *
 * Contract: internal-contracts §22.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libCrypto = require('crypto');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The token grammar and the param types (internal-contracts §22.2 / §22.3) are the request contract's.
const TOKEN_PATTERN = libFacetRequest.TOKEN_PATTERN;
const PARAM_TYPES = libFacetRequest.PARAM_TYPES;

// $StartOf.<unit> units (the date intervals).
const START_OF_UNITS = Object.freeze([ 'day', 'week', 'month', 'quarter', 'year' ]);

// Default String param length.
const DEFAULT_STRING_MAX_LENGTH = 256;

// The existence node kinds of a canonical / bound predicate.
const EXISTENCE_KINDS = Object.freeze([ 'Exists', 'NotExists', 'HavingCount' ]);

const hasOwn = libFacetUtil.hasOwn;
const isPlainObject = libFacetUtil.isPlainObject;

/**
 * Parse a token string.
 *
 * @param {any} pToken
 * @return {{ Kind: string, Name: string|null }|null} Kind: CurrentUser | Scope | Param | StartOf | Now | Today
 */
const parseToken = (pToken) =>
{
	if (typeof(pToken) !== 'string')
	{
		return null;
	}
	let tmpMatch = TOKEN_PATTERN.exec(pToken);
	if (!tmpMatch)
	{
		return null;
	}
	if (tmpMatch[3])
	{
		return { Kind: tmpMatch[3], Name: null };
	}
	if ((tmpMatch[1] === 'StartOf') && (START_OF_UNITS.indexOf(tmpMatch[2]) < 0))
	{
		return null;
	}
	return { Kind: tmpMatch[1], Name: tmpMatch[2] };
};

/**
 * The canonical 'YYYY-MM-DD HH:mm:ss' (UTC) of an epoch millisecond value.
 *
 * @param {number} pMS
 * @return {string}
 */
const canonicalFromEpoch = (pMS) =>
{
	return new Date(pMS).toISOString().substring(0, 19).replace('T', ' ');
};

// One Intl formatter per IANA zone (building one is the expensive part).
const WALL_CLOCK_FORMATTERS = new Map();

/**
 * The canonical naive wall clock 'YYYY-MM-DD HH:mm:ss' of an instant in an IANA time zone (D-22:
 * stored dates are the wall clock of Time.StorageTimeZone, so $Now / $Today must be too).
 *
 * @param {number} pMS - epoch milliseconds
 * @param {string} [pTimeZone] - default 'UTC'
 * @return {string}
 */
const wallClockIn = (pMS, pTimeZone) =>
{
	if ((typeof(pTimeZone) !== 'string') || (pTimeZone.length < 1) || (pTimeZone === 'UTC') || (pTimeZone === 'Etc/UTC'))
	{
		return canonicalFromEpoch(pMS);
	}
	let tmpFormatter = WALL_CLOCK_FORMATTERS.get(pTimeZone);
	if (!tmpFormatter)
	{
		// Throws RangeError for an unknown zone (the caller turns it into FACET_INTERNAL).
		tmpFormatter = new Intl.DateTimeFormat('en-CA',
			{
				timeZone: pTimeZone, hourCycle: 'h23',
				year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
			});
		WALL_CLOCK_FORMATTERS.set(pTimeZone, tmpFormatter);
	}
	let tmpParts = {};
	tmpFormatter.formatToParts(new Date(pMS)).forEach((pPart) => { tmpParts[pPart.type] = pPart.value; });
	let tmpYear = String(tmpParts.year).padStart(4, '0');
	return `${tmpYear}-${tmpParts.month}-${tmpParts.day} ${tmpParts.hour}:${tmpParts.minute}:${tmpParts.second}`;
};

class RetoldFacetingBinder extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingBinder';
	}

	/**
	 * The resolved options of a context (falls back to this service's).
	 *
	 * @param {Record<string, any>} [pContext]
	 * @return {Record<string, any>}
	 */
	_options(pContext)
	{
		return (pContext && isPlainObject(pContext.Options) && isPlainObject(pContext.Options.Scope)) ? pContext.Options : this.options;
	}

	/**
	 * The BindContext of a request (pure over pContext.Principal, pContext.Now and the options).
	 *
	 * Now is pContext.Now (an ISO instant, pinned once per request; in-process callers may pin it)
	 * floored to Cache.NowBucketMS and written as the canonical naive wall clock in
	 * Time.StorageTimeZone (D-22; Intl converts the instant for a non-UTC zone), so Live, the
	 * Reference and Records all compare against one instant and the bound value equals the hashed
	 * one.  $Today / $StartOf.* are the date keys of that wall clock (so 'today' turns over at the
	 * zone's midnight).
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 / §19.5
	 * @return {Record<string, any>} BindContext (internal-contracts §22.1)
	 */
	context(pContext)
	{
		let tmpContext = isPlainObject(pContext) ? pContext : {};
		let tmpOptions = this._options(tmpContext);
		let tmpPrincipal = isPlainObject(tmpContext.Principal) ? tmpContext.Principal : null;

		let tmpBucketMS = (tmpOptions.Cache && (typeof(tmpOptions.Cache.NowBucketMS) === 'number') && Number.isFinite(tmpOptions.Cache.NowBucketMS) && (tmpOptions.Cache.NowBucketMS >= 1))
			? Math.floor(tmpOptions.Cache.NowBucketMS) : 1000;
		let tmpClock = (typeof(tmpContext.Now) === 'string') ? Date.parse(tmpContext.Now)
			: (typeof(tmpContext.Now) === 'number') ? tmpContext.Now
			: NaN;
		if (!Number.isFinite(tmpClock))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The request clock (pContext.Now) is not set.');
		}
		let tmpFloored = Math.floor(tmpClock / tmpBucketMS) * tmpBucketMS;
		let tmpTimeZone = (tmpOptions.Time && (typeof(tmpOptions.Time.StorageTimeZone) === 'string')) ? tmpOptions.Time.StorageTimeZone : 'UTC';
		let tmpNow;
		try
		{
			tmpNow = wallClockIn(tmpFloored, tmpTimeZone);
		}
		catch (pZoneError)
		{
			this.fable.log.error(`RetoldFaceting Binder: Time.StorageTimeZone ${libFacetUtil.logSafe(tmpTimeZone)} is not a known time zone.`);
			throw libFacetErrors.create('FACET_INTERNAL');
		}
		let tmpStartOf = {};
		for (let i = 0; i < START_OF_UNITS.length; i++)
		{
			tmpStartOf[START_OF_UNITS[i]] = libFacetBuckets.dateKey(tmpNow, START_OF_UNITS[i]);
		}

		// CurrentUser: from Principal.IDUser / IDCustomer / UserRecord ONLY (never the request).
		let tmpCurrentUser = {};
		let tmpUserRecordFields = Array.isArray(tmpOptions.Scope.UserRecordFields) ? tmpOptions.Scope.UserRecordFields : [];
		let tmpUserRecord = (tmpPrincipal && isPlainObject(tmpPrincipal.UserRecord)) ? tmpPrincipal.UserRecord : {};
		for (let i = 0; i < tmpUserRecordFields.length; i++)
		{
			let tmpField = tmpUserRecordFields[i];
			if ((typeof(tmpField) === 'string') && (tmpField !== 'IDUser') && (tmpField !== 'IDCustomer'))
			{
				tmpCurrentUser[tmpField] = hasOwn(tmpUserRecord, tmpField) ? libRetoldFacetingUtil.normalizeScopeValue(tmpUserRecord[tmpField]) : null;
			}
		}
		tmpCurrentUser.IDUser = tmpPrincipal ? libRetoldFacetingUtil.normalizeScopeValue(tmpPrincipal.IDUser) : null;
		tmpCurrentUser.IDCustomer = tmpPrincipal ? libRetoldFacetingUtil.normalizeScopeValue(tmpPrincipal.IDCustomer) : null;

		let tmpScope = {};
		let tmpScopeValues = (tmpPrincipal && isPlainObject(tmpPrincipal.ScopeValues)) ? tmpPrincipal.ScopeValues : {};
		Object.keys(tmpScopeValues).forEach((pColumn) => { tmpScope[pColumn] = libRetoldFacetingUtil.normalizeScopeValue(tmpScopeValues[pColumn]); });

		return (
			{
				Principal: tmpPrincipal,
				CurrentUser: tmpCurrentUser,
				Scope: tmpScope,
				Now: tmpNow,
				Today: tmpStartOf.day,
				StartOf: tmpStartOf,
				NowBucketMS: tmpBucketMS,
				UserRecordFields: tmpUserRecordFields.filter((pField) => { return (typeof(pField) === 'string'); }),
				UnsetValues: Array.isArray(tmpOptions.Scope.UnsetValues) ? tmpOptions.Scope.UnsetValues.slice() : [ 0, '', null ],
				Used: new Map()
			});
	}

	/**
	 * A FACET_PARAM_INVALID error (the Detail never carries the value).
	 *
	 * @param {Record<string, any>} pOwner - { Scope } | { Facet }
	 * @param {string|null} pParam
	 * @param {string} pReason - Unknown | Required | Type | NotAllowed | Range
	 * @return {Error}
	 */
	_paramError(pOwner, pParam, pReason)
	{
		let tmpDetail = {};
		if (pOwner && (typeof(pOwner.Scope) === 'string'))
		{
			tmpDetail.Scope = pOwner.Scope;
		}
		if (pOwner && (typeof(pOwner.Facet) === 'string'))
		{
			tmpDetail.Facet = pOwner.Facet;
		}
		tmpDetail.Param = (typeof(pParam) === 'string') ? pParam.substring(0, 64) : null;
		tmpDetail.Reason = pReason;
		return libFacetErrors.create('FACET_PARAM_INVALID', null, tmpDetail);
	}

	/**
	 * Coerce one param value by its declared type.
	 *
	 * @param {string} pName
	 * @param {Record<string, any>} pDeclaration - { Type, Values?, Min?, Max?, MaxLength? }
	 * @param {any} pValue
	 * @param {Record<string, any>} pOwner
	 * @return {any}
	 */
	_coerceParam(pName, pDeclaration, pValue, pOwner)
	{
		let tmpMaxInList = (this.options.Limits && (typeof(this.options.Limits.MaxInList) === 'number')) ? this.options.Limits.MaxInList : 1000;
		let fInteger = (pItem) =>
		{
			let tmpNumber = (typeof(pItem) === 'number') ? pItem
				: (typeof(pItem) === 'string') ? libFacetUtil.toFiniteNumber(pItem.trim())
				: null;
			if ((tmpNumber === null) || !Number.isSafeInteger(tmpNumber))
			{
				// Safe integers only: 1e300 or 99999999999999999999 is a client error, never a
				// statement that fails on the database.
				throw this._paramError(pOwner, pName, 'Type');
			}
			if (((typeof(pDeclaration.Min) === 'number') && (tmpNumber < pDeclaration.Min)) || ((typeof(pDeclaration.Max) === 'number') && (tmpNumber > pDeclaration.Max)))
			{
				throw this._paramError(pOwner, pName, 'Range');
			}
			return tmpNumber;
		};
		let fMember = (pItem) =>
		{
			if ((typeof(pItem) !== 'string') && (typeof(pItem) !== 'number') && (typeof(pItem) !== 'boolean'))
			{
				throw this._paramError(pOwner, pName, 'Type');
			}
			let tmpValues = Array.isArray(pDeclaration.Values) ? pDeclaration.Values : [];
			// Members compare exactly (a definition's Values are its vocabulary).
			if (tmpValues.indexOf(pItem) < 0)
			{
				throw this._paramError(pOwner, pName, 'NotAllowed');
			}
			return pItem;
		};
		let fList = (fItem, pDistinct) =>
		{
			if (!Array.isArray(pValue) || (pValue.length < 1))
			{
				throw this._paramError(pOwner, pName, 'Type');
			}
			if (pValue.length > tmpMaxInList)
			{
				throw this._paramError(pOwner, pName, 'Range');
			}
			let tmpResult = [];
			for (let i = 0; i < pValue.length; i++)
			{
				let tmpItem = fItem(pValue[i]);
				if (tmpResult.indexOf(tmpItem) >= 0)
				{
					if (pDistinct)
					{
						throw this._paramError(pOwner, pName, 'Type');
					}
					continue;
				}
				tmpResult.push(tmpItem);
			}
			return tmpResult;
		};

		switch (pDeclaration.Type)
		{
			case 'Enum':
				if (Array.isArray(pValue))
				{
					throw this._paramError(pOwner, pName, 'Type');
				}
				return fMember(pValue);
			case 'EnumList':
				return fList(fMember, true);
			case 'Integer':
				if (Array.isArray(pValue))
				{
					throw this._paramError(pOwner, pName, 'Type');
				}
				return fInteger(pValue);
			case 'IntegerList':
				return fList(fInteger, false);
			case 'String':
			{
				if (typeof(pValue) !== 'string')
				{
					throw this._paramError(pOwner, pName, 'Type');
				}
				let tmpMaxLength = ((typeof(pDeclaration.MaxLength) === 'number') && (pDeclaration.MaxLength >= 0)) ? pDeclaration.MaxLength : DEFAULT_STRING_MAX_LENGTH;
				if (pValue.length > tmpMaxLength)
				{
					throw this._paramError(pOwner, pName, 'Range');
				}
				if (libFacetClauses.TILDE_PATTERN.test(pValue))
				{
					throw this._paramError(pOwner, pName, 'NotAllowed');
				}
				return pValue;
			}
			case 'Boolean':
				if ((pValue === true) || (pValue === 1) || (pValue === '1') || (pValue === 'true'))
				{
					return 1;
				}
				if ((pValue === false) || (pValue === 0) || (pValue === '0') || (pValue === 'false'))
				{
					return 0;
				}
				throw this._paramError(pOwner, pName, 'Type');
			case 'DateTime':
			{
				let tmpCanonical = (typeof(pValue) === 'string') ? libFacetBuckets.canonicalDateTime(pValue) : null;
				if (tmpCanonical === null)
				{
					throw this._paramError(pOwner, pName, 'Type');
				}
				return tmpCanonical;
			}
			default:
				// A declaration the registry should have refused at load.
				throw libFacetErrors.create('FACET_INTERNAL', 'A parameter declaration has an unknown type.');
		}
	}

	/**
	 * Validate request Params against a declared Params schema (defaults applied).
	 *
	 * Unknown name → 'Unknown'; missing (absent or null) without Default → 'Required'; wrong type →
	 * 'Type'; not in Values → 'NotAllowed'; out of range → 'Range' (internal-contracts §22.3).
	 * Defaults go through the same coercion (a default the coercion refuses is a definition bug:
	 * FACET_INTERNAL).
	 *
	 * @param {Record<string, any>} pSchema - { Name: { Type, Values?, Default?, Min?, Max?, MaxLength? } }
	 * @param {Record<string, any>} pValues - the request's values (may be undefined)
	 * @param {{ Scope?: string, Facet?: string }} pOwner - for error Detail
	 * @return {Record<string, any>} validated values (throws 400 FACET_PARAM_INVALID)
	 */
	validateParams(pSchema, pValues, pOwner)
	{
		let tmpSchema = isPlainObject(pSchema) ? pSchema : {};
		if ((pValues !== null) && (typeof(pValues) !== 'undefined') && !isPlainObject(pValues))
		{
			throw this._paramError(pOwner, null, 'Type');
		}
		let tmpValues = isPlainObject(pValues) ? pValues : {};
		let tmpNames = Object.keys(tmpValues);
		for (let i = 0; i < tmpNames.length; i++)
		{
			if (!hasOwn(tmpSchema, tmpNames[i]) || !isPlainObject(tmpSchema[tmpNames[i]]))
			{
				throw this._paramError(pOwner, tmpNames[i], 'Unknown');
			}
		}
		let tmpResult = {};
		let tmpDeclared = Object.keys(tmpSchema).sort();
		for (let i = 0; i < tmpDeclared.length; i++)
		{
			let tmpName = tmpDeclared[i];
			let tmpDeclaration = tmpSchema[tmpName];
			if (!isPlainObject(tmpDeclaration))
			{
				continue;
			}
			let tmpValue = hasOwn(tmpValues, tmpName) ? tmpValues[tmpName] : undefined;
			if ((tmpValue === null) || (typeof(tmpValue) === 'undefined'))
			{
				if (!hasOwn(tmpDeclaration, 'Default') || (tmpDeclaration.Default === null) || (typeof(tmpDeclaration.Default) === 'undefined'))
				{
					throw this._paramError(pOwner, tmpName, 'Required');
				}
				try
				{
					tmpResult[tmpName] = this._coerceParam(tmpName, tmpDeclaration, tmpDeclaration.Default, pOwner);
				}
				catch (pDefaultError)
				{
					this.fable.log.error(`RetoldFaceting Binder: the declared Default of param [${tmpName}] is not valid for its type.`);
					throw libFacetErrors.create('FACET_INTERNAL');
				}
				continue;
			}
			tmpResult[tmpName] = this._coerceParam(tmpName, tmpDeclaration, tmpValue, pOwner);
		}
		return tmpResult;
	}

	/**
	 * The raw value of a token (before column coercion).  Unset principal values fail closed (401).
	 *
	 * @param {string} pToken
	 * @param {Record<string, any>} pBindContext
	 * @param {Record<string, any>} pParams - validated params of the owner
	 * @param {string|null} pOwner
	 * @return {{ Key: string, Value: any, Principal: boolean }}
	 */
	tokenValue(pToken, pBindContext, pParams, pOwner)
	{
		let tmpParsed = parseToken(pToken);
		if (!tmpParsed)
		{
			// Tokens are validated at definition load; reaching here is a bug.
			this.fable.log.error(`RetoldFaceting Binder: an invalid token reached binding (${libFacetUtil.logSafe(pToken)}).`);
			throw libFacetErrors.create('FACET_INTERNAL');
		}
		let tmpUnsetValues = Array.isArray(pBindContext.UnsetValues) ? pBindContext.UnsetValues : (this.options.Scope.UnsetValues || []);
		let fPrincipalValue = (pValue) =>
		{
			if (libRetoldFacetingUtil.isUnsetScopeValue(pValue, tmpUnsetValues))
			{
				// Fail closed: never "matches nothing" (internal-contracts §22.4).  No Detail.
				this.fable.log.warn(`RetoldFaceting Binder: ${pToken} is unset for this principal; refusing the request.`);
				throw libFacetErrors.create('FACET_UNAUTHENTICATED');
			}
			return pValue;
		};
		switch (tmpParsed.Kind)
		{
			case 'CurrentUser':
			{
				let tmpCurrentUser = isPlainObject(pBindContext.CurrentUser) ? pBindContext.CurrentUser : {};
				let tmpAllowed = (tmpParsed.Name === 'IDUser') || (tmpParsed.Name === 'IDCustomer')
					|| (Array.isArray(pBindContext.UserRecordFields) && (pBindContext.UserRecordFields.indexOf(tmpParsed.Name) >= 0));
				if (!tmpAllowed || !hasOwn(tmpCurrentUser, tmpParsed.Name))
				{
					this.fable.log.error(`RetoldFaceting Binder: ${pToken} is not a whitelisted user record field (Scope.UserRecordFields).`);
					throw libFacetErrors.create('FACET_INTERNAL');
				}
				return { Key: pToken, Value: fPrincipalValue(tmpCurrentUser[tmpParsed.Name]), Principal: true };
			}
			case 'Scope':
			{
				let tmpScope = isPlainObject(pBindContext.Scope) ? pBindContext.Scope : {};
				if (!hasOwn(tmpScope, tmpParsed.Name))
				{
					this.fable.log.error(`RetoldFaceting Binder: ${pToken} does not name a policy column.`);
					throw libFacetErrors.create('FACET_INTERNAL');
				}
				return { Key: pToken, Value: fPrincipalValue(tmpScope[tmpParsed.Name]), Principal: true };
			}
			case 'Now':
				return { Key: pToken, Value: pBindContext.Now, Principal: false };
			case 'Today':
				return { Key: pToken, Value: pBindContext.Today, Principal: false };
			case 'StartOf':
				return { Key: pToken, Value: pBindContext.StartOf[tmpParsed.Name], Principal: false };
			case 'Param':
			{
				let tmpParams = isPlainObject(pParams) ? pParams : {};
				if (!hasOwn(tmpParams, tmpParsed.Name))
				{
					this.fable.log.error(`RetoldFaceting Binder: ${pToken} is not declared by ${libFacetUtil.logSafe(pOwner)}.`);
					throw libFacetErrors.create('FACET_INTERNAL');
				}
				return { Key: `$Param:${(typeof(pOwner) === 'string') ? pOwner : ''}.${tmpParsed.Name}`, Value: tmpParams[tmpParsed.Name], Principal: false, Param: tmpParsed.Name };
			}
			default:
				throw libFacetErrors.create('FACET_INTERNAL');
		}
	}

	/**
	 * Coerce a bound value for the column it compares against.
	 *
	 * @param {string|null} pEntity
	 * @param {string} pField
	 * @param {string} pOp
	 * @param {any} pValue
	 * @param {Record<string, any>} pToken - tokenValue() result
	 * @param {Record<string, any>} pOwnerDetail
	 * @return {any}
	 */
	_coerceBound(pEntity, pField, pOp, pValue, pToken, pOwnerDetail)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpCompiler = this.fable.RetoldFacetingClauseCompiler;
		let tmpColumn = ((typeof(pEntity) === 'string') && tmpCatalog && (typeof(tmpCatalog.column) === 'function')) ? tmpCatalog.column(pEntity, pField) : null;
		let tmpList = (pOp === 'IN') || (pOp === 'NIN');
		let tmpValues = Array.isArray(pValue) ? pValue.slice() : [ pValue ];
		if (!tmpList && Array.isArray(pValue))
		{
			// A list param under a scalar op is refused at load ('ParamShape').
			throw libFacetErrors.create('FACET_INTERNAL', 'A list value is bound under a scalar operator.');
		}
		let tmpCoerced = tmpValues;
		if (tmpColumn && tmpCompiler && (typeof(tmpCompiler.coerceValue) === 'function'))
		{
			try
			{
				tmpCoerced = tmpValues.map((pItem) => { return tmpCompiler.coerceValue(Object.assign({ Column: pField }, tmpColumn), pItem); });
			}
			catch (pCoerceError)
			{
				if (pToken.Param)
				{
					throw this._paramError(pOwnerDetail, pToken.Param, 'Type');
				}
				if (pToken.Principal)
				{
					// A principal value the column cannot hold: fail closed.
					this.fable.log.warn(`RetoldFaceting Binder: a principal value cannot be compared with ${pEntity}.${pField}; refusing the request.`);
					throw libFacetErrors.create('FACET_UNAUTHENTICATED');
				}
				throw libFacetErrors.create('FACET_INTERNAL', 'A bound value cannot be coerced for its column.');
			}
		}
		if (tmpList)
		{
			let tmpSeen = new Set();
			return tmpCoerced.filter(
				(pItem) =>
				{
					let tmpSignature = typeof(pItem) + ':' + String(pItem);
					if (tmpSeen.has(tmpSignature))
					{
						return false;
					}
					tmpSeen.add(tmpSignature);
					return true;
				});
		}
		return tmpCoerced[0];
	}

	/**
	 * Bind a canonical predicate (and every step Where inside its PathPlans).
	 *
	 * pOptions (additive to the contract signature): Entity — the entity the top-level leaves are
	 * evaluated on (the pivot / scope entity), Sides — { <tuple side name>: Entity } for TuplePivot
	 * definitions, Owner — the declaring scope / facet name (keys '$Param:<Owner>.<Name>' in Used and
	 * the Scope / Facet of a FACET_PARAM_INVALID Detail), OwnerKind — 'Scope' | 'Facet'.
	 *
	 * @param {Record<string, any>} pPred - CanonicalPred (internal-contracts §20.7)
	 * @param {Record<string, any>} pBindContext
	 * @param {Record<string, any>} pParams - validated params of the declaring scope / facet
	 * @param {{ Entity?: string, Sides?: Record<string, string>, Owner?: string, OwnerKind?: string }} [pOptions]
	 * @return {Record<string, any>} bound Pred (internal-contracts §23.2); throws 401 / 400
	 */
	bind(pPred, pBindContext, pParams, pOptions)
	{
		if ((pPred === null) || (typeof(pPred) === 'undefined'))
		{
			return null;
		}
		if (!isPlainObject(pBindContext))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Binding needs a BindContext.');
		}
		let tmpOptions = isPlainObject(pOptions) ? pOptions : {};
		let tmpState =
			{
				Context: pBindContext,
				Params: isPlainObject(pParams) ? pParams : {},
				Owner: (typeof(tmpOptions.Owner) === 'string') ? tmpOptions.Owner : null,
				OwnerDetail: (tmpOptions.OwnerKind === 'Facet') ? { Facet: tmpOptions.Owner } : { Scope: tmpOptions.Owner },
				Sides: isPlainObject(tmpOptions.Sides) ? tmpOptions.Sides : {}
			};
		return this._bindNode(pPred, (typeof(tmpOptions.Entity) === 'string') ? tmpOptions.Entity : null, tmpState);
	}

	/**
	 * @param {Record<string, any>} pNode
	 * @param {string|null} pEntity - the entity leaves of this node are evaluated on
	 * @param {Record<string, any>} pState
	 * @return {Record<string, any>}
	 */
	_bindNode(pNode, pEntity, pState)
	{
		if (!isPlainObject(pNode))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Binding: malformed predicate node.');
		}
		if (Array.isArray(pNode.And) || Array.isArray(pNode.Or))
		{
			let tmpKind = Array.isArray(pNode.And) ? 'And' : 'Or';
			let tmpResult = {};
			tmpResult[tmpKind] = pNode[tmpKind].map((pChild) => { return this._bindNode(pChild, pEntity, pState); });
			return tmpResult;
		}
		for (let i = 0; i < EXISTENCE_KINDS.length; i++)
		{
			let tmpKind = EXISTENCE_KINDS[i];
			if (isPlainObject(pNode[tmpKind]))
			{
				let tmpResult = {};
				tmpResult[tmpKind] = this._bindExistence(tmpKind, pNode[tmpKind], pEntity, pState);
				return tmpResult;
			}
		}
		// A column leaf.
		let tmpEntity = pEntity;
		let tmpField = pNode.Field;
		if ((typeof(pNode.Alias) === 'string') && hasOwn(pState.Sides, pNode.Alias))
		{
			tmpEntity = pState.Sides[pNode.Alias];
		}
		else if ((typeof(tmpField) === 'string') && (tmpField.indexOf('.') > 0))
		{
			let tmpAlias = tmpField.substring(0, tmpField.indexOf('.'));
			if (hasOwn(pState.Sides, tmpAlias))
			{
				tmpEntity = pState.Sides[tmpAlias];
				tmpField = tmpField.substring(tmpField.indexOf('.') + 1);
			}
		}
		if (!hasOwn(pNode, 'Bind'))
		{
			return Object.assign({}, pNode);
		}
		if (hasOwn(pNode, 'Value'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Binding: a leaf has both a Value and a Bind.');
		}
		let tmpToken = this.tokenValue(pNode.Bind, pState.Context, pState.Params, pState.Owner);
		let tmpValue = this._coerceBound(tmpEntity, tmpField, pNode.Op, tmpToken.Value, tmpToken, pState.OwnerDetail);
		this.recordUsed(pState.Context, tmpToken.Key, tmpToken.Value);
		let tmpLeaf = {};
		Object.keys(pNode).forEach(
			(pKey) =>
			{
				if (pKey !== 'Bind')
				{
					tmpLeaf[pKey] = pNode[pKey];
				}
			});
		tmpLeaf.Value = tmpValue;
		return tmpLeaf;
	}

	/**
	 * Bind an existence node (its Path step Wheres on each step's target, its Where on Path.To).
	 *
	 * @param {string} pKind
	 * @param {Record<string, any>} pBody
	 * @param {string|null} pEntity
	 * @param {Record<string, any>} pState
	 * @return {Record<string, any>}
	 */
	_bindExistence(pKind, pBody, pEntity, pState)
	{
		let tmpResult = Object.assign({}, pBody);
		let tmpPath = isPlainObject(pBody.Path) ? pBody.Path : null;
		if (tmpPath)
		{
			let tmpSteps = Array.isArray(tmpPath.Steps) ? tmpPath.Steps : [];
			tmpResult.Path = Object.assign({}, tmpPath,
				{
					Steps: tmpSteps.map(
						(pStep) =>
						{
							let tmpStep = Object.assign({}, pStep);
							if ((pStep.Where !== null) && (typeof(pStep.Where) !== 'undefined'))
							{
								tmpStep.Where = this._bindNode(pStep.Where, (typeof(pStep.To) === 'string') ? pStep.To : null, pState);
							}
							if (Array.isArray(pStep.On))
							{
								tmpStep.On = pStep.On.map((pPair) => { return Array.isArray(pPair) ? pPair.slice() : pPair; });
							}
							return tmpStep;
						})
				});
		}
		if ((pBody.Where !== null) && (typeof(pBody.Where) !== 'undefined'))
		{
			tmpResult.Where = this._bindNode(pBody.Where, (tmpPath && (typeof(tmpPath.To) === 'string')) ? tmpPath.To : null, pState);
		}
		if (Array.isArray(pBody.Correlate))
		{
			tmpResult.Correlate = pBody.Correlate.map((pPair) => { return isPlainObject(pPair) ? Object.assign({}, pPair, { Outer: Object.assign({}, pPair.Outer) }) : pPair; });
		}
		if ((pKind === 'HavingCount') && hasOwn(pBody, 'Bind'))
		{
			let tmpToken = this.tokenValue(pBody.Bind, pState.Context, pState.Params, pState.Owner);
			let tmpNumber = libFacetUtil.toFiniteNumber(tmpToken.Value);
			if ((tmpNumber === null) || !Number.isInteger(tmpNumber))
			{
				throw (tmpToken.Param ? this._paramError(pState.OwnerDetail, tmpToken.Param, 'Type') : libFacetErrors.create('FACET_INTERNAL'));
			}
			this.recordUsed(pState.Context, tmpToken.Key, tmpToken.Value);
			delete tmpResult.Bind;
			tmpResult.Value = tmpNumber;
		}
		return tmpResult;
	}

	/**
	 * Record one bound value in BindContext.Used (internal-contracts §22.5).  Every distinct value a
	 * token key takes in the request is kept: the first under the key itself, later DIFFERENT values
	 * under '<key>#2', '<key>#3', … (a scope referenced twice with different Params binds both), so
	 * BindHash covers every value the answer depends on.  Repeating the same value adds nothing.
	 *
	 * @param {Record<string, any>} pBindContext
	 * @param {string} pKey
	 * @param {any} pValue
	 */
	recordUsed(pBindContext, pKey, pValue)
	{
		if (!pBindContext || !(pBindContext.Used instanceof Map))
		{
			return;
		}
		let tmpValue = Array.isArray(pValue) ? pValue.slice() : pValue;
		let tmpCanonical = libFacetClauses.canonicalJSON(tmpValue);
		let tmpKey = pKey;
		for (let i = 2; pBindContext.Used.has(tmpKey); i++)
		{
			if (libFacetClauses.canonicalJSON(pBindContext.Used.get(tmpKey)) === tmpCanonical)
			{
				return;
			}
			tmpKey = `${pKey}#${i}`;
		}
		pBindContext.Used.set(tmpKey, tmpValue);
	}

	/**
	 * Every token a canonical tree binds (sorted, unique; '$Param.<Name>' as written).
	 *
	 * @param {Record<string, any>} pPred
	 * @return {Array<string>}
	 */
	tokensOf(pPred)
	{
		let tmpTokens = {};
		let fWalk = (pNode) =>
		{
			if (Array.isArray(pNode))
			{
				pNode.forEach(fWalk);
				return;
			}
			if (!isPlainObject(pNode))
			{
				return;
			}
			if (typeof(pNode.Bind) === 'string')
			{
				tmpTokens[pNode.Bind] = true;
			}
			Object.keys(pNode).forEach((pKey) => { if (pKey !== 'Bind') { fWalk(pNode[pKey]); } });
		};
		fWalk(pPred);
		return Object.keys(tmpTokens).sort();
	}

	/**
	 * @param {Record<string, any>} pBindContext
	 * @return {string} 'b:' + 16 hex over the canonical vector of every value bound so far
	 */
	bindHash(pBindContext)
	{
		let tmpVector = [];
		if (pBindContext && (pBindContext.Used instanceof Map))
		{
			let tmpTokens = Array.from(pBindContext.Used.keys()).sort();
			for (let i = 0; i < tmpTokens.length; i++)
			{
				tmpVector.push([ tmpTokens[i], pBindContext.Used.get(tmpTokens[i]) ]);
			}
		}
		return 'b:' + libCrypto.createHash('sha256').update(libFacetClauses.canonicalJSON(tmpVector)).digest('hex').substring(0, 16);
	}
}

module.exports = RetoldFacetingBinder;
module.exports.serviceType = 'RetoldFacetingBinder';
module.exports.TOKEN_PATTERN = TOKEN_PATTERN;
module.exports.PARAM_TYPES = PARAM_TYPES;
module.exports.START_OF_UNITS = START_OF_UNITS;
module.exports.parseToken = parseToken;
module.exports.wallClockIn = wallClockIn;
