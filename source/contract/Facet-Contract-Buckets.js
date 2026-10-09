/**
 * Facet Contract - Buckets
 *
 * PURE: requires nothing outside source/contract/. Shared with pict-section-facet.
 *
 * The canonical bucket math (internal-contracts §10.3).  The Live engine's SQL, the Reference
 * engine's JS fold and the envelope post-processor must all agree with these functions
 * byte-for-byte, so every engine computes keys, edges and labels the same way.
 *
 *   Dates   (D-22): naive wall clock in StorageTimeZone, wire format 'YYYY-MM-DD HH:mm:ss',
 *                   half-open buckets [Start, End).  Calendar math is pure integer arithmetic on a
 *                   proleptic Gregorian day number (no JS Date, no host time zone), so the keys
 *                   equal SQLite strftime for canonical inputs (03 §3.4).
 *   Numbers (§10.3.2): integer-unit geometry (units(v) = round(v × 10^Scale)) so edges are exact
 *                   decimals on every dialect; bucket MEMBERSHIP is then decided against those
 *                   exact edges with the raw value, exactly as the bucket's NumericRange Clause
 *                   compares it (a value with more decimals than the column Scale lands where
 *                   its Clause puts it).
 *
 * It also owns the one DataType classification every layer uses (DATA_TYPE_CLASSES).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const libFacetErrors = require('./Facet-Contract-Errors.js');
const libFacetUtil = require('./Facet-Contract-Util.js');

const INTERVAL_ORDER = Object.freeze([ 'day', 'week', 'month', 'quarter', 'year' ]);

const MONTH_NAMES = Object.freeze([ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ]);

const DAYS_IN_MONTH = Object.freeze([ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ]);

// 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'T' instead of the space, optional
// fractional seconds, optional 'Z' / '+00:00' / '-00:00' (StorageTimeZone is UTC in M1).
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-]00:00)?)?$/;

// A bucket key outside the 0000–9999 value range (only produced as a bucket boundary: the ISO week of
// 0000-01-01 starts in year -1, the bucket after 9999-12 is 10000-01).  Formatted like C '%04d',
// which is what SQLite strftime('%Y') prints.  Accepted by the key functions only, never as a value.
const EXTENDED_KEY_PATTERN = /^(-\d{3,4}|\d{4,5})-(\d{2})-(\d{2})(?: 00:00:00)?$/;

// The DataType classification (Stricture DataTypes plus the MeadowSchema spellings some models
// carry).  Integer types bucket and sum at Scale 0; decimal types at the column Scale.
const INTEGER_TYPES = Object.freeze([ 'ID', 'Numeric', 'ForeignKey', 'Boolean', 'Integer', 'AutoIdentity' ]);
const DECIMAL_TYPES = Object.freeze([ 'Decimal', 'Float', 'Double' ]);
const DATE_TYPES = Object.freeze([ 'DateTime' ]);
// Data types whose values (and Terms keys) are numbers (internal-contracts §9.2): a value of any
// other shape in such a column ('', ' ', text) is Missing on every engine.
const NUMERIC_KEY_TYPES = Object.freeze(INTEGER_TYPES.concat(DECIMAL_TYPES));

const DATA_TYPE_CLASSES = Object.freeze(
	{
		Integer: INTEGER_TYPES,
		Decimal: DECIMAL_TYPES,
		Numeric: NUMERIC_KEY_TYPES,
		Date: DATE_TYPES
	});

// The Pivot axis key of a row whose value falls in no declared range (a Range axis): counted in
// OtherCount like the single-dimension Ranges fold, never in MissingCount.  Range Keys may not
// start with '#', so it cannot collide with one.
const NO_RANGE_KEY = '#NoRange';

// The en dash used in numeric labels.
const LABEL_DASH = '–';

// Default target / maximum bucket counts when a caller passes nothing usable.
const DEFAULT_BUCKETS = 20;
const DEFAULT_MAX_BUCKETS = 500;

// ---------------------------------------------------------------- Calendar (integer day numbers)

/**
 * @param {number} pYear
 * @return {boolean}
 */
const isLeapYear = (pYear) =>
{
	return ((pYear % 4) === 0) && (((pYear % 100) !== 0) || ((pYear % 400) === 0));
};

/**
 * @param {number} pYear
 * @param {number} pMonth - 1..12
 * @return {number}
 */
const daysInMonth = (pYear, pMonth) =>
{
	return ((pMonth === 2) && isLeapYear(pYear)) ? 29 : DAYS_IN_MONTH[pMonth - 1];
};

/**
 * Days since 1970-01-01 of a proleptic Gregorian civil date (H. Hinnant's days_from_civil).
 *
 * @param {number} pYear
 * @param {number} pMonth - 1..12
 * @param {number} pDay - 1..31
 * @return {number}
 */
const daysFromCivil = (pYear, pMonth, pDay) =>
{
	let tmpYear = (pMonth <= 2) ? (pYear - 1) : pYear;
	let tmpEra = Math.floor(tmpYear / 400);
	let tmpYearOfEra = tmpYear - (tmpEra * 400);
	let tmpMonthIndex = (pMonth + 9) % 12;
	let tmpDayOfYear = Math.floor(((153 * tmpMonthIndex) + 2) / 5) + pDay - 1;
	let tmpDayOfEra = (tmpYearOfEra * 365) + Math.floor(tmpYearOfEra / 4) - Math.floor(tmpYearOfEra / 100) + tmpDayOfYear;
	return (tmpEra * 146097) + tmpDayOfEra - 719468;
};

/**
 * The civil date of a day number (H. Hinnant's civil_from_days).
 *
 * @param {number} pDays - days since 1970-01-01
 * @return {{ Year: number, Month: number, Day: number }}
 */
const civilFromDays = (pDays) =>
{
	let tmpZ = pDays + 719468;
	let tmpEra = Math.floor(tmpZ / 146097);
	let tmpDayOfEra = tmpZ - (tmpEra * 146097);
	let tmpYearOfEra = Math.floor((tmpDayOfEra - Math.floor(tmpDayOfEra / 1460) + Math.floor(tmpDayOfEra / 36524) - Math.floor(tmpDayOfEra / 146096)) / 365);
	let tmpYear = tmpYearOfEra + (tmpEra * 400);
	let tmpDayOfYear = tmpDayOfEra - ((365 * tmpYearOfEra) + Math.floor(tmpYearOfEra / 4) - Math.floor(tmpYearOfEra / 100));
	let tmpMonthIndex = Math.floor(((5 * tmpDayOfYear) + 2) / 153);
	let tmpDay = tmpDayOfYear - Math.floor(((153 * tmpMonthIndex) + 2) / 5) + 1;
	let tmpMonth = (tmpMonthIndex < 10) ? (tmpMonthIndex + 3) : (tmpMonthIndex - 9);
	return { Year: (tmpMonth <= 2) ? (tmpYear + 1) : tmpYear, Month: tmpMonth, Day: tmpDay };
};

