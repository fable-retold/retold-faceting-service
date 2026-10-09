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

module.exports = (
	{
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
