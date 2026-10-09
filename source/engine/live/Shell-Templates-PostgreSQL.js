/**
 * Retold Faceting - Shell templates: PostgreSQL
 *
 * PURE DATA: zero requires.  Consumed by the RetoldFacetingShellTemplates registry.
 *
 * Dry-built only in M1 (executed from M2).  date_trunc per row and to_char in an outer select
 * (03 §3.4); numeric arithmetic on bound values is CAST to numeric so an integer column never
 * types a fractional edge as integer; counts and sums arrive as strings (the engine parses
 * defensively).  Same slot and result-column conventions as Shell-Templates-SQLite.js.
 *
 * Every template may reference ONLY the slots _Params.SR<n>, _Params.D<n>, _Params.P<n>,
 * _Params.JOINS, _Params.WHERE, _Params.AND_WHERE (the registry tag-scans them) and scalar bound
 * shell parameters named f* (fTopPlusOne, fFactor, fLoUnits, fWidthUnits, fLastIndex, fE<n>, …).
 * Never a JS array, never a value in template text.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const DIALECT = 'PostgreSQL';

const SIGIL = ':';

// date_trunc units are server constants keyed by the validated interval enum (never client text);
// a literal unit lets PostgreSQL use an expression index on date_trunc('<unit>', column).
const DATE_TRUNC_UNITS = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

const CANONICAL_FORMAT = '\'YYYY-MM-DD HH24:MI:SS\'';

/**
 * A bound shell parameter reference.
 *
 * @param {string} pName - f* name
 * @return {string}
 */
const bind = (pName) =>
{
	return `${SIGIL}${pName}`;
};

/**
 * A bound numeric shell parameter, typed explicitly.
 *
 * @param {string} pName
 * @return {string}
 */
const bindNumeric = (pName) =>
{
	return `CAST(${bind(pName)} AS numeric)`;
};

