/**
 * Facet Contract - Util
 *
 * PURE: zero requires.  Shared with pict-section-facet.
 *
 * The small helpers every layer used to copy: own-property tests that are safe for client-chosen
 * keys, plain-object tests, defensive number readers for driver values, the client key rules
 * (facet Keys and range Keys become map keys and log text), and log-safe rendering.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// Names a client-chosen key may never take: they shadow or replace Object.prototype members when
// used as a property of a plain object.
const RESERVED_KEY_NAMES = Object.freeze([ '__proto__', 'constructor', 'prototype', 'hasOwnProperty' ]);

// C0 controls, DEL, C1 controls and the two JS line separators (log forging, header splitting).
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

// A plain decimal numeric literal, no surrounding whitespace ('12', '-0.5', '.5', '1e3').
const NUMERIC_LITERAL_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * @param {any} pValue
 * @return {boolean} a non-null, non-array object
 */
const isPlainObject = (pValue) =>
{
	return (typeof(pValue) === 'object') && (pValue !== null) && !Array.isArray(pValue);
};

/**
 * Own-property test that is safe for any key ('hasOwnProperty', '__proto__', …) and any object
 * (including Object.create(null) maps).
 *
 * @param {any} pObject
 * @param {any} pKey
 * @return {boolean}
 */
const hasOwn = (pObject, pKey) =>
{
	if ((pObject === null) || ((typeof(pObject) !== 'object') && (typeof(pObject) !== 'function')))
	{
		return false;
	}
	return Object.prototype.hasOwnProperty.call(pObject, pKey);
};

/**
 * @param {any} pValue
 * @return {boolean} neither null nor undefined
 */
const isPresent = (pValue) =>
{
	return (pValue !== null) && (typeof(pValue) !== 'undefined');
};

/**
 * A finite number from a driver or client value: numbers, bigints and plain numeric literal
 * strings; everything else (null, '', ' ', 'abc', booleans, NaN, ±Infinity) is null.
 *
 * @param {any} pValue
 * @return {number|null}
 */
const toFiniteNumber = (pValue) =>
{
	if (typeof(pValue) === 'number')
	{
		return Number.isFinite(pValue) ? pValue : null;
	}
	if (typeof(pValue) === 'bigint')
	{
		let tmpNumber = Number(pValue);
		return Number.isFinite(tmpNumber) ? tmpNumber : null;
	}
	if ((typeof(pValue) === 'string') && NUMERIC_LITERAL_PATTERN.test(pValue))
	{
		let tmpNumber = Number(pValue);
		return Number.isFinite(tmpNumber) ? tmpNumber : null;
	}
	return null;
};

/**
 * A count from an engine (number, bigint or numeric string) as a JS number; anything else → 0.
 *
 * @param {any} pValue
 * @return {number}
 */
const toCount = (pValue) =>
{
	if ((typeof(pValue) === 'string') && (pValue.trim().length > 0))
	{
		let tmpNumber = Number(pValue);
		return Number.isFinite(tmpNumber) ? tmpNumber : 0;
	}
	let tmpNumber = toFiniteNumber(pValue);
	return (tmpNumber === null) ? 0 : tmpNumber;
};

/**
 * Why a client-chosen key (a facet Key, a range Key) is unusable, or null when it is fine: it
 * must be a non-empty string without control characters and must not be a reserved
 * Object.prototype name (keys become plain-object map keys and log text).
 *
 * @param {any} pKey
 * @return {string|null} 'NotString' | 'Empty' | 'ControlCharacter' | 'ReservedName' | null
 */
const keyProblem = (pKey) =>
{
	if (typeof(pKey) !== 'string')
	{
		return 'NotString';
	}
	if (pKey.length < 1)
	{
		return 'Empty';
	}
	if (CONTROL_CHARACTER_PATTERN.test(pKey))
	{
		return 'ControlCharacter';
	}
	if (RESERVED_KEY_NAMES.indexOf(pKey) >= 0)
	{
		return 'ReservedName';
	}
	return null;
};

/**
 * Render a client-influenced value for a log line: JSON-quoted (so CR/LF and quotes are escaped)
 * and bounded.
 *
 * @param {any} pValue
 * @return {string}
 */
const logSafe = (pValue) =>
{
	let tmpText = (typeof(pValue) === 'string') ? pValue : String(pValue);
	if (tmpText.length > 128)
	{
		tmpText = `${tmpText.slice(0, 128)}…`;
	}
	return JSON.stringify(tmpText);
};

module.exports = (
	{
		RESERVED_KEY_NAMES: RESERVED_KEY_NAMES,
		CONTROL_CHARACTER_PATTERN: CONTROL_CHARACTER_PATTERN,
		NUMERIC_LITERAL_PATTERN: NUMERIC_LITERAL_PATTERN,
		isPlainObject: isPlainObject,
		hasOwn: hasOwn,
		isPresent: isPresent,
		toFiniteNumber: toFiniteNumber,
		toCount: toCount,
		keyProblem: keyProblem,
		logSafe: logSafe
	});
