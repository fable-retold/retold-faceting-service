/**
 * ClickHouse-TypeMap — catalog DataType → mirror column type, and source value → store value with
 * the date / integer / decimal parity rules of internal-contracts §56.3.
 *
 *   mirrorType(pColumnInfo, pRole)                       → 'Int64' | 'Nullable(Int64)' | 'Nullable(Float64)' | 'Nullable(String)'
 *                                                          | "Nullable(DateTime64(3, 'UTC'))" | 'Nullable(UInt8)' | null (not mirrored)
 *   baseType(pMirrorType) / paramType(pMirrorType)       → the type without Nullable(…) (a {name:Type} parameter type)
 *   isNullableType(pMirrorType)                          → boolean
 *   toStoreValue(pColumnInfo, pValue, pSourceDialect)    → { Value, Lossy: null | 'Compare' | 'Value' }
 *   toStoreRow(pSpec, pSourceRow, pSourceDialect)        → { Row, Lossy: { Column: … }, Quarantined: false | '<reason>' }
 *   fromStoreValue(pMirrorType, pValue)                  → the value as the engines compare it
 *   canonicalDateLiteral(pValue, pOperator, pSourceDialect) → { Literal } | { Refused: 'DateLiteral' }   (§63.3)
 *
 * Helpers for the write side (the WriterLoop, the support loader):
 *
 *   isLive(pSpec, pSourceRow)                            → the source row is live (§56.4: delete column exactly 0)
 *   keyOf(pSpec, pStoreRow)                              → { <sort-key scope column>: value } (the keymap Key)
 *   trackedOf(pSpec, pStoreRow)                          → { <TrackedKeyColumn>: value }
 *   keyString(pSpec, pKey)                               → a canonical string of a Key (equal keys ⇔ equal strings)
 *
 * Store values are what a JSONEachRow insert carries and what a FORMAT JSON read returns (after the
 * client's 64-bit normalization): Int64 / UInt8 as JS numbers, Float64 as JS numbers, String as JS
 * strings, DateTime64(3) as 'YYYY-MM-DD HH:mm:ss.SSS' text, NULL as null — so a value written and a
 * value read back compare with ===.
 *
 * A pure module: requires only source/contract/* (and nothing else), so it moves with the client.
 *
 * Contract: internal-contracts §56.3.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetBuckets = require('../../contract/Facet-Contract-Buckets.js');
const libFacetUtil = require('../../contract/Facet-Contract-Util.js');

// Bumped whenever a mapping changes (it is part of every SpecHash, §55.2 rule 4).
const TYPE_MAP_VERSION = 1;

// DateTime64's range on 24.8 (values outside are clamped silently by ClickHouse, so they are Lossy).
const DATETIME_MIN = '1900-01-01 00:00:00';
const DATETIME_MAX = '2299-12-31 23:59:59';

const NULLABLE_PATTERN = /^Nullable\((.*)\)$/;

// The mirror type names (base types).
const TYPE_INT64 = 'Int64';
const TYPE_UINT8 = 'UInt8';
const TYPE_FLOAT64 = 'Float64';
const TYPE_STRING = 'String';
const TYPE_DATETIME = "DateTime64(3, 'UTC')";

// Catalog DataTypes by class.
const INTEGER_DATATYPES = Object.freeze([ 'ID', 'ForeignKey', 'Numeric', 'Integer', 'AutoIdentity' ]);
const DECIMAL_DATATYPES = Object.freeze([ 'Decimal', 'Float', 'Double' ]);
const STRING_DATATYPES = Object.freeze([ 'String' ]);
const NEVER_MIRRORED_DATATYPES = Object.freeze([ 'Text', 'JSON', 'JSONProxy' ]);

// An integer literal (no sign other than '-', no whitespace, no fraction).
const INTEGER_LITERAL_PATTERN = /^-?\d+$/;
// A plain decimal numeric literal ('12', '-0.5', '.5', '1e3'); no whitespace.
const NUMERIC_LITERAL_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// The fractional seconds of a date text ('2023-01-01 10:00:00.5', '…T10:00:00.123456Z').
const FRACTION_PATTERN = /:\d{2}\.(\d+)/;
// The canonical stored text 'YYYY-MM-DD HH:mm:ss' and a day-only literal 'YYYY-MM-DD'.
const CANONICAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DAY_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Significant digits a decimal text may carry and still round-trip through a double (DBL_DIG).
const MAX_SIGNIFICANT_DIGITS = 15;

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);

// Operators under which a day-only literal compares identically as text (SQLite) and as a timestamp.
const DAY_ONLY_SAFE_OPERATORS = Object.freeze([ '>=', '<' ]);

/**
 * @param {string} pMirrorType
 * @return {boolean}
 */