const TEMPLATES = (
	{
		Count: 'SELECT count(*) AS "Total" FROM (<%= _Params.SR0 %>) "p"',

		Terms: 'SELECT "r"."Key" AS "Key", "r"."Count" AS "Count", "r"."FacetTotal" AS "FacetTotal", "r"."FacetMissing" AS "FacetMissing", "r"."FacetDistinct" AS "FacetDistinct"'
			+ ' FROM (SELECT "t"."Key" AS "Key", "t"."Count" AS "Count",'
			+ ' sum("t"."Count") OVER () AS "FacetTotal",'
			+ ' sum(CASE WHEN "t"."Key" IS NULL THEN "t"."Count" ELSE 0 END) OVER () AS "FacetMissing",'
			+ ' count("t"."Key") OVER () AS "FacetDistinct",'
			+ ' rank() OVER (ORDER BY CASE WHEN "t"."Key" IS NULL THEN 1 ELSE 0 END, "t"."Count" DESC) AS "RowRank",'
			+ ' row_number() OVER (ORDER BY CASE WHEN "t"."Key" IS NULL THEN 1 ELSE 0 END, "t"."Count" DESC, "t"."Key") AS "RowNumber"'
			+ ' FROM (SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."Key") "t") "r"'
			+ ' WHERE ("r"."RowRank" <= CAST(:fTopPlusOne AS bigint) AND "r"."RowNumber" <= CAST(:fMaxGroups AS bigint))<%= _Params.P0 %>',

		// Group by the truncated timestamp; format only the (at most MaxDateBuckets) groups.
		DateHistogram: `SELECT to_char("g"."Key", ${CANONICAL_FORMAT}) AS "Key", "g"."Count" AS "Count", to_char("g"."Lo", ${CANONICAL_FORMAT}) AS "Lo", to_char("g"."Hi", ${CANONICAL_FORMAT}) AS "Hi"`
			+ ' FROM (SELECT "k"."Key" AS "Key", count(*) AS "Count", min("k"."Value") AS "Lo", max("k"."Value") AS "Hi", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key", "v"."Value" AS "Value"'
			+ ' FROM (SELECT <%= _Params.D1 %> AS "Value" FROM (<%= _Params.SR0 %>) "p") "v") "k"'
			+ ' GROUP BY "k"."Key") "g"'
			+ ' WHERE "g"."RowNumber" <= CAST(:fMaxGroups AS bigint)',

		NumericBounds: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", min(<%= _Params.D0 %>) AS "Lo", max(<%= _Params.D0 %>) AS "Hi"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		NumericHistogram: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p" WHERE <%= _Params.D1 %> IS NOT NULL) "d"'
			+ ' GROUP BY "d"."Key"',

		Ranges: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."Key"',

		Stats: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", min(<%= _Params.D0 %>) AS "Min", max(<%= _Params.D0 %>) AS "Max", <%= _Params.D1 %> AS "SumUnits"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		DistinctCount: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", count(DISTINCT <%= _Params.D0 %>) AS "Distinct"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		Missing: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		Pivot: 'SELECT "c"."K1" AS "K1", "c"."K2" AS "K2", "c"."Count" AS "Count"'
			+ ' FROM (SELECT "d"."K1" AS "K1", "d"."K2" AS "K2", count(*) AS "Count", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "K1", <%= _Params.D1 %> AS "K2" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."K1", "d"."K2") "c"'
			+ ' WHERE "c"."RowNumber" <= CAST(:fMaxGroups AS bigint)',

		// M2 (internal-contracts §26.4) ------------------------------------------------------------

		KeyGroups: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."Key"',

		MultiTerms: 'SELECT "r"."Key" AS "Key", "r"."Count" AS "Count", "r"."FacetDistinct" AS "FacetDistinct"'
			+ ' FROM (SELECT "t"."Key" AS "Key", "t"."Count" AS "Count",'
			+ ' count(*) OVER () AS "FacetDistinct",'
			+ ' rank() OVER (ORDER BY "t"."Count" DESC) AS "RowRank",'
			+ ' row_number() OVER (ORDER BY "t"."Count" DESC, "t"."Key") AS "RowNumber"'
			+ ' FROM (SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT DISTINCT <%= _Params.D0 %> AS "Key", <%= _Params.D1 %> AS "PK" FROM (<%= _Params.SR0 %>) "p"<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) "d"'
			+ ' GROUP BY "d"."Key") "t") "r"'
			+ ' WHERE ("r"."RowRank" <= CAST(:fTopPlusOne AS bigint) AND "r"."RowNumber" <= CAST(:fMaxGroups AS bigint))<%= _Params.P0 %>',

		MultiCovered: 'SELECT count(*) AS "Covered"'
			+ ' FROM (SELECT DISTINCT <%= _Params.D1 %> AS "PK" FROM (<%= _Params.SR0 %>) "p"<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) "k"',

		Cube: 'SELECT <%= _Params.D1 %>'
			+ ' FROM (SELECT <%= _Params.D2 %>, count(*) AS "N", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) "p") "g"'
			+ ' GROUP BY <%= _Params.D3 %>) "c"'
			+ ' WHERE "c"."RowNumber" <= CAST(:fMaxGroups AS bigint)',

		RecordKeys: 'SELECT <%= _Params.D1 %> AS "Key" FROM (<%= _Params.SR0 %>) "p"'
			+ ' ORDER BY <%= _Params.D0 %> LIMIT CAST(:fCap AS bigint) OFFSET CAST(:fBegin AS bigint)',

		Keys: 'SELECT <%= _Params.D1 %> AS "Key" FROM (<%= _Params.SR0 %>) "p"'
			+ ' ORDER BY <%= _Params.D1 %> LIMIT CAST(:fCapPlusOne AS bigint)',

		StagedKeys: 'SELECT DISTINCT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) "p"'
			+ ' LIMIT CAST(:fCapPlusOne AS bigint)'
	});

/**
 * The per-row truncation (a timestamp; formatted by the template).
 *
 * @param {string} pValueSQL
 * @param {string} pInterval
 * @return {string|null}
 */
const dateBucket = (pValueSQL, pInterval) =>
{
	if (!Object.prototype.hasOwnProperty.call(DATE_TRUNC_UNITS, pInterval))
	{
		return null;
	}
	return `date_trunc('${DATE_TRUNC_UNITS[pInterval]}', ${pValueSQL})`;
};

