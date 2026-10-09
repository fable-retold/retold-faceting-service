/**
 * Retold Faceting - Shell templates: MySQL
 *
 * PURE DATA: zero requires.  Consumed by the RetoldFacetingShellTemplates registry.
 *
 * Dry-built only in M1 (executed from M2).  MySQL 8 (window functions; 5.7 needs the two-statement
 * Terms form, a later DialectCapabilities concern).  Backtick identifiers (double quotes are string
 * literals without ANSI_QUOTES); DATE_FORMAT per 03 §3.4 (one level suffices: the truncation already
 * yields a sortable string); string keys grouped and counted under a binary collation so 'Credit'
 * and 'credit' stay two keys exactly as on every other engine.  Same slot and result-column
 * conventions as Shell-Templates-SQLite.js.
 *
 * Every template may reference ONLY the slots _Params.SR<n>, _Params.D<n>, _Params.P<n>,
 * _Params.JOINS, _Params.WHERE, _Params.AND_WHERE (the registry tag-scans them) and scalar bound
 * shell parameters named f* (fTopPlusOne, fFactor, fLoUnits, fWidthUnits, fLastIndex, fE<n>, …).
 * Never a JS array, never a value in template text.
 *
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const DIALECT = 'MySQL';

const SIGIL = ':';

const CANONICAL_FORMAT = '\'%Y-%m-%d %H:%i:%s\'';

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

const TEMPLATES = (
	{
		Count: 'SELECT count(*) AS `Total` FROM (<%= _Params.SR0 %>) `p`',

		Terms: 'SELECT `r`.`Key` AS `Key`, `r`.`Count` AS `Count`, `r`.`FacetTotal` AS `FacetTotal`, `r`.`FacetMissing` AS `FacetMissing`, `r`.`FacetDistinct` AS `FacetDistinct`'
			+ ' FROM (SELECT `t`.`Key` AS `Key`, `t`.`Count` AS `Count`,'
			+ ' sum(`t`.`Count`) OVER () AS `FacetTotal`,'
			+ ' sum(CASE WHEN `t`.`Key` IS NULL THEN `t`.`Count` ELSE 0 END) OVER () AS `FacetMissing`,'
			+ ' count(`t`.`Key`) OVER () AS `FacetDistinct`,'
			+ ' rank() OVER (ORDER BY CASE WHEN `t`.`Key` IS NULL THEN 1 ELSE 0 END, `t`.`Count` DESC) AS `RowRank`,'
			+ ' row_number() OVER (ORDER BY CASE WHEN `t`.`Key` IS NULL THEN 1 ELSE 0 END, `t`.`Count` DESC, `t`.`Key`) AS `RowNumber`'
			+ ' FROM (SELECT `d`.`Key` AS `Key`, count(*) AS `Count`'
			+ ' FROM (SELECT <%= _Params.D0 %> AS `Key` FROM (<%= _Params.SR0 %>) `p`) `d`'
			+ ' GROUP BY `d`.`Key`) `t`) `r`'
			+ ' WHERE (`r`.`RowRank` <= :fTopPlusOne AND `r`.`RowNumber` <= :fMaxGroups)<%= _Params.P0 %>',

		DateHistogram: 'SELECT `g`.`Key` AS `Key`, `g`.`Count` AS `Count`, `g`.`Lo` AS `Lo`, `g`.`Hi` AS `Hi`'
			+ ` FROM (SELECT \`k\`.\`Key\` AS \`Key\`, count(*) AS \`Count\`, DATE_FORMAT(min(\`k\`.\`Value\`), ${CANONICAL_FORMAT}) AS \`Lo\`, DATE_FORMAT(max(\`k\`.\`Value\`), ${CANONICAL_FORMAT}) AS \`Hi\`, row_number() OVER () AS \`RowNumber\``
			+ ' FROM (SELECT <%= _Params.D0 %> AS `Key`, `v`.`Value` AS `Value`'
			+ ' FROM (SELECT <%= _Params.D1 %> AS `Value` FROM (<%= _Params.SR0 %>) `p`) `v`) `k`'
			+ ' GROUP BY `k`.`Key`) `g`'
			+ ' WHERE `g`.`RowNumber` <= :fMaxGroups',

		NumericBounds: 'SELECT count(*) AS `Rows`, count(<%= _Params.D0 %>) AS `NonNull`, min(<%= _Params.D0 %>) AS `Lo`, max(<%= _Params.D0 %>) AS `Hi`'
			+ ' FROM (<%= _Params.SR0 %>) `p`',

		NumericHistogram: 'SELECT `d`.`Key` AS `Key`, count(*) AS `Count`'
			+ ' FROM (SELECT <%= _Params.D0 %> AS `Key` FROM (<%= _Params.SR0 %>) `p` WHERE <%= _Params.D1 %> IS NOT NULL) `d`'
			+ ' GROUP BY `d`.`Key`',

		Ranges: 'SELECT `d`.`Key` AS `Key`, count(*) AS `Count`'
			+ ' FROM (SELECT <%= _Params.D0 %> AS `Key` FROM (<%= _Params.SR0 %>) `p`) `d`'
			+ ' GROUP BY `d`.`Key`',

		Stats: 'SELECT count(*) AS `Rows`, count(<%= _Params.D0 %>) AS `NonNull`, min(<%= _Params.D0 %>) AS `Min`, max(<%= _Params.D0 %>) AS `Max`, <%= _Params.D1 %> AS `SumUnits`'
			+ ' FROM (<%= _Params.SR0 %>) `p`',

		DistinctCount: 'SELECT count(*) AS `Rows`, count(<%= _Params.D0 %>) AS `NonNull`, count(DISTINCT <%= _Params.D0 %>) AS `Distinct`'
			+ ' FROM (<%= _Params.SR0 %>) `p`',

		Missing: 'SELECT count(*) AS `Rows`, count(<%= _Params.D0 %>) AS `NonNull`'
			+ ' FROM (<%= _Params.SR0 %>) `p`',

		Pivot: 'SELECT `c`.`K1` AS `K1`, `c`.`K2` AS `K2`, `c`.`Count` AS `Count`'
			+ ' FROM (SELECT `d`.`K1` AS `K1`, `d`.`K2` AS `K2`, count(*) AS `Count`, row_number() OVER () AS `RowNumber`'
			+ ' FROM (SELECT <%= _Params.D0 %> AS `K1`, <%= _Params.D1 %> AS `K2` FROM (<%= _Params.SR0 %>) `p`) `d`'
			+ ' GROUP BY `d`.`K1`, `d`.`K2`) `c`'
			+ ' WHERE `c`.`RowNumber` <= :fMaxGroups',

		// M2 (internal-contracts §26.4; dry-built only in M2) ---------------------------------------

		KeyGroups: 'SELECT `d`.`Key` AS `Key`, count(*) AS `Count`'
			+ ' FROM (SELECT <%= _Params.D0 %> AS `Key` FROM (<%= _Params.SR0 %>) `p`) `d`'
			+ ' GROUP BY `d`.`Key`',

		MultiTerms: 'SELECT `r`.`Key` AS `Key`, `r`.`Count` AS `Count`, `r`.`FacetDistinct` AS `FacetDistinct`'
			+ ' FROM (SELECT `t`.`Key` AS `Key`, `t`.`Count` AS `Count`,'
			+ ' count(*) OVER () AS `FacetDistinct`,'
			+ ' rank() OVER (ORDER BY `t`.`Count` DESC) AS `RowRank`,'
			+ ' row_number() OVER (ORDER BY `t`.`Count` DESC, `t`.`Key`) AS `RowNumber`'
			+ ' FROM (SELECT `d`.`Key` AS `Key`, count(*) AS `Count`'
			+ ' FROM (SELECT DISTINCT <%= _Params.D0 %> AS `Key`, <%= _Params.D1 %> AS `PK` FROM (<%= _Params.SR0 %>) `p`<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) `d`'
			+ ' GROUP BY `d`.`Key`) `t`) `r`'
			+ ' WHERE (`r`.`RowRank` <= :fTopPlusOne AND `r`.`RowNumber` <= :fMaxGroups)<%= _Params.P0 %>',

		MultiCovered: 'SELECT count(*) AS `Covered`'
			+ ' FROM (SELECT DISTINCT <%= _Params.D1 %> AS `PK` FROM (<%= _Params.SR0 %>) `p`<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) `k`',

		Cube: 'SELECT <%= _Params.D1 %>'
			+ ' FROM (SELECT <%= _Params.D2 %>, count(*) AS `N`, row_number() OVER () AS `RowNumber`'
			+ ' FROM (SELECT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) `p`) `g`'
			+ ' GROUP BY <%= _Params.D3 %>) `c`'
			+ ' WHERE `c`.`RowNumber` <= :fMaxGroups',

		RecordKeys: 'SELECT <%= _Params.D1 %> AS `Key` FROM (<%= _Params.SR0 %>) `p`'
			+ ' ORDER BY <%= _Params.D0 %> LIMIT :fCap OFFSET :fBegin',

		Keys: 'SELECT <%= _Params.D1 %> AS `Key` FROM (<%= _Params.SR0 %>) `p`'
			+ ' ORDER BY <%= _Params.D1 %> LIMIT :fCapPlusOne',

		StagedKeys: 'SELECT DISTINCT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) `p`'
			+ ' LIMIT :fCapPlusOne'
	});

/**
 * The bucket key string of a date value.
 *
 * @param {string} pValueSQL
 * @param {string} pInterval
 * @return {string|null}
 */