const isNullableType = (pMirrorType) =>
{
	return (typeof(pMirrorType) === 'string') && NULLABLE_PATTERN.test(pMirrorType);
};

/**
 * The type without its Nullable(…) wrapper.
 *
 * @param {string} pMirrorType
 * @return {string}
 */
const baseType = (pMirrorType) =>
{
	let tmpMatch = (typeof(pMirrorType) === 'string') ? NULLABLE_PATTERN.exec(pMirrorType) : null;
	return tmpMatch ? tmpMatch[1] : pMirrorType;
};

/**
 * The {name:Type} parameter type of a scalar compared with this column.
 *
 * @param {string} pMirrorType
 * @return {string}
 */
const paramType = (pMirrorType) =>
{
	return baseType(pMirrorType);
};

/**
 * The base mirror type of a catalog column (null: not mirrored).
 *
 * @param {Record<string, any>} pColumnInfo
 * @return {string|null}
 */
const baseTypeOf = (pColumnInfo) =>
{
	if (!libFacetUtil.isPlainObject(pColumnInfo))
	{
		return null;
	}
	let tmpDataType = (typeof(pColumnInfo.DataType) === 'string') ? pColumnInfo.DataType : null;
	if (!tmpDataType || (NEVER_MIRRORED_DATATYPES.indexOf(tmpDataType) >= 0))
	{
		return null;
	}
	if (tmpDataType === 'Boolean')
	{
		return TYPE_UINT8;
	}
	if (tmpDataType === 'DateTime')
	{
		return TYPE_DATETIME;
	}
	if ((tmpDataType === 'GUID') || (STRING_DATATYPES.indexOf(tmpDataType) >= 0))
	{
		return TYPE_STRING;
	}
	if (DECIMAL_DATATYPES.indexOf(tmpDataType) >= 0)
	{
		return TYPE_FLOAT64;
	}
	if (INTEGER_DATATYPES.indexOf(tmpDataType) >= 0)
	{
		// A Numeric the catalog says is not an integer is a decimal.
		return (pColumnInfo.IsInteger === false) ? TYPE_FLOAT64 : TYPE_INT64;
	}
	return null;
};

/**
 * The mirror column type of a catalog column in a role (§56.3): the identity and the tenant sort-key
 * column are never Nullable; every other column (the owner sort-key column included, under
 * allow_nullable_key = 1) is.
 *
 * @param {Record<string, any>} pColumnInfo - a catalog ColumnInfo (§11.1) or a spec column ({ DataType, IsInteger })
 * @param {string} [pRole] - the spec role ('Identity' | 'Tenant' | 'Owner' | …)
 * @return {string|null}
 */
const mirrorType = (pColumnInfo, pRole) =>
{
	let tmpBase = baseTypeOf(pColumnInfo);
	if (!tmpBase)
	{
		return null;
	}
	if (pRole === 'Identity')
	{
		// The identity is always Int64 (a non-integer identity cannot be mirrored).
		return (tmpBase === TYPE_INT64) ? TYPE_INT64 : null;
	}
	if (pRole === 'Tenant')
	{
		return tmpBase;
	}
	return `Nullable(${tmpBase})`;
};

/**
 * The base type a value converts to: from a spec column's Mirror when present, else from its catalog
 * DataType.
 *
 * @param {Record<string, any>} pColumnInfo
 * @return {string|null}
 */