/**
 * @param {number} pNumber
 * @param {number} pWidth
 * @return {string}
 */
const pad = (pNumber, pWidth) =>
{
	return String(pNumber).padStart(pWidth, '0');
};

/**
 * A year as C printf '%04d' formats it (SQLite strftime '%Y'): 2026 → '2026', 7 → '0007', -1 → '-001'.
 *
 * @param {number} pYear
 * @return {string}
 */
const formatYear = (pYear) =>
{
	return (pYear < 0) ? `-${pad(-pYear, 3)}` : pad(pYear, 4);
};

/**
 * Format date parts as 'YYYY-MM-DD HH:mm:ss'.
 *
 * @param {number} pYear
 * @param {number} pMonth
 * @param {number} pDay
 * @param {number} [pHour]
 * @param {number} [pMinute]
 * @param {number} [pSecond]
 * @return {string}
 */
const formatDateTime = (pYear, pMonth, pDay, pHour, pMinute, pSecond) =>
{
	return `${formatYear(pYear)}-${pad(pMonth, 2)}-${pad(pDay, 2)} ${pad(pHour || 0, 2)}:${pad(pMinute || 0, 2)}:${pad(pSecond || 0, 2)}`;
};

/**
 * Parse a DateTime value into parts, or null (see canonicalDateTime for the accepted forms).
 *
 * @param {any} pValue
 * @return {{ Year: number, Month: number, Day: number, Hour: number, Minute: number, Second: number } | null}
 */
const parseDateTime = (pValue) =>
{
	if (Object.prototype.toString.call(pValue) === '[object Date]')
	{
		// A driver Date (MySQL/MSSQL in later milestones): its UTC wall clock is the stored value.
		let tmpTime = pValue.getTime();
		if (!Number.isFinite(tmpTime) || (pValue.getUTCFullYear() < 0) || (pValue.getUTCFullYear() > 9999))
		{
			return null;
		}
		return (
			{
				Year: pValue.getUTCFullYear(), Month: pValue.getUTCMonth() + 1, Day: pValue.getUTCDate(),
				Hour: pValue.getUTCHours(), Minute: pValue.getUTCMinutes(), Second: pValue.getUTCSeconds()
			});
	}
	if ((typeof(pValue) !== 'string') || (pValue.length < 10) || (pValue.length > 64))
	{
		return null;
	}
	let tmpMatch = DATE_TIME_PATTERN.exec(pValue);
	if (!tmpMatch)
	{
		return null;
	}
	let tmpParts =
		{
			Year: parseInt(tmpMatch[1], 10),
			Month: parseInt(tmpMatch[2], 10),
			Day: parseInt(tmpMatch[3], 10),
			Hour: (typeof(tmpMatch[4]) === 'string') ? parseInt(tmpMatch[4], 10) : 0,
			Minute: (typeof(tmpMatch[5]) === 'string') ? parseInt(tmpMatch[5], 10) : 0,
			Second: (typeof(tmpMatch[6]) === 'string') ? parseInt(tmpMatch[6], 10) : 0
		};
	if ((tmpParts.Month < 1) || (tmpParts.Month > 12)
		|| (tmpParts.Day < 1) || (tmpParts.Day > daysInMonth(tmpParts.Year, tmpParts.Month))
		|| (tmpParts.Hour > 23) || (tmpParts.Minute > 59) || (tmpParts.Second > 59))
	{
		return null;
	}
	return tmpParts;
};

/**
 * Parse a bucket key: any value canonicalDateTime accepts, or an out-of-range bucket boundary
 * ('-001-12-27 00:00:00', '10000-01-01 00:00:00').
 *
 * @param {any} pKey
 * @return {{ Year: number, Month: number, Day: number, Hour: number, Minute: number, Second: number } | null}
 */
const parseKeyParts = (pKey) =>
{
	let tmpParts = parseDateTime(pKey);
	if (tmpParts || (typeof(pKey) !== 'string'))
	{
		return tmpParts;
	}
	let tmpMatch = EXTENDED_KEY_PATTERN.exec(pKey);
	if (!tmpMatch)
	{
		return null;
	}
	tmpParts = { Year: parseInt(tmpMatch[1], 10), Month: parseInt(tmpMatch[2], 10), Day: parseInt(tmpMatch[3], 10), Hour: 0, Minute: 0, Second: 0 };
	if ((tmpParts.Month < 1) || (tmpParts.Month > 12) || (tmpParts.Day < 1) || (tmpParts.Day > daysInMonth(tmpParts.Year, tmpParts.Month)))
	{
		return null;
	}
	return tmpParts;
};

/**
 * The bucket start key of date parts.
 *
 * @param {{ Year: number, Month: number, Day: number }} pParts
 * @param {string} pInterval
 * @return {string}
 */
const keyFromParts = (pParts, pInterval) =>
{
	switch (pInterval)
	{
		case 'day':
			return formatDateTime(pParts.Year, pParts.Month, pParts.Day);
		case 'week':
			{
				let tmpDays = daysFromCivil(pParts.Year, pParts.Month, pParts.Day);
				// 1970-01-01 was a Thursday; Monday-based weekday index (Monday = 0).
				let tmpWeekday = (((tmpDays + 3) % 7) + 7) % 7;
				let tmpMonday = civilFromDays(tmpDays - tmpWeekday);
				return formatDateTime(tmpMonday.Year, tmpMonday.Month, tmpMonday.Day);
			}
		case 'month':
			return formatDateTime(pParts.Year, pParts.Month, 1);
		case 'quarter':
			return formatDateTime(pParts.Year, (Math.floor((pParts.Month - 1) / 3) * 3) + 1, 1);
		default:
			return formatDateTime(pParts.Year, 1, 1);
	}
};

/**
 * @param {string} pInterval
 * @param {string} pFunctionName
 */
const assertInterval = (pInterval, pFunctionName) =>
{
	if (INTERVAL_ORDER.indexOf(pInterval) < 0)
	{
		throw libFacetErrors.create('FACET_INTERNAL', `Facet-Contract-Buckets.${pFunctionName}: unknown interval.`, { Interval: String(pInterval) });
	}
};