const dateBucket = (pValueSQL, pInterval) =>
{
	switch (pInterval)
	{
		case 'day':
			return `DATE_FORMAT(${pValueSQL}, '%Y-%m-%d 00:00:00')`;
		case 'week':
			return `DATE_FORMAT(DATE_SUB(DATE(${pValueSQL}), INTERVAL WEEKDAY(${pValueSQL}) DAY), '%Y-%m-%d 00:00:00')`;
		case 'month':
			return `DATE_FORMAT(${pValueSQL}, '%Y-%m-01 00:00:00')`;
		case 'quarter':
			return `CONCAT(YEAR(${pValueSQL}), '-', LPAD((QUARTER(${pValueSQL}) - 1) * 3 + 1, 2, '0'), '-01 00:00:00')`;
		case 'year':
			return `DATE_FORMAT(${pValueSQL}, '%Y-01-01 00:00:00')`;
		default:
			return null;
	}
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
		tmpParts.push(`${pColumnSQL} >= ${bind(pFromName)}`);
	}
	if (pToName)
	{
		tmpParts.push(`${pColumnSQL} < ${bind(pToName)}`);
	}
	return (tmpParts.length > 0) ? tmpParts.join(' AND ') : '1 = 1';
};

const STRING_TYPES = [ 'String', 'Text', 'GUID' ];