const valueTypeOf = (pColumnInfo) =>
{
	if (libFacetUtil.isPlainObject(pColumnInfo) && (typeof(pColumnInfo.Mirror) === 'string'))
	{
		return baseType(pColumnInfo.Mirror);
	}
	return baseTypeOf(pColumnInfo);
};

/**
 * Significant digits of a decimal literal (leading and trailing zeros do not count).
 *
 * @param {string} pText - matches NUMERIC_LITERAL_PATTERN
 * @return {number}
 */
const significantDigits = (pText) =>
{
	let tmpMantissa = pText.replace(/^[+-]/, '').replace(/[eE].*$/, '').replace('.', '');
	tmpMantissa = tmpMantissa.replace(/^0+/, '').replace(/0+$/, '');
	return tmpMantissa.length;
};

/**
 * An integer store value (Int64).
 *
 * @param {any} pValue
 * @return {{ Value: any, Lossy: null | 'Compare' | 'Value' }}
 */
const integerValue = (pValue) =>
{
	if (typeof(pValue) === 'number')
	{
		return Number.isSafeInteger(pValue) ? { Value: pValue + 0, Lossy: null } : { Value: null, Lossy: 'Value' };
	}
	if (typeof(pValue) === 'bigint')
	{
		let tmpNumber = Number(pValue);
		return (Number.isSafeInteger(tmpNumber) && (BigInt(tmpNumber) === pValue)) ? { Value: tmpNumber, Lossy: null } : { Value: null, Lossy: 'Value' };
	}
	if ((typeof(pValue) === 'string') && INTEGER_LITERAL_PATTERN.test(pValue))
	{
		let tmpNumber = Number(pValue);
		// Only the canonical text of a safe integer ('007' or '-0' is SQLite TEXT, compared as text).
		if (Number.isSafeInteger(tmpNumber) && (String(tmpNumber) === pValue))
		{
			return { Value: tmpNumber + 0, Lossy: null };
		}
	}
	return { Value: null, Lossy: 'Value' };
};

/**
 * A decimal store value (Float64).
 *
 * @param {any} pValue
 * @return {{ Value: any, Lossy: null | 'Compare' | 'Value' }}
 */
const decimalValue = (pValue) =>
{
	if (typeof(pValue) === 'number')
	{
		// A JS number is a double already: exactly what the mirror stores.
		return Number.isFinite(pValue) ? { Value: pValue + 0, Lossy: null } : { Value: null, Lossy: 'Value' };
	}
	if (typeof(pValue) === 'bigint')
	{
		let tmpNumber = Number(pValue);
		return (Number.isSafeInteger(tmpNumber) && (BigInt(tmpNumber) === pValue)) ? { Value: tmpNumber, Lossy: null } : { Value: null, Lossy: 'Value' };
	}
	if ((typeof(pValue) === 'string') && NUMERIC_LITERAL_PATTERN.test(pValue))
	{
		// PostgreSQL numeric arrives as text; more than 15 significant digits do not round-trip.
		if (significantDigits(pValue) > MAX_SIGNIFICANT_DIGITS)
		{
			return { Value: null, Lossy: 'Value' };
		}
		let tmpNumber = Number(pValue);
		return Number.isFinite(tmpNumber) ? { Value: tmpNumber + 0, Lossy: null } : { Value: null, Lossy: 'Value' };
	}
	return { Value: null, Lossy: 'Value' };
};

/**
 * A boolean store value (UInt8).  On a SQLite source a column holds whatever was written: the text
 * 'true' / 'false' is TEXT in an integer column, which Live's `= 1` never matches and its Terms count
 * as Missing — no mirror value reproduces both, so any text other than the canonical integer texts
 * '0' / '1' is NULL + 'Value' (the column becomes ineligible).  'true' / 'false' text is read only
 * from other drivers (they never hand booleans over as text in a typed column).
 *
 * @param {any} pValue
 * @param {string} [pSourceDialect]
 * @return {{ Value: any, Lossy: null | 'Compare' | 'Value' }}
 */