// ---------------------------------------------------------------- Dates

/**
 * Canonicalize a stored/client DateTime to 'YYYY-MM-DD HH:mm:ss'.
 *
 * Accepts 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'T' instead of the space,
 * optional '.fff' (truncated) and optional 'Z' / '+00:00' (dropped: StorageTimeZone is UTC in M1).
 * A JS Date (a driver value, later milestones) is read in UTC.  Anything else (including '', null,
 * numbers, other offsets and out-of-range parts such as Feb 30) → null.
 *
 * @param {any} pValue
 * @return {string|null}
 */
const canonicalDateTime = (pValue) =>
{
	let tmpParts = parseDateTime(pValue);
	if (!tmpParts)
	{
		return null;
	}
	return formatDateTime(tmpParts.Year, tmpParts.Month, tmpParts.Day, tmpParts.Hour, tmpParts.Minute, tmpParts.Second);
};

/**
 * The bucket key (bucket start) for a value, or null when the value is not a date.
 * Equals SQLite strftime for canonical inputs (03 §3.4 table): week = the ISO Monday on or before.
 *
 * @param {any} pValue
 * @param {string} pInterval - day | week (ISO Monday) | month | quarter | year
 * @return {string|null}
 */
const dateKey = (pValue, pInterval) =>
{
	assertInterval(pInterval, 'dateKey');
	let tmpParts = parseDateTime(pValue);
	if (!tmpParts)
	{
		return null;
	}
	return keyFromParts(tmpParts, pInterval);
};

/**
 * Re-key an engine's bucket key: the bucket start of any date dateKey accepts, or of an out-of-range
 * bucket boundary key ('-001-12-27 00:00:00'); null otherwise.  For post-processing engine groups,
 * never for stored values (use dateKey for those).
 *
 * @param {any} pKey
 * @param {string} pInterval
 * @return {string|null}
 */
const normalizeDateKey = (pKey, pInterval) =>
{
	assertInterval(pInterval, 'normalizeDateKey');
	let tmpParts = parseKeyParts(pKey);
	return tmpParts ? keyFromParts(tmpParts, pInterval) : null;
};

/**
 * The start of the bucket after pKey (= the bucket's End).  pKey may be any date inside the bucket.
 *
 * @param {string} pKey - a bucket start
 * @param {string} pInterval
 * @return {string|null} null when pKey is not a date
 */
const nextDateKey = (pKey, pInterval) =>
{
	let tmpParts = parseKeyParts(normalizeDateKey(pKey, pInterval));
	if (!tmpParts)
	{
		return null;
	}
	switch (pInterval)
	{
		case 'day':
		case 'week':
			{
				let tmpNext = civilFromDays(daysFromCivil(tmpParts.Year, tmpParts.Month, tmpParts.Day) + ((pInterval === 'day') ? 1 : 7));
				return formatDateTime(tmpNext.Year, tmpNext.Month, tmpNext.Day);
			}
		case 'month':
		case 'quarter':
			{
				let tmpMonthIndex = (tmpParts.Year * 12) + (tmpParts.Month - 1) + ((pInterval === 'month') ? 1 : 3);
				return formatDateTime(Math.floor(tmpMonthIndex / 12), (tmpMonthIndex % 12) + 1, 1);
			}
		default:
			return formatDateTime(tmpParts.Year + 1, 1, 1);
	}
};

/**
 * Chronological comparison of two date keys / canonical values (also for out-of-range bucket
 * boundaries such as '-001-12-27 00:00:00', where plain string order is wrong).  Unparseable → last.
 *
 * @param {any} pA
 * @param {any} pB
 * @return {number}
 */
const compareDateKeys = (pA, pB) =>
{
	let tmpA = parseKeyParts(pA);
	let tmpB = parseKeyParts(pB);
	if (!tmpA || !tmpB)
	{
		return (!tmpA && !tmpB) ? 0 : (tmpA ? -1 : 1);
	}
	let tmpOrdinalA = (daysFromCivil(tmpA.Year, tmpA.Month, tmpA.Day) * 86400) + (tmpA.Hour * 3600) + (tmpA.Minute * 60) + tmpA.Second;
	let tmpOrdinalB = (daysFromCivil(tmpB.Year, tmpB.Month, tmpB.Day) * 86400) + (tmpB.Hour * 3600) + (tmpB.Minute * 60) + tmpB.Second;
	return (tmpOrdinalA < tmpOrdinalB) ? -1 : ((tmpOrdinalA > tmpOrdinalB) ? 1 : 0);
};

/**
 * day → week → month → quarter → year → null (for 422 Suggest).
 *
 * @param {string} pInterval
 * @return {string|null}
 */
const coarserInterval = (pInterval) =>
{
	let tmpIndex = INTERVAL_ORDER.indexOf(pInterval);
	if ((tmpIndex < 0) || (tmpIndex >= (INTERVAL_ORDER.length - 1)))
	{
		return null;
	}
	return INTERVAL_ORDER[tmpIndex + 1];
};

/**
 * Every bucket key from pLoKey through pHiKey inclusive (either may be any date inside its bucket).
 *
 * @param {string} pLoKey
 * @param {string} pHiKey
 * @param {string} pInterval
 * @param {number} [pMax] - Limits.MaxDateBuckets; more keys → throws FACET_INTERVAL_TOO_FINE with Detail.Suggest
 * @return {Array<string>} [] when either bound is not a date or Lo > Hi
 */
const fillDateKeys = (pLoKey, pHiKey, pInterval, pMax) =>
{
	let tmpLo = normalizeDateKey(pLoKey, pInterval);
	let tmpHi = normalizeDateKey(pHiKey, pInterval);
	if ((tmpLo === null) || (tmpHi === null))
	{
		return [];
	}
	let fOrdinal = (pKey) =>
	{
		let tmpParts = parseKeyParts(pKey);
		return daysFromCivil(tmpParts.Year, tmpParts.Month, tmpParts.Day);
	};
	let tmpHiOrdinal = fOrdinal(tmpHi);
	let tmpMax = (Number.isFinite(pMax) && (pMax >= 0)) ? Math.floor(pMax) : Infinity;
	let tmpKeys = [];
	let tmpKey = tmpLo;
	while (fOrdinal(tmpKey) <= tmpHiOrdinal)
	{
		if (tmpKeys.length >= tmpMax)
		{
			throw libFacetErrors.create('FACET_INTERVAL_TOO_FINE', null,
				{
					Interval: pInterval,
					MaxDateBuckets: tmpMax,
					Suggest: { Interval: coarserInterval(pInterval) }
				});
		}
		tmpKeys.push(tmpKey);
		tmpKey = nextDateKey(tmpKey, pInterval);
	}
	return tmpKeys;
};