const EXPRESSIONS = (
	{
		/**
		 * @param {string} pColumnSQL
		 * @param {string} pInterval
		 * @return {string|null}
		 */
		dateKey: (pColumnSQL, pInterval) =>
		{
			return dateBucket(pColumnSQL, pInterval);
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericIndex: (pColumnSQL) =>
		{
			// Integer-unit candidate, corrected by one against the exact edges with the raw value.
			let tmpCandidate = `LEAST(FLOOR((ROUND(${pColumnSQL} * ${bind('fFactor')}) - ${bind('fLoUnits')}) / ${bind('fWidthUnits')}), ${bind('fLastIndex')})`;
			let fEdge = (pIndexSQL) => { return `((${bind('fLoUnits')} + (${pIndexSQL}) * ${bind('fWidthUnits')}) / ${bind('fFactor')})`; };
			return `CASE WHEN ${pColumnSQL} < ${fEdge(tmpCandidate)} THEN ${tmpCandidate} - 1`
				+ ` WHEN ${tmpCandidate} < ${bind('fLastIndex')} AND ${pColumnSQL} >= ${fEdge(`${tmpCandidate} + 1`)} THEN ${tmpCandidate} + 1`
				+ ` ELSE ${tmpCandidate} END`;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		dateCanonical: (pColumnSQL) =>
		{
			return `DATE_FORMAT(${pColumnSQL}, ${CANONICAL_FORMAT})`;
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
		 * String keys under a binary collation (case- and accent-sensitive, like every other engine).
		 *
		 * @param {string} pColumnSQL
		 * @param {string} pDataType
		 * @return {string}
		 */
		valueKey: (pColumnSQL, pDataType) =>
		{
			if (STRING_TYPES.indexOf(pDataType) >= 0)
			{
				return `CONVERT(${pColumnSQL} USING utf8mb4) COLLATE utf8mb4_bin`;
			}
			return pColumnSQL;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		sumUnits: (pColumnSQL, pFactorBind) =>
		{
			return `sum(ROUND(${pColumnSQL} * ${bind(pFactorBind || 'fFactor')}))`;
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
			let tmpWhens = [ `WHEN ${pColumnSQL} IS NULL OR ${pColumnSQL} < ${bind(pEdgeNames[0])} THEN 0` ];
			for (let i = 1; i < pEdgeNames.length; i++)
			{
				tmpWhens.push(`WHEN ${pColumnSQL} < ${bind(pEdgeNames[i])} THEN ${i}`);
			}
			return `CASE ${tmpWhens.join(' ')} ELSE ${pEdgeNames.length} END`;
		},

		/**
		 * @param {string} pAggregate - 'min' | 'max'
		 * @param {string} pValueSQL
		 * @return {string}
		 */
		dateBound: (pAggregate, pValueSQL) =>
		{
			return `DATE_FORMAT(${(pAggregate === 'max') ? 'max' : 'min'}(${pValueSQL}), ${CANONICAL_FORMAT})`;
		},

		/**
		 * @param {string} pAlias
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindNames: (pAlias, pColumnCount) =>
		{
			return [ `${pAlias}_Keys` ];
		},

		/**
		 * @param {Array<Array<number>>} pKeys
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindValues: (pKeys, pColumnCount) =>
		{
			return [ JSON.stringify((pColumnCount === 1) ? pKeys.map((pKey) => { return pKey[0]; }) : pKeys) ];
		},

		/**
		 * MySQL 8 JSON_TABLE over one JSON text bind.
		 *
		 * @param {Array<string>} pOuterSQLs
		 * @param {Array<string>} pBindNames
		 * @param {boolean} pNegated
		 * @return {string}
		 */
		stagedMembership: (pOuterSQLs, pBindNames, pNegated) =>
		{
			let tmpSingle = (pOuterSQLs.length === 1);
			let tmpColumns = pOuterSQLs.map((pOuterSQL, pIndex) => { return `\`a${pIndex}\` BIGINT PATH '${tmpSingle ? '$' : `$[${pIndex}]`}'`; }).join(', ');
			let tmpSource = `JSON_TABLE(${bind(pBindNames[0])}, '$[*]' COLUMNS (${tmpColumns})) AS \`v\``;
			if (tmpSingle && !pNegated)
			{
				return `${pOuterSQLs[0]} IN (SELECT \`v\`.\`a0\` FROM ${tmpSource})`;
			}
			let tmpPairs = pOuterSQLs.map((pOuterSQL, pIndex) => { return `\`v\`.\`a${pIndex}\` = ${pOuterSQL}`; });
			return `${pNegated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${tmpSource} WHERE ${tmpPairs.join(' AND ')})`;
		}
	});

module.exports = (
	{
		Dialect: DIALECT,
		Sigil: SIGIL,
		Templates: TEMPLATES,
		Expressions: EXPRESSIONS
	});