const booleanValue = (pValue, pSourceDialect) =>
{
	let tmpWords = (pSourceDialect !== 'SQLite');
	if ((pValue === true) || (pValue === 1) || (pValue === '1') || (tmpWords && (pValue === 'true')) || (pValue === BIGINT_ONE))
	{
		return { Value: 1, Lossy: null };
	}
	if ((pValue === false) || (pValue === 0) || (pValue === '0') || (tmpWords && (pValue === 'false')) || (pValue === BIGINT_ZERO))
	{
		return { Value: 0, Lossy: null };
	}
	return { Value: null, Lossy: 'Value' };
};

/**
 * Three-digit milliseconds of a date value ('000' when none).
 *
 * @param {any} pValue
 * @return {string}
 */
const millisecondsOf = (pValue) =>
{
	if (Object.prototype.toString.call(pValue) === '[object Date]')
	{
		return String(pValue.getUTCMilliseconds()).padStart(3, '0');
	}
	let tmpMatch = (typeof(pValue) === 'string') ? FRACTION_PATTERN.exec(pValue) : null;
	return tmpMatch ? tmpMatch[1].slice(0, 3).padEnd(3, '0') : '000';
};

/**
 * A DateTime store value (DateTime64(3, 'UTC')): the naive wall clock in StorageTimeZone (D-22) with
 * the source's milliseconds.
 *
 * @param {any} pValue
 * @param {string} pSourceDialect
 * @return {{ Value: any, Lossy: null | 'Compare' | 'Value' }}
 */
const dateTimeValue = (pValue, pSourceDialect) =>
{
	let tmpCanonical = libFacetBuckets.canonicalDateTime(pValue);
	if (tmpCanonical === null)
	{
		return { Value: null, Lossy: 'Value' };
	}
	if ((tmpCanonical < DATETIME_MIN) || (tmpCanonical > DATETIME_MAX) || (tmpCanonical.length !== 19))
	{
		return { Value: null, Lossy: 'Value' };
	}
	let tmpValue = `${tmpCanonical}.${millisecondsOf(pValue)}`;
	// SQLite compares the stored TEXT: any other spelling of the same instant compares differently.
	if ((pSourceDialect === 'SQLite') && (typeof(pValue) === 'string') && (pValue !== tmpCanonical))
	{
		return { Value: tmpValue, Lossy: 'Compare' };
	}
	// A typed source (PostgreSQL `timestamp`, read as text by MaterializeSource: to_char … .US) keeps
	// microseconds the mirror's DateTime64(3) cannot: such a value buckets identically but compares
	// differently (a row at 12:00:00.000400 is > '12:00:00' at the source, = at the mirror).
	if ((pSourceDialect !== 'SQLite') && (typeof(pValue) === 'string'))
	{
		let tmpFraction = FRACTION_PATTERN.exec(pValue);
		if (tmpFraction && (tmpFraction[1].length > 3) && /[1-9]/.test(tmpFraction[1].slice(3)))
		{
			return { Value: tmpValue, Lossy: 'Compare' };
		}
	}
	return { Value: tmpValue, Lossy: null };
};

/**
 * One source value → its store value (§56.3).
 *
 * @param {Record<string, any>} pColumnInfo - a spec column ({ Column, DataType, Mirror }) or a catalog ColumnInfo
 * @param {any} pValue
 * @param {string} pSourceDialect - 'SQLite' | 'PostgreSQL'
 * @return {{ Value: any, Lossy: null | 'Compare' | 'Value' }}
 */
const toStoreValue = (pColumnInfo, pValue, pSourceDialect) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return { Value: null, Lossy: null };
	}
	switch (valueTypeOf(pColumnInfo))
	{
		case TYPE_INT64:
			return integerValue(pValue);
		case TYPE_FLOAT64:
			return decimalValue(pValue);
		case TYPE_UINT8:
			return booleanValue(pValue, pSourceDialect);
		case TYPE_DATETIME:
			return dateTimeValue(pValue, pSourceDialect);
		case TYPE_STRING:
			if (Buffer.isBuffer(pValue))
			{
				return { Value: pValue.toString('utf8'), Lossy: null };
			}
			return { Value: String(pValue), Lossy: null };
		default:
			return { Value: null, Lossy: 'Value' };
	}
};