/**
 * Display label: day '2026-03-02', week 'Week of 2026-03-02', month 'Mar 2026', quarter 'Q1 2026', year '2026'.
 *
 * @param {string} pKey
 * @param {string} pInterval
 * @return {string}
 */
const dateLabel = (pKey, pInterval) =>
{
	let tmpParts = parseKeyParts(pKey);
	if (!tmpParts || (INTERVAL_ORDER.indexOf(pInterval) < 0))
	{
		return String(pKey);
	}
	let tmpDate = `${formatYear(tmpParts.Year)}-${pad(tmpParts.Month, 2)}-${pad(tmpParts.Day, 2)}`;
	switch (pInterval)
	{
		case 'day':
			return tmpDate;
		case 'week':
			return `Week of ${tmpDate}`;
		case 'month':
			return `${MONTH_NAMES[tmpParts.Month - 1]} ${formatYear(tmpParts.Year)}`;
		case 'quarter':
			return `Q${Math.floor((tmpParts.Month - 1) / 3) + 1} ${formatYear(tmpParts.Year)}`;
		default:
			return formatYear(tmpParts.Year);
	}
};

// ---------------------------------------------------------------- Numbers

/**
 * A column scale as a small non-negative integer (anything else → 0).
 *
 * @param {any} pScale
 * @return {number}
 */
const normalizeScale = (pScale) =>
{
	let tmpScale = Number(pScale);
	if (!Number.isInteger(tmpScale) || (tmpScale < 0))
	{
		return 0;
	}
	return Math.min(tmpScale, 15);
};

/**
 * 10^Scale.
 *
 * @param {any} pScale
 * @return {number}
 */
const scaleFactor = (pScale) =>
{
	return Math.pow(10, normalizeScale(pScale));
};

/**
 * Integer units of a value at a scale: round(v × 10^pScale), half away from zero (SQL ROUND).
 * Values are assumed to carry at most pScale decimals, so the rounding only absorbs float noise
 * (8.4 × 10 = 84.00000000000001 → 84).
 *
 * @param {any} pValue - a number (or a numeric string, e.g. a PostgreSQL numeric)
 * @param {number} pScale
 * @return {number|null} null when the value is not a finite number
 */
const units = (pValue, pScale) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined') || (typeof(pValue) === 'boolean'))
	{
		return null;
	}
	if ((typeof(pValue) === 'string') && (pValue.trim().length === 0))
	{
		return null;
	}
	let tmpNumber = (typeof(pValue) === 'number') ? pValue : Number(pValue);
	if (!Number.isFinite(tmpNumber))
	{
		return null;
	}
	let tmpScaled = tmpNumber * scaleFactor(pScale);
	let tmpUnits = (tmpScaled < 0) ? -Math.round(-tmpScaled) : Math.round(tmpScaled);
	// Fold -0 into 0.
	return tmpUnits + 0;
};

/**
 * Format integer units as an exact decimal string with exactly pScale decimals ('12.30').
 *
 * @param {number} pUnits - an integer
 * @param {number} pScale
 * @return {string|null}
 */
const formatUnits = (pUnits, pScale) =>
{
	if ((typeof(pUnits) !== 'number') || !Number.isFinite(pUnits))
	{
		return null;
	}
	let tmpScale = normalizeScale(pScale);
	let tmpUnits = Math.round(pUnits);
	let tmpNegative = tmpUnits < 0;
	let tmpAbsolute = Math.abs(tmpUnits);
	let tmpDigits = Number.isSafeInteger(tmpAbsolute) ? String(tmpAbsolute) : BigInt(tmpAbsolute).toString();
	if (tmpScale === 0)
	{
		return (tmpNegative && (tmpAbsolute !== 0)) ? `-${tmpDigits}` : tmpDigits;
	}
	tmpDigits = tmpDigits.padStart(tmpScale + 1, '0');
	let tmpText = `${tmpDigits.slice(0, tmpDigits.length - tmpScale)}.${tmpDigits.slice(tmpDigits.length - tmpScale)}`;
	return (tmpNegative && (tmpAbsolute !== 0)) ? `-${tmpText}` : tmpText;
};

/**
 * The value of integer units as a Number (the nearest double to the exact decimal).
 *
 * @param {number} pUnits
 * @param {number} pScale
 * @return {number|null}
 */
const unitsToNumber = (pUnits, pScale) =>
{
	let tmpText = formatUnits(pUnits, pScale);
	return (tmpText === null) ? null : Number(tmpText);
};

/**
 * Is this DataType measured as a number?
 *
 * @param {any} pDataType
 * @return {boolean}
 */
const isNumericType = (pDataType) =>
{
	return (NUMERIC_KEY_TYPES.indexOf(pDataType) >= 0);
};

/**
 * Is this DataType an integer type (Scale 0)?
 *
 * @param {any} pDataType
 * @return {boolean}
 */
const isIntegerType = (pDataType) =>
{
	return (INTEGER_TYPES.indexOf(pDataType) >= 0);
};

/**
 * A stored value of a numeric column as a number, or null when it is Missing: NULL, '', ' ', any
 * non-numeric text (SQLite keeps those as TEXT in a numeric-affinity column, and the Live engine
 * counts only the INTEGER / REAL storage classes).  A plain numeric literal string (a PostgreSQL
 * numeric) and a boolean (0 / 1) are values.
 *
 * @param {any} pValue
 * @return {number|null}
 */
const numericValue = (pValue) =>
{
	if (typeof(pValue) === 'boolean')
	{
		return pValue ? 1 : 0;
	}
	let tmpNumber = libFacetUtil.toFiniteNumber(pValue);
	// Fold -0 into 0.
	return (tmpNumber === null) ? null : (tmpNumber + 0);
};

/**
 * The k-th Nice width candidate in units: 1, 2, 5, 10, 20, 50, 100, …
 *
 * @param {number} pIndex
 * @return {number}
 */
const niceCandidate = (pIndex) =>
{
	return [ 1, 2, 5 ][pIndex % 3] * Math.pow(10, Math.floor(pIndex / 3));
};