/**
 * @param {string} pColumnSQL
 * @param {string|null} pFromName
 * @param {string|null} pToName
 * @return {string}
 */
const intervalCondition = (pColumnSQL, pFromName, pToName) =>
{
	let tmpParts = [];
	if (pFromName)
	{
		tmpParts.push(`${pColumnSQL} >= ${bindNumeric(pFromName)}`);
	}
	if (pToName)
	{
		tmpParts.push(`${pColumnSQL} < ${bindNumeric(pToName)}`);
	}
	return (tmpParts.length > 0) ? tmpParts.join(' AND ') : '1 = 1';
};

const EXPRESSIONS = (
	{
		/**
		 * The bucket key string ('YYYY-MM-DD HH:mm:ss' bucket start) of a column.
		 *
		 * @param {string} pColumnSQL
		 * @param {string} pInterval
		 * @return {string|null}
		 */
		dateKey: (pColumnSQL, pInterval) =>
		{
			let tmpBucket = dateBucket(pColumnSQL, pInterval);
			return tmpBucket ? `to_char(${tmpBucket}, ${CANONICAL_FORMAT})` : null;
		},

		/**
		 * Bucket index (internal-contracts §10.3.2) with :fFactor, :fLoUnits, :fWidthUnits, :fLastIndex:
		 * the integer-unit candidate, corrected by one against the exact (numeric) edges with the raw
		 * value, as the bucket's NumericRange Clause compares it.
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericIndex: (pColumnSQL) =>
		{
			let tmpCandidate = `LEAST(FLOOR((ROUND(${pColumnSQL} * ${bindNumeric('fFactor')}) - ${bindNumeric('fLoUnits')}) / ${bindNumeric('fWidthUnits')}), ${bindNumeric('fLastIndex')})`;
			let fEdge = (pIndexSQL) => { return `((${bindNumeric('fLoUnits')} + (${pIndexSQL}) * ${bindNumeric('fWidthUnits')}) / ${bindNumeric('fFactor')})`; };
			return `CASE WHEN ${pColumnSQL} < ${fEdge(tmpCandidate)} THEN ${tmpCandidate} - 1`
				+ ` WHEN ${tmpCandidate} < ${bindNumeric('fLastIndex')} AND ${pColumnSQL} >= ${fEdge(`${tmpCandidate} + 1`)} THEN ${tmpCandidate} + 1`
				+ ` ELSE ${tmpCandidate} END`;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		dateCanonical: (pColumnSQL) =>
		{
			return `to_char(${pColumnSQL}, ${CANONICAL_FORMAT})`;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		dateValue: (pColumnSQL) =>
		{
			return pColumnSQL;
		},

		dateBucket: dateBucket,

		/**
		 * A numeric measure value (typed columns cannot hold '' here).
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericValue: (pColumnSQL) =>
		{
			return pColumnSQL;
		},

		/**
		 * PostgreSQL deterministic collations already compare and group strings exactly.
		 *
		 * @param {string} pColumnSQL
		 * @param {string} pDataType
		 * @return {string}
		 */
		valueKey: (pColumnSQL, pDataType) =>
		{
			return pColumnSQL;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		sumUnits: (pColumnSQL, pFactorBind) =>
		{
			return `sum(ROUND(${pColumnSQL} * ${bindNumeric(pFactorBind || 'fFactor')}))`;
		},

		/**
		 * @param {string} pColumnSQL
		 * @param {Array<string>} pEdgeNames
		 * @param {boolean} pOpenEnded
		 * @return {string}
		 */
		edgesIndex: (pColumnSQL, pEdgeNames, pOpenEnded) =>
		{
			let tmpWhens = [];
			for (let i = 0; i < (pEdgeNames.length - 1); i++)
			{
				tmpWhens.push(`WHEN ${intervalCondition(pColumnSQL, pEdgeNames[i], pEdgeNames[i + 1])} THEN ${i}`);
			}
			if (pOpenEnded && (pEdgeNames.length > 0))
			{
				tmpWhens.push(`WHEN ${intervalCondition(pColumnSQL, pEdgeNames[pEdgeNames.length - 1], null)} THEN ${pEdgeNames.length - 1}`);
			}
			return `CASE ${tmpWhens.join(' ')} ELSE NULL END`;
		},

		/**
		 * @param {string} pColumnSQL
		 * @param {Array<{ From: string|null, To: string|null }>} pRangeNames
		 * @return {string}
		 */
		rangeIndex: (pColumnSQL, pRangeNames) =>
		{
			let tmpWhens = [ `WHEN ${pColumnSQL} IS NULL THEN -1` ];
			for (let i = 0; i < pRangeNames.length; i++)
			{
				tmpWhens.push(`WHEN ${intervalCondition(pColumnSQL, pRangeNames[i].From, pRangeNames[i].To)} THEN ${i}`);
			}
			return `CASE ${tmpWhens.join(' ')} ELSE -2 END`;
		},

		// M2 ------------------------------------------------------------------------------------------

		/**
		 * ChildRollup band (01 §4.6).
		 *
		 * @param {string} pColumnSQL
		 * @param {Array<string>} pEdgeNames
		 * @return {string}
		 */
		bandIndex: (pColumnSQL, pEdgeNames) =>
		{
			let tmpWhens = [ `WHEN ${pColumnSQL} IS NULL OR ${pColumnSQL} < ${bindNumeric(pEdgeNames[0])} THEN 0` ];
			for (let i = 1; i < pEdgeNames.length; i++)
			{
				tmpWhens.push(`WHEN ${pColumnSQL} < ${bindNumeric(pEdgeNames[i])} THEN ${i}`);
			}
			return `CASE ${tmpWhens.join(' ')} ELSE ${pEdgeNames.length} END`;
		},

		/**
		 * A per-group date bound, formatted canonically.
		 *
		 * @param {string} pAggregate - 'min' | 'max'
		 * @param {string} pValueSQL
		 * @return {string}
		 */
		dateBound: (pAggregate, pValueSQL) =>
		{
			return `to_char(${(pAggregate === 'max') ? 'max' : 'min'}(${pValueSQL}), ${CANONICAL_FORMAT})`;
		},

		/**
		 * One array-literal bind per key column ('{1,2,3}', cast to bigint[] in SQL).
		 *
		 * @param {string} pAlias
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindNames: (pAlias, pColumnCount) =>
		{
			let tmpNames = [];
			for (let i = 0; i < pColumnCount; i++)
			{
				tmpNames.push(`${pAlias}_K${i}`);
			}
			return tmpNames;
		},

		/**
		 * @param {Array<Array<number>>} pKeys
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindValues: (pKeys, pColumnCount) =>
		{
			let tmpValues = [];
			for (let i = 0; i < pColumnCount; i++)
			{
				tmpValues.push(`{${pKeys.map((pKey) => { return String(pKey[i]); }).join(',')}}`);
			}
			return tmpValues;
		},

		/**
		 * @param {Array<string>} pOuterSQLs
		 * @param {Array<string>} pBindNames
		 * @param {boolean} pNegated
		 * @return {string}
		 */
		stagedMembership: (pOuterSQLs, pBindNames, pNegated) =>
		{
			if ((pOuterSQLs.length === 1) && !pNegated)
			{
				return `${pOuterSQLs[0]} = ANY(CAST(${bind(pBindNames[0])} AS bigint[]))`;
			}
			let tmpArrays = pBindNames.map((pName) => { return `CAST(${bind(pName)} AS bigint[])`; }).join(', ');
			let tmpColumns = pOuterSQLs.map((pOuterSQL, pIndex) => { return `"a${pIndex}"`; }).join(', ');
			let tmpPairs = pOuterSQLs.map((pOuterSQL, pIndex) => { return `"v"."a${pIndex}" = ${pOuterSQL}`; });
			return `${pNegated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM unnest(${tmpArrays}) AS "v"(${tmpColumns}) WHERE ${tmpPairs.join(' AND ')})`;
		}
	});

module.exports = (
	{
		Dialect: DIALECT,
		Sigil: SIGIL,
		Templates: TEMPLATES,
		Expressions: EXPRESSIONS
	});