/**
 * Is a tenant store value unset (null, 0, '' or one of the policy's UnsetValues)?
 *
 * @param {any} pValue - a store value
 * @param {Array<any>} pUnsetValues
 * @return {boolean}
 */
const isUnsetTenant = (pValue, pUnsetValues) =>
{
	if ((pValue === null) || (pValue === 0) || (pValue === '') || ((typeof(pValue) === 'string') && (pValue.trim() === '')))
	{
		return true;
	}
	let tmpUnset = Array.isArray(pUnsetValues) ? pUnsetValues : [];
	for (let i = 0; i < tmpUnset.length; i++)
	{
		let tmpCandidate = tmpUnset[i];
		if ((tmpCandidate === pValue) || ((tmpCandidate !== null) && (typeof(tmpCandidate) !== 'object') && (String(tmpCandidate).trim() === String(pValue).trim())))
		{
			return true;
		}
	}
	return false;
};

/**
 * A spec column by role.
 *
 * @param {Record<string, any>} pSpec
 * @param {string} pColumn
 * @return {Record<string, any>|null}
 */
const specColumn = (pSpec, pColumn) =>
{
	let tmpColumns = (pSpec && Array.isArray(pSpec.Columns)) ? pSpec.Columns : [];
	for (let i = 0; i < tmpColumns.length; i++)
	{
		if (tmpColumns[i] && (tmpColumns[i].Column === pColumn))
		{
			return tmpColumns[i];
		}
	}
	return null;
};

/**
 * Is the source row live (§56.4)?  It exists and its delete column (when the entity has one) is
 * exactly 0.  The tenant check is the quarantine rule of toStoreRow.
 *
 * @param {Record<string, any>} pSpec
 * @param {Record<string, any>|null} pSourceRow
 * @return {boolean}
 */
const isLive = (pSpec, pSourceRow) =>
{
	if (!libFacetUtil.isPlainObject(pSourceRow))
	{
		return false;
	}
	if (!pSpec || (typeof(pSpec.DeleteColumn) !== 'string') || (pSpec.DeleteColumn.length < 1))
	{
		return true;
	}
	let tmpValue = pSourceRow[pSpec.DeleteColumn];
	if ((tmpValue === null) || (typeof(tmpValue) === 'undefined'))
	{
		return false;
	}
	return (booleanValue(tmpValue).Value === 0);
};

/**
 * One source row → the store row of a spec (§56.3–§56.4): the spec's columns only, JSONEachRow-ready
 * (no meta columns: the WriterLoop adds _Version).  Lossy flags per column; Quarantined when the
 * identity is not a safe integer ('Identity': Row is null) or the tenant of a Tenant / Personal entity
 * is unset ('TenantUnset': Row is still built, for counters, but is never mirrored).
 *
 * @param {Record<string, any>} pSpec - a MirrorSpec (§55.2)
 * @param {Record<string, any>} pSourceRow
 * @param {string} pSourceDialect
 * @return {{ Row: Record<string, any>|null, Lossy: Record<string, string>, Quarantined: false | string }}
 */