/**
 * Nice-mode geometry (internal-contracts §10.3.2), computed entirely in integer units.
 *
 *   loU = units(Lo); hiU = units(Hi)
 *   WidthUnits = the smallest 1/2/5×10^k with WidthUnits × Buckets ≥ hiU − loU
 *   LoUnits    = floor(loU / WidthUnits) × WidthUnits
 *   N          = max(1, ceil((hiU − LoUnits) / WidthUnits)); while N > MaxBuckets take the next width
 *   Edges[i]   = (LoUnits + i × WidthUnits) / Factor, i = 0..N (exact decimals)
 *
 * The last bucket is closed ([Edges[N−1], Edges[N]]) so Hi always lands in it.
 *
 * @param {number|null} pLo - min of non-null values (null when there are none)
 * @param {number|null} pHi - max of non-null values
 * @param {number} pBuckets - target bucket count
 * @param {number} pScale - column scale (0 for integers)
 * @param {number} [pMaxBuckets] - Limits.MaxBuckets (default 500)
 * @return {{ Mode: 'Nice', Lo: number|null, Hi: number|null, Scale: number, Factor: number, LoUnits: number|null, WidthUnits: number|null, Width: number|null, N: number, Edges: Array<number> }}
 */
const numericGeometry = (pLo, pHi, pBuckets, pScale, pMaxBuckets) =>
{
	let tmpScale = normalizeScale(pScale);
	let tmpFactor = scaleFactor(tmpScale);
	let tmpLoUnits = units(pLo, tmpScale);
	let tmpHiUnits = units(pHi, tmpScale);
	if ((tmpLoUnits === null) || (tmpHiUnits === null))
	{
		return { Mode: 'Nice', Lo: null, Hi: null, Scale: tmpScale, Factor: tmpFactor, LoUnits: null, WidthUnits: null, Width: null, N: 0, Edges: [] };
	}
	// The geometry must cover the RAW bounds (a value with more decimals than the Scale): round
	// outward when the rounded bound would leave the raw value outside the first or last edge.
	if (unitsToNumber(tmpLoUnits, tmpScale) > Number(pLo))
	{
		tmpLoUnits -= 1;
	}
	if (unitsToNumber(tmpHiUnits, tmpScale) < Number(pHi))
	{
		tmpHiUnits += 1;
	}
	if (tmpLoUnits > tmpHiUnits)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Facet-Contract-Buckets.numericGeometry: Lo is greater than Hi.');
	}
	let tmpBuckets = (Number.isFinite(pBuckets) && (pBuckets >= 1)) ? Math.floor(pBuckets) : DEFAULT_BUCKETS;
	// At least 2: aligned edges cannot always fit a span into ONE bucket (a span straddling 0 always
	// has an edge inside it), but a width ≥ the span always fits it into two.
	let tmpMaxBuckets = (Number.isFinite(pMaxBuckets) && (pMaxBuckets >= 1)) ? Math.max(2, Math.floor(pMaxBuckets)) : Math.max(DEFAULT_MAX_BUCKETS, tmpBuckets);
	let tmpSpan = tmpHiUnits - tmpLoUnits;

	let tmpCandidate = 0;
	let tmpWidthUnits = niceCandidate(tmpCandidate);
	while ((tmpWidthUnits * tmpBuckets) < tmpSpan)
	{
		tmpCandidate++;
		tmpWidthUnits = niceCandidate(tmpCandidate);
	}
	let tmpStartUnits = Math.floor(tmpLoUnits / tmpWidthUnits) * tmpWidthUnits;
	let tmpN = Math.max(1, Math.ceil((tmpHiUnits - tmpStartUnits) / tmpWidthUnits));
	while (tmpN > tmpMaxBuckets)
	{
		tmpCandidate++;
		tmpWidthUnits = niceCandidate(tmpCandidate);
		tmpStartUnits = Math.floor(tmpLoUnits / tmpWidthUnits) * tmpWidthUnits;
		tmpN = Math.max(1, Math.ceil((tmpHiUnits - tmpStartUnits) / tmpWidthUnits));
	}
	if (!Number.isSafeInteger(tmpStartUnits) || !Number.isSafeInteger(tmpStartUnits + (tmpN * tmpWidthUnits)))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Facet-Contract-Buckets.numericGeometry: the value range is too large to bucket exactly.');
	}

	let tmpEdges = [];
	for (let i = 0; i <= tmpN; i++)
	{
		tmpEdges.push(unitsToNumber(tmpStartUnits + (i * tmpWidthUnits), tmpScale));
	}
	return (
		{
			Mode: 'Nice',
			Lo: unitsToNumber(tmpLoUnits, tmpScale),
			Hi: unitsToNumber(tmpHiUnits, tmpScale),
			Scale: tmpScale,
			Factor: tmpFactor,
			LoUnits: tmpStartUnits,
			WidthUnits: tmpWidthUnits,
			Width: unitsToNumber(tmpWidthUnits, tmpScale),
			N: tmpN,
			Edges: tmpEdges
		});
};

/**
 * Edges-mode geometry: bucket i is [Edges[i], Edges[i+1]); with pOpenEnded one more open bucket
 * [Edges[last], ∞).  Values below Edges[0] (or ≥ Edges[last] when closed) are in no bucket (Other).
 *
 * @param {Array<number>} pEdges - strictly ascending finite numbers, at least 2
 * @param {boolean} pOpenEnded
 * @param {number} pScale
 * @return {{ Mode: 'Edges', Lo: number, Hi: number|null, Scale: number, Factor: number, LoUnits: null, WidthUnits: null, Width: null, Edges: Array<number>, OpenEnded: boolean, N: number }}
 */
const edgesGeometry = (pEdges, pOpenEnded, pScale) =>
{
	if (!Array.isArray(pEdges) || (pEdges.length < 2))
	{
		throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Edges must be an array of at least two numbers.', { Field: 'Edges' });
	}
	let tmpEdges = [];
	for (let i = 0; i < pEdges.length; i++)
	{
		let tmpEdge = pEdges[i];
		if ((typeof(tmpEdge) !== 'number') || !Number.isFinite(tmpEdge) || ((i > 0) && (tmpEdge <= tmpEdges[i - 1])))
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Edges must be strictly ascending finite numbers.', { Field: 'Edges', Index: i });
		}
		tmpEdges.push(tmpEdge);
	}
	let tmpScale = normalizeScale(pScale);
	let tmpOpenEnded = (pOpenEnded === true);
	return (
		{
			Mode: 'Edges',
			Lo: tmpEdges[0],
			Hi: tmpOpenEnded ? null : tmpEdges[tmpEdges.length - 1],
			Scale: tmpScale,
			Factor: scaleFactor(tmpScale),
			LoUnits: null,
			WidthUnits: null,
			Width: null,
			Edges: tmpEdges,
			OpenEnded: tmpOpenEnded,
			N: (tmpEdges.length - 1) + (tmpOpenEnded ? 1 : 0)
		});
};

