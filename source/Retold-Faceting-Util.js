/**
 * Retold Faceting - Util
 *
 * Internal helpers for the server-side (non-contract) services.  Contract code and anything that
 * runs in the browser use source/contract/Facet-Contract-Util.js instead (re-exported here so a
 * service needs one require).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFacetUtil = require('./contract/Facet-Contract-Util.js');
const libFacetRequest = require('./contract/Facet-Contract-Request.js');

/**
 * Hex SHA-1 of a string (model / definition hashes; one implementation for the server services).
 *
 * @param {any} pText
 * @return {string}
 */
const sha1Hex = (pText) =>
{
	return libCrypto.createHash('sha1').update(String(pText), 'utf8').digest('hex');
};

/**
 * Strip a table qualifier and identifier quotes from a FoxHound filter column
 * ('"T"."C"', '`T`.`C`', 'T.C', '[T].[C]' → 'C').
 *
 * @param {any} pColumn
 * @return {string}
 */
const stripColumn = (pColumn) =>
{
	if (typeof(pColumn) !== 'string')
	{
		return '';
	}
	let tmpParts = pColumn.split('.');
	return tmpParts[tmpParts.length - 1].replace(/["`[\]\s]/g, '');
};

/**
 * The table qualifier of a FoxHound filter column ('"T"."C"' → 'T'), or null when unqualified.
 *
 * @param {any} pColumn
 * @return {string|null}
 */
const columnQualifier = (pColumn) =>
{
	if (typeof(pColumn) !== 'string')
	{
		return null;
	}
	let tmpParts = pColumn.split('.');
	return (tmpParts.length > 1) ? tmpParts[tmpParts.length - 2].replace(/["`[\]\s]/g, '') : null;
};

/**
 * Normalize a scope value once, so every comparison agrees: strings are trimmed and a numeric
 * literal becomes a Number ('7', ' 7', '07' → 7) when that is exact; booleans become 0 / 1;
 * finite numbers stay (-0 → 0); anything else (NaN, objects, undefined) is null.
 *
 * @param {any} pValue
 * @return {string|number|null}
 */
const normalizeScopeValue = (pValue) =>
{
	if (typeof(pValue) === 'boolean')
	{
		return pValue ? 1 : 0;
	}
	if (typeof(pValue) === 'number')
	{
		return Number.isFinite(pValue) ? (pValue + 0) : null;
	}
	if (typeof(pValue) === 'bigint')
	{
		return Number.isSafeInteger(Number(pValue)) ? Number(pValue) : String(pValue);
	}
	if (typeof(pValue) !== 'string')
	{
		return null;
	}
	let tmpText = pValue.trim();
	let tmpNumber = libFacetUtil.toFiniteNumber(tmpText);
	if ((tmpNumber !== null) && (!Number.isInteger(tmpNumber) || Number.isSafeInteger(tmpNumber)))
	{
		return tmpNumber + 0;
	}
	return tmpText;
};

/**
 * Is this scope value unset (06 §2.2: unset scope values fail closed)?  Always unset: null,
 * undefined, NaN, '', whitespace, 0 / -0 / '0' / '00', false; plus any configured UnsetValues
 * (compared after normalization).
 *
 * @param {any} pValue
 * @param {Array<any>} [pUnsetValues] - Scope.UnsetValues
 * @return {boolean}
 */
const isUnsetScopeValue = (pValue, pUnsetValues) =>
{
	let tmpValue = normalizeScopeValue(pValue);
	if ((tmpValue === null) || (tmpValue === 0) || (tmpValue === ''))
	{
		return true;
	}
	let tmpUnset = Array.isArray(pUnsetValues) ? pUnsetValues : [];
	for (let i = 0; i < tmpUnset.length; i++)
	{
		if (normalizeScopeValue(tmpUnset[i]) === tmpValue)
		{
			return true;
		}
	}
	return false;
};

// ------------------------------------------------------------------ M4 (internal-contracts §38.5)

// The local change-sequence grammar (internal-contracts §39.1): '<NodeEpoch>:<n>', NodeEpoch 'e:' + 8
// lowercase hex (one per process), n a non-negative safe integer without leading zeros.
// One grammar: the pure request contract owns SEQ_PATTERN (a client validates Freshness.MinSeq with it).
const NODE_EPOCH_PATTERN = /^e:[0-9a-f]{8}$/;
const SEQ_PATTERN = libFacetRequest.SEQ_PATTERN;

/**
 * Parse a Seq ('e:4f0c2b9e:88121') into { Epoch, N }, or null when it does not match SEQ_PATTERN.
 *
 * @param {any} pSeq
 * @return {{ Epoch: string, N: number }|null}
 */
const parseSeq = (pSeq) =>
{
	if ((typeof(pSeq) !== 'string') || !SEQ_PATTERN.test(pSeq))
	{
		return null;
	}
	let tmpIndex = pSeq.lastIndexOf(':');
	let tmpN = parseInt(pSeq.slice(tmpIndex + 1), 10);
	if (!Number.isSafeInteger(tmpN))
	{
		return null;
	}
	return { Epoch: pSeq.slice(0, tmpIndex), N: tmpN };
};

/**
 * Format a Seq from its NodeEpoch and counter.
 *
 * @param {string} pEpoch - 'e:' + 8 hex
 * @param {number} pN
 * @return {string}
 */
const formatSeq = (pEpoch, pN) =>
{
	return `${pEpoch}:${pN}`;
};

/**
 * The stable identity of a principal for read-your-writes tracking, SSE connection limits and logs
 * (internal-contracts §38.5): 'pk:' + 16 hex of sha256 over the canonical { Kind, IDUser, IDCustomer,
 * ScopeValues, RoleSetHash } (every value normalized like a scope value).  Never the SessionID, never
 * ResolvedAt / Source, so the principal built for a write (Host.buildPrincipal over the write's
 * SessionData) and the one resolved for a read of the same session get the same key.
 *
 * @param {Record<string, any>} pPrincipal
 * @return {string|null} null when pPrincipal is not an object
 */
const principalKey = (pPrincipal) =>
{
	if ((typeof(pPrincipal) !== 'object') || (pPrincipal === null) || Array.isArray(pPrincipal))
	{
		return null;
	}
	let tmpScopeValues = {};
	let tmpSource = ((typeof(pPrincipal.ScopeValues) === 'object') && (pPrincipal.ScopeValues !== null)) ? pPrincipal.ScopeValues : {};
	Object.keys(tmpSource).sort().forEach(
		(pColumn) =>
		{
			tmpScopeValues[pColumn] = normalizeScopeValue(tmpSource[pColumn]);
		});
	let tmpMaterial = JSON.stringify(
		[
			(typeof(pPrincipal.Kind) === 'string') ? pPrincipal.Kind : '',
			normalizeScopeValue(pPrincipal.IDUser),
			normalizeScopeValue(pPrincipal.IDCustomer),
			tmpScopeValues,
			(typeof(pPrincipal.RoleSetHash) === 'string') ? pPrincipal.RoleSetHash : ''
		]);
	return `pk:${libCrypto.createHash('sha256').update(tmpMaterial, 'utf8').digest('hex').slice(0, 16)}`;
};

/**
 * The identity of a principal WITHOUT its role set (internal-contracts §71.2, §76.4):
 * principalKey({ …p, RoleSetHash: '' }).  Read-your-writes and the change intake's Actor.PrincipalKey
 * use it, so a write (whose synchronous principal carries no action set) and the same session's reads
 * (which do, on an entitlements host) match whatever their role set.  Identical to principalKey on a
 * host whose RoleSetHash is always ''.  principalKey (with RoleSetHash) stays for SSE revalidation,
 * the cache's By and logs.
 *
 * @param {Record<string, any>} pPrincipal
 * @return {string|null} null when pPrincipal is not an object
 */
const principalIdentityKey = (pPrincipal) =>
{
	if ((typeof(pPrincipal) !== 'object') || (pPrincipal === null) || Array.isArray(pPrincipal))
	{
		return null;
	}
	return principalKey(Object.assign({}, pPrincipal, { RoleSetHash: '' }));
};

module.exports = (
	{
		NODE_EPOCH_PATTERN: NODE_EPOCH_PATTERN,
		SEQ_PATTERN: SEQ_PATTERN,
		parseSeq: parseSeq,
		formatSeq: formatSeq,
		principalKey: principalKey,
		principalIdentityKey: principalIdentityKey,
		isPlainObject: libFacetUtil.isPlainObject,
		hasOwn: libFacetUtil.hasOwn,
		isPresent: libFacetUtil.isPresent,
		toFiniteNumber: libFacetUtil.toFiniteNumber,
		toCount: libFacetUtil.toCount,
		logSafe: libFacetUtil.logSafe,
		stripColumn: stripColumn,
		columnQualifier: columnQualifier,
		sha1Hex: sha1Hex,
		normalizeScopeValue: normalizeScopeValue,
		isUnsetScopeValue: isUnsetScopeValue
	});