const toStoreRow = (pSpec, pSourceRow, pSourceDialect) =>
{
	let tmpRow = {};
	let tmpLossy = {};
	let tmpSource = libFacetUtil.isPlainObject(pSourceRow) ? pSourceRow : {};
	let tmpColumns = (pSpec && Array.isArray(pSpec.Columns)) ? pSpec.Columns : [];
	for (let i = 0; i < tmpColumns.length; i++)
	{
		let tmpColumn = tmpColumns[i];
		let tmpConverted = toStoreValue(tmpColumn, tmpSource[tmpColumn.Column], pSourceDialect);
		tmpRow[tmpColumn.Column] = tmpConverted.Value;
		if (tmpConverted.Lossy && (tmpLossy[tmpColumn.Column] !== 'Value'))
		{
			tmpLossy[tmpColumn.Column] = tmpConverted.Lossy;
		}
	}
	let tmpIdentity = pSpec ? pSpec.Identity : null;
	if ((typeof(tmpIdentity) !== 'string') || !Number.isSafeInteger(tmpRow[tmpIdentity]))
	{
		if (typeof(tmpIdentity) === 'string')
		{
			tmpLossy[tmpIdentity] = 'Value';
		}
		return { Row: null, Lossy: tmpLossy, Quarantined: 'Identity' };
	}
	let tmpTenant = pSpec.TenantColumn;
	if ((typeof(tmpTenant) === 'string') && ((pSpec.Kind === 'Tenant') || (pSpec.Kind === 'Personal'))
		&& isUnsetTenant(tmpRow[tmpTenant], pSpec.UnsetValues))
	{
		return { Row: tmpRow, Lossy: tmpLossy, Quarantined: 'TenantUnset' };
	}
	return { Row: tmpRow, Lossy: tmpLossy, Quarantined: false };
};

/**
 * The sort-key scope columns of a spec (the sort key without the identity).
 *
 * @param {Record<string, any>} pSpec
 * @return {Array<string>}
 */
const keyColumnsOf = (pSpec) =>
{
	let tmpSortKey = (pSpec && Array.isArray(pSpec.SortKey)) ? pSpec.SortKey : [];
	return tmpSortKey.filter((pColumn) => { return pColumn !== pSpec.Identity; });
};

/**
 * The keymap Key of a store row: { <sort-key scope column>: value } (§54.3 readKeys).
 *
 * @param {Record<string, any>} pSpec
 * @param {Record<string, any>} pStoreRow
 * @return {Record<string, any>}
 */
const keyOf = (pSpec, pStoreRow) =>
{
	let tmpKey = {};
	let tmpColumns = keyColumnsOf(pSpec);
	for (let i = 0; i < tmpColumns.length; i++)
	{
		let tmpValue = pStoreRow ? pStoreRow[tmpColumns[i]] : null;
		tmpKey[tmpColumns[i]] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
	}
	return tmpKey;
};

/**
 * The tracked values of a store row: { <TrackedKeyColumn>: value }.
 *
 * @param {Record<string, any>} pSpec
 * @param {Record<string, any>} pStoreRow
 * @return {Record<string, any>}
 */
const trackedOf = (pSpec, pStoreRow) =>
{
	let tmpTracked = {};
	let tmpColumns = (pSpec && Array.isArray(pSpec.TrackedKeyColumns)) ? pSpec.TrackedKeyColumns : [];
	for (let i = 0; i < tmpColumns.length; i++)
	{
		let tmpValue = pStoreRow ? pStoreRow[tmpColumns[i]] : null;
		tmpTracked[tmpColumns[i]] = (typeof(tmpValue) === 'undefined') ? null : tmpValue;
	}
	return tmpTracked;
};

/**
 * A canonical string of a Key (sort-key order): equal keys ⇔ equal strings.
 *
 * @param {Record<string, any>} pSpec
 * @param {Record<string, any>} pKey
 * @return {string}
 */
const keyString = (pSpec, pKey) =>
{
	let tmpColumns = keyColumnsOf(pSpec);
	return JSON.stringify(tmpColumns.map(
		(pColumn) =>
		{
			let tmpValue = pKey ? pKey[pColumn] : null;
			return (typeof(tmpValue) === 'undefined') ? null : tmpValue;
		}));
};

/**
 * A value read from the store, as the engines compare it: DateTime64 text → the M1 wire format
 * 'YYYY-MM-DD HH:mm:ss'; integers and decimals → numbers (a wide integer the client left as decimal
 * text stays text); everything else as is.
 *
 * @param {string} pMirrorType
 * @param {any} pValue
 * @return {any}
 */