/**
 * The bucket index of a value, or null (NULL value, empty geometry, or outside an Edges geometry).
 *
 *   Nice:  c = min(floor((units(v) − LoUnits) / WidthUnits), N − 1)   (integer arithmetic), then
 *          corrected against the exact edges with the raw value: c − 1 when v < Edges[c],
 *          c + 1 when c < N − 1 and v ≥ Edges[c + 1] (one step at most: a bucket is at least one
 *          unit wide and rounding moves a value by at most half a unit).  Every dialect's SQL does
 *          the same, so a bucket holds exactly the rows its NumericRange Clause selects.
 *   Edges: the i with Edges[i] ≤ v < Edges[i+1]; the open bucket for v ≥ Edges[last]
 *
 * @param {any} pValue
 * @param {Record<string, any>} pGeometry
 * @return {number|null}
 */
const numericIndex = (pValue, pGeometry) =>
{
	if (!pGeometry || !(pGeometry.N > 0))
	{
		return null;
	}
	let tmpValue = numericValue(pValue);
	if (tmpValue === null)
	{
		return null;
	}
	if (pGeometry.Mode === 'Edges')
	{
		let tmpEdges = pGeometry.Edges;
		if (tmpValue < tmpEdges[0])
		{
			return null;
		}
		let tmpLast = tmpEdges.length - 1;
		if (tmpValue >= tmpEdges[tmpLast])
		{
			return pGeometry.OpenEnded ? tmpLast : null;
		}
		// Largest i with Edges[i] ≤ v (binary search; Edges[0] ≤ v < Edges[last] here).
		let tmpLow = 0;
		let tmpHigh = tmpLast - 1;
		while (tmpLow < tmpHigh)
		{
			let tmpMiddle = Math.ceil((tmpLow + tmpHigh) / 2);
			if (tmpEdges[tmpMiddle] <= tmpValue)
			{
				tmpLow = tmpMiddle;
			}
			else
			{
				tmpHigh = tmpMiddle - 1;
			}
		}
		return tmpLow;
	}
	let tmpUnits = units(tmpValue, pGeometry.Scale);
	let tmpIndex = Math.min(Math.floor((tmpUnits - pGeometry.LoUnits) / pGeometry.WidthUnits), pGeometry.N - 1);
	let tmpEdges = Array.isArray(pGeometry.Edges) ? pGeometry.Edges : [];
	let fEdge = (pEdgeIndex) =>
	{
		return (pEdgeIndex < tmpEdges.length) ? tmpEdges[pEdgeIndex] : unitsToNumber(pGeometry.LoUnits + (pEdgeIndex * pGeometry.WidthUnits), pGeometry.Scale);
	};
	if ((tmpIndex >= 0) && (tmpValue < fEdge(tmpIndex)))
	{
		tmpIndex--;
	}
	else if ((tmpIndex >= 0) && (tmpIndex < (pGeometry.N - 1)) && (tmpValue >= fEdge(tmpIndex + 1)))
	{
		tmpIndex++;
	}
	return (tmpIndex < 0) ? null : tmpIndex;
};

/**
 * Bounds of bucket pIndex: half-open, last Nice bucket closed on Edges[N], open bucket has only Start.
 *
 * @param {Record<string, any>} pGeometry
 * @param {number} pIndex
 * @return {{ Start: number, End?: number, EndExclusive: boolean } | null} null for an index outside the geometry
 */
const numericBucketBounds = (pGeometry, pIndex) =>
{
	if (!pGeometry || !Number.isInteger(pIndex) || (pIndex < 0) || (pIndex >= pGeometry.N))
	{
		return null;
	}
	let tmpEdges = pGeometry.Edges;
	if (pGeometry.Mode === 'Edges')
	{
		if (pIndex >= (tmpEdges.length - 1))
		{
			return { Start: tmpEdges[tmpEdges.length - 1], EndExclusive: true };
		}
		return { Start: tmpEdges[pIndex], End: tmpEdges[pIndex + 1], EndExclusive: true };
	}
	return { Start: tmpEdges[pIndex], End: tmpEdges[pIndex + 1], EndExclusive: (pIndex < (pGeometry.N - 1)) };
};

/**
 * Label of a [Start, End) span: integers 'a–(b−1)' (just 'a' for a one-value span), decimals
 * 'a–<b', closed 'a–b', open 'a+', upper-bounded only '<b'.
 *
 * @param {number|null|undefined} pStart
 * @param {number|null|undefined} pEnd
 * @param {boolean} pEndExclusive
 * @param {boolean} pIsInteger
 * @return {string}
 */
const spanLabel = (pStart, pEnd, pEndExclusive, pIsInteger) =>
{
	let tmpHasStart = (pStart !== null) && (typeof(pStart) !== 'undefined');
	let tmpHasEnd = (pEnd !== null) && (typeof(pEnd) !== 'undefined');
	if (!tmpHasStart && !tmpHasEnd)
	{
		return 'All';
	}
	if (!tmpHasEnd)
	{
		return `${pStart}+`;
	}
	if (!tmpHasStart)
	{
		if (pEndExclusive === false)
		{
			return `≤${pEnd}`;
		}
		if (pIsInteger && Number.isInteger(pEnd))
		{
			return `≤${pEnd - 1}`;
		}
		return `<${pEnd}`;
	}
	if (pEndExclusive === false)
	{
		return `${pStart}${LABEL_DASH}${pEnd}`;
	}
	if (pIsInteger && Number.isInteger(pStart) && Number.isInteger(pEnd))
	{
		return ((pEnd - 1) === pStart) ? String(pStart) : `${pStart}${LABEL_DASH}${pEnd - 1}`;
	}
	return `${pStart}${LABEL_DASH}<${pEnd}`;
};

/**
 * Label of bucket pIndex: integers '0–9', decimals '0–<10', closed last 'a–b', open 'a+'.
 *
 * @param {Record<string, any>} pGeometry
 * @param {number} pIndex
 * @param {boolean} pIsInteger
 * @return {string}
 */
const numericLabel = (pGeometry, pIndex, pIsInteger) =>
{
	let tmpBounds = numericBucketBounds(pGeometry, pIndex);
	if (!tmpBounds)
	{
		return String(pIndex);
	}
	return spanLabel(tmpBounds.Start, tmpBounds.End, tmpBounds.EndExclusive, pIsInteger);
};

/**
 * The Key of the FIRST declared range containing the value (CASE semantics:
 * (From == null || v >= From) && (To == null || v < To)), or null.
 *
 * @param {any} pValue
 * @param {Array<{ Key: string, From?: number|null, To?: number|null }>} pRanges
 * @return {string|null}
 */
const rangeKey = (pValue, pRanges) =>
{
	let tmpValue = numericValue(pValue);
	if ((tmpValue === null) || !Array.isArray(pRanges))
	{
		return null;
	}
	for (let i = 0; i < pRanges.length; i++)
	{
		let tmpRange = pRanges[i];
		let tmpFromOK = (tmpRange.From === null) || (typeof(tmpRange.From) === 'undefined') || (tmpValue >= tmpRange.From);
		let tmpToOK = (tmpRange.To === null) || (typeof(tmpRange.To) === 'undefined') || (tmpValue < tmpRange.To);
		if (tmpFromOK && tmpToOK)
		{
			return tmpRange.Key;
		}
	}
	return null;
};

/**
 * Display label of a declared range: its Label, else the span label of [From, To).
 *
 * @param {{ Key: string, From?: number|null, To?: number|null, Label?: string }} pRange
 * @param {boolean} pIsInteger
 * @return {string}
 */
const rangeLabel = (pRange, pIsInteger) =>
{
	if (!pRange)
	{
		return '';
	}
	if ((typeof(pRange.Label) === 'string') && (pRange.Label.length > 0))
	{
		return pRange.Label;
	}
	return spanLabel(pRange.From, pRange.To, true, pIsInteger);
};

// ---------------------------------------------------------------- ChildRollup bands and ExistsSplit (M2)

// Band 0 of a ChildRollup: no visible matching child (01 §4.6).
const BAND_NONE_LABEL = 'None';

// ExistsSplit keys in display order (1 = a visible match exists) and their default labels.
const EXISTS_SPLIT_KEYS = Object.freeze([ 1, 0 ]);
const EXISTS_SPLIT_DEFAULT_LABELS = Object.freeze({ true: 'Yes', false: 'No' });

// Integer column ranges a filter value must fall within (by the column's declared Size).
const INT32_RANGE = Object.freeze({ Min: -2147483648, Max: 2147483647 });
const SAFE_INTEGER_RANGE = Object.freeze({ Min: Number.MIN_SAFE_INTEGER, Max: Number.MAX_SAFE_INTEGER });

/**
 * The value range of an integer column (ColumnInfo / model column): 32-bit unless the column is
 * declared 'bigint' (then the JS safe-integer range, which every driver binds exactly).  A filter
 * value outside it is a client error (400), never a statement the database fails.
 *
 * @param {Record<string, any>} pColumnInfo - { Size }
 * @return {{ Min: number, Max: number }}
 */
const integerRange = (pColumnInfo) =>
{
	let tmpSize = (!pColumnInfo || (pColumnInfo.Size === null) || (typeof(pColumnInfo.Size) === 'undefined')) ? '' : String(pColumnInfo.Size).trim().toLowerCase();
	return (tmpSize === 'bigint') ? SAFE_INTEGER_RANGE : INT32_RANGE;
};

/**
 * Are these valid ChildRollup band edges: at least one, positive integers, strictly ascending, and
 * starting at 1 — band 0 is exactly "no visible matching child" (01 §4.6; its inverse is the
 * NotExists), so a count of 1 always lands in band 1, never in 'None'.
 *
 * @param {any} pEdges
 * @return {boolean}
 */
const isBandEdges = (pEdges) =>
{
	if (!Array.isArray(pEdges) || (pEdges.length < 1) || (pEdges[0] !== 1))
	{
		return false;
	}
	for (let i = 0; i < pEdges.length; i++)
	{
		if ((typeof(pEdges[i]) !== 'number') || !Number.isInteger(pEdges[i]) || (pEdges[i] < 1))
		{
			return false;
		}
		if ((i > 0) && (pEdges[i] <= pEdges[i - 1]))
		{
			return false;
		}
	}
	return true;
};

/**
 * The band of a child aggregate (01 §4.6, internal-contracts §24.9): Edges are the ascending lower
 * bounds of the non-zero bands.  Band 0 = no visible matching child (the aggregate is NULL, missing
 * or below Edges[0]); band i = [Edges[i−1], Edges[i]); the last band is open.  Every engine buckets
 * through this rule (Live as a CASE over the same edges).
 *
 * @param {any} pValue - the child aggregate (a count; NULL when no child matched)
 * @param {Array<number>} pEdges
 * @return {number} 0..Edges.length
 */
const bandKey = (pValue, pEdges) =>
{
	let tmpValue = numericValue(pValue);
	if ((tmpValue === null) || !Array.isArray(pEdges))
	{
		return 0;
	}
	for (let i = pEdges.length - 1; i >= 0; i--)
	{
		if (tmpValue >= pEdges[i])
		{
			return i + 1;
		}
	}
	return 0;
};

/**
 * The span of a band: band 0 has none (null); band i is [Edges[i−1], Edges[i]); the last band only
 * has a Start.
 *
 * @param {Array<number>} pEdges
 * @param {number} pBand
 * @return {{ Start: number, End?: number, EndExclusive?: boolean }|null}
 */
const bandBounds = (pEdges, pBand) =>
{
	if (!Array.isArray(pEdges) || !Number.isInteger(pBand) || (pBand < 1) || (pBand > pEdges.length))
	{
		return null;
	}
	if (pBand === pEdges.length)
	{
		return { Start: pEdges[pBand - 1] };
	}
	return { Start: pEdges[pBand - 1], End: pEdges[pBand], EndExclusive: true };
};

/**
 * The label of a band: a declared Labels['<band>'] wins; band 0 is 'None'; an integer band
 * [a, b) is 'a–(b−1)' ('a' when it holds one value); the open band is 'a+'.
 *
 * @param {Array<number>} pEdges
 * @param {number} pBand
 * @param {Record<string, string>|null} [pLabels]
 * @return {string}
 */