const fromStoreValue = (pMirrorType, pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return null;
	}
	let tmpBase = baseType(pMirrorType);
	if (tmpBase === TYPE_DATETIME)
	{
		return (typeof(pValue) === 'string') ? pValue.slice(0, 19) : pValue;
	}
	if ((tmpBase === TYPE_INT64) || (tmpBase === TYPE_UINT8) || (tmpBase === 'UInt64'))
	{
		if ((typeof(pValue) === 'string') && INTEGER_LITERAL_PATTERN.test(pValue))
		{
			let tmpNumber = Number(pValue);
			return Number.isSafeInteger(tmpNumber) ? tmpNumber : pValue;
		}
		return pValue;
	}
	if (tmpBase === TYPE_FLOAT64)
	{
		if ((typeof(pValue) === 'string') && NUMERIC_LITERAL_PATTERN.test(pValue))
		{
			return Number(pValue);
		}
		return pValue;
	}
	return pValue;
};

/**
 * The literal a DateTime filter value binds as (§63.3): a canonical 'YYYY-MM-DD HH:mm:ss' under any
 * operator; a day-only 'YYYY-MM-DD' as 'YYYY-MM-DD 00:00:00' under >= / < on both dialects and under
 * any operator on PostgreSQL (a timestamp literal there); anything else, a day-only literal under
 * > / <= / = / != on SQLite (a TEXT comparison there), or a value outside the DateTime64 range →
 * Refused.  An array (IN / NOT IN) is converted element by element (each as '=').
 *
 * @param {any} pValue - a filter value on a DateTime column
 * @param {string} pOperator - the FoxHound operator
 * @param {string} pSourceDialect
 * @return {{ Literal?: string|Array<string>, Refused?: string }}
 */
const canonicalDateLiteral = (pValue, pOperator, pSourceDialect) =>
{
	if (Array.isArray(pValue))
	{
		let tmpLiterals = [];
		for (let i = 0; i < pValue.length; i++)
		{
			let tmpOne = canonicalDateLiteral(pValue[i], '=', pSourceDialect);
			if (tmpOne.Refused)
			{
				return tmpOne;
			}
			tmpLiterals.push(tmpOne.Literal);
		}
		return { Literal: tmpLiterals };
	}
	if (typeof(pValue) !== 'string')
	{
		return { Refused: 'DateLiteral' };
	}
	let tmpOperator = String(pOperator || '').trim().toUpperCase();
	let tmpLiteral = null;
	if (CANONICAL_DATETIME_PATTERN.test(pValue) && (libFacetBuckets.canonicalDateTime(pValue) === pValue))
	{
		tmpLiteral = pValue;
	}
	else if (DAY_ONLY_PATTERN.test(pValue) && (libFacetBuckets.canonicalDateTime(pValue) === `${pValue} 00:00:00`))
	{
		if ((pSourceDialect === 'PostgreSQL') || (DAY_ONLY_SAFE_OPERATORS.indexOf(tmpOperator) >= 0))
		{
			tmpLiteral = `${pValue} 00:00:00`;
		}
	}
	if ((tmpLiteral === null) || (tmpLiteral < DATETIME_MIN) || (tmpLiteral > DATETIME_MAX))
	{
		return { Refused: 'DateLiteral' };
	}
	return { Literal: tmpLiteral };
};

module.exports = (
	{
		TYPE_MAP_VERSION: TYPE_MAP_VERSION,
		DATETIME_MIN: DATETIME_MIN,
		DATETIME_MAX: DATETIME_MAX,
		mirrorType: mirrorType,
		baseType: baseType,
		paramType: paramType,
		isNullableType: isNullableType,
		toStoreValue: toStoreValue,
		toStoreRow: toStoreRow,
		fromStoreValue: fromStoreValue,
		canonicalDateLiteral: canonicalDateLiteral,
		isLive: isLive,
		isUnsetTenant: isUnsetTenant,
		specColumn: specColumn,
		keyColumnsOf: keyColumnsOf,
		keyOf: keyOf,
		trackedOf: trackedOf,
		keyString: keyString
	});