const bandLabel = (pEdges, pBand, pLabels) =>
{
	if (libFacetUtil.isPlainObject(pLabels) && libFacetUtil.hasOwn(pLabels, String(pBand)) && (typeof(pLabels[String(pBand)]) === 'string'))
	{
		return pLabels[String(pBand)];
	}
	let tmpBounds = bandBounds(pEdges, pBand);
	if (!tmpBounds)
	{
		return BAND_NONE_LABEL;
	}
	return spanLabel(tmpBounds.Start, tmpBounds.End, true, true);
};

/**
 * The ExistsSplit key of a raw value: 1 for a true-ish flag (true, 1, '1', 'true'), 0 for a
 * false-ish one, null otherwise.
 *
 * @param {any} pValue
 * @return {number|null}
 */
const existsSplitKey = (pValue) =>
{
	if ((pValue === true) || (pValue === 1) || (pValue === '1') || (pValue === 'true'))
	{
		return 1;
	}
	if ((pValue === false) || (pValue === 0) || (pValue === '0') || (pValue === 'false'))
	{
		return 0;
	}
	if (typeof(pValue) === 'bigint')
	{
		let tmpNumber = Number(pValue);
		return (tmpNumber === 1) ? 1 : ((tmpNumber === 0) ? 0 : null);
	}
	return null;
};

/**
 * The label of an ExistsSplit key: Labels.true / Labels.false, default 'Yes' / 'No'.
 *
 * @param {number} pKey - 1 or 0
 * @param {Record<string, string>|null} [pLabels]
 * @return {string}
 */
const existsSplitLabel = (pKey, pLabels) =>
{
	let tmpName = (pKey === 1) ? 'true' : 'false';
	if (libFacetUtil.isPlainObject(pLabels) && libFacetUtil.hasOwn(pLabels, tmpName) && (typeof(pLabels[tmpName]) === 'string'))
	{
		return pLabels[tmpName];
	}
	return EXISTS_SPLIT_DEFAULT_LABELS[tmpName];
};

// ---------------------------------------------------------------- Keys and ordering

/**
 * Normalize a raw column value into a bucket Key (internal-contracts §9.2):
 * Numeric/Decimal/ID/Boolean/ForeignKey → Number (booleans → 0/1); everything else → String;
 * null/undefined stay null.  A blank or non-numeric string in a numeric column stays a String
 * here (engines never produce one: numericValue makes it Missing first).
 *
 * @param {any} pValue
 * @param {string} pDataType - Stricture DataType of the column
 * @return {number|string|null}
 */
const normalizeKey = (pValue, pDataType) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return null;
	}
	if (isNumericType(pDataType))
	{
		if (typeof(pValue) === 'boolean')
		{
			return pValue ? 1 : 0;
		}
		if (typeof(pValue) === 'number')
		{
			return Number.isFinite(pValue) ? (pValue + 0) : String(pValue);
		}
		if (typeof(pValue) === 'bigint')
		{
			return Number(pValue);
		}
		if ((typeof(pValue) === 'string') && (pValue.trim().length === 0))
		{
			return pValue;
		}
		let tmpNumber = Number(pValue);
		return Number.isFinite(tmpNumber) ? (tmpNumber + 0) : String(pValue);
	}
	return String(pValue);
};

/**
 * Canonical key comparison: numbers numerically, strings by UTF-16 code unit, null last.
 * A total order even for mixed keys: finite numbers sort before every other (non-null) key, which
 * compare as Strings — so a column whose keys normalize to one type orders exactly as the contract
 * says, and a mixed column still sorts deterministically (no comparator cycles).
 *
 * @param {any} pA
 * @param {any} pB
 * @return {number}
 */
const compareKeys = (pA, pB) =>
{
	if (pA === pB)
	{
		return 0;
	}
	let tmpANull = (pA === null) || (typeof(pA) === 'undefined');
	let tmpBNull = (pB === null) || (typeof(pB) === 'undefined');
	if (tmpANull || tmpBNull)
	{
		return (tmpANull && tmpBNull) ? 0 : (tmpANull ? 1 : -1);
	}
	let tmpANumber = (typeof(pA) === 'number') && Number.isFinite(pA);
	let tmpBNumber = (typeof(pB) === 'number') && Number.isFinite(pB);
	if (tmpANumber && tmpBNumber)
	{
		return (pA < pB) ? -1 : ((pA > pB) ? 1 : 0);
	}
	if (tmpANumber !== tmpBNumber)
	{
		return tmpANumber ? -1 : 1;
	}
	let tmpA = String(pA);
	let tmpB = String(pB);
	if (tmpA === tmpB)
	{
		return 0;
	}
	return (tmpA < tmpB) ? -1 : 1;
};

module.exports = (
	{
		INTERVAL_ORDER: INTERVAL_ORDER,
		NUMERIC_KEY_TYPES: NUMERIC_KEY_TYPES,
		INTEGER_TYPES: INTEGER_TYPES,
		DECIMAL_TYPES: DECIMAL_TYPES,
		DATE_TYPES: DATE_TYPES,
		DATA_TYPE_CLASSES: DATA_TYPE_CLASSES,
		NO_RANGE_KEY: NO_RANGE_KEY,
		isNumericType: isNumericType,
		isIntegerType: isIntegerType,
		numericValue: numericValue,
		canonicalDateTime: canonicalDateTime,
		dateKey: dateKey,
		normalizeDateKey: normalizeDateKey,
		compareDateKeys: compareDateKeys,
		nextDateKey: nextDateKey,
		fillDateKeys: fillDateKeys,
		dateLabel: dateLabel,
		coarserInterval: coarserInterval,
		units: units,
		formatUnits: formatUnits,
		numericGeometry: numericGeometry,
		edgesGeometry: edgesGeometry,
		numericIndex: numericIndex,
		numericBucketBounds: numericBucketBounds,
		numericLabel: numericLabel,
		rangeKey: rangeKey,
		rangeLabel: rangeLabel,
		normalizeKey: normalizeKey,
		compareKeys: compareKeys,
		// M2 (internal-contracts §24.9, §29.2)
		BAND_NONE_LABEL: BAND_NONE_LABEL,
		EXISTS_SPLIT_KEYS: EXISTS_SPLIT_KEYS,
		EXISTS_SPLIT_DEFAULT_LABELS: EXISTS_SPLIT_DEFAULT_LABELS,
		isBandEdges: isBandEdges,
		integerRange: integerRange,
		bandKey: bandKey,
		bandBounds: bandBounds,
		bandLabel: bandLabel,
		existsSplitKey: existsSplitKey,
		existsSplitLabel: existsSplitLabel
	});
