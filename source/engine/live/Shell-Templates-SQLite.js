/**
 * Retold Faceting - Shell templates: SQLite
 *
 * PURE DATA: zero requires.  Consumed by the RetoldFacetingShellTemplates registry.
 *
 * SQLite >= 3.25 (window functions); TEXT dates bucketed with strftime (03 §3.4 table); no
 * GROUPING SETS (Pivot = one GROUP BY k1, k2; marginals in post-processing); NULL predicates
 * arrive from FilterAST as 'IS :p' with a NULL bind (internal-contracts §4.5).
 *
 * Every template may reference ONLY the slots _Params.SR<n>, _Params.D<n>, _Params.P<n>,
 * _Params.JOINS, _Params.WHERE, _Params.AND_WHERE (the registry tag-scans them) and scalar bound
 * shell parameters named f* (fTopPlusOne, fFactor, fLoUnits, fWidthUnits, fLastIndex, fE<n>, …).
 * Never a JS array, never a value in template text.
 *
 * Conventions shared by every dialect module (the registry and EngineLive rely on them):
 *   - the pivot Scoped Relation is always aliased "p"; grouped shells group a derived table "d"
 *     by its column (never by ordinal, never by a parameterized expression);
 *   - D0 / D1 are the dimension (or measure) expressions the registry renders from the
 *     Expressions below;
 *   - result columns: Count → Total; Terms → Key, Count, FacetTotal, FacetMissing, FacetDistinct;
 *     DateHistogram → Key, Count, Lo, Hi (one row per key, NULL key = Missing);
 *     NumericBounds → Rows, NonNull, Lo, Hi; NumericHistogram → Key (bucket index), Count;
 *     Ranges → Key (range index; -1 = NULL value, -2 = no range), Count;
 *     Stats → Rows, NonNull, Min, Max, SumUnits; DistinctCount → Rows, NonNull, Distinct;
 *     Missing → Rows, NonNull; Pivot → K1, K2, Count.
 *
 * Every grouped template returns a bounded number of rows (fMaxGroups; Terms also fTopPlusOne and
 * the selected-key slot P0), see Retold-Faceting-ShellTemplates.js.
 *
 * NOTE (node:sqlite): every JS number binds as REAL, so integer arithmetic on bound values is
 * always closed with an explicit CAST(... AS INTEGER).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const DIALECT = 'SQLite';

const SIGIL = ':';

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
		// The envelope Total (Agg Kind 'Count'): one row { Total }.
		Count: 'SELECT count(*) AS "Total" FROM (<%= _Params.SR0 %>) "p"',

		// K1: every group whose count rank (NULL key last) is within Top + 1, so every key tied at the
		// cut is returned and the canonical tie-break (compareKeys) happens in JS — capped at
		// fMaxGroups rows in SQL key order — plus the selected keys (P0); window totals give the
		// true facet Total, Missing and DistinctKeys in the same statement.
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
			+ ' WHERE ("r"."RowRank" <= :fTopPlusOne AND "r"."RowNumber" <= :fMaxGroups)<%= _Params.P0 %>',

		// K2: D1 = canonical 'YYYY-MM-DD HH:mm:ss' (NULL when not a date), D0 = bucket start computed
		// from "v"."Value".  Lo/Hi per key; the engine reduces them to Bounds.  At most fMaxGroups keys.
		DateHistogram: 'SELECT "g"."Key" AS "Key", "g"."Count" AS "Count", "g"."Lo" AS "Lo", "g"."Hi" AS "Hi"'
			+ ' FROM (SELECT "k"."Key" AS "Key", count(*) AS "Count", min("k"."Value") AS "Lo", max("k"."Value") AS "Hi", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key", "v"."Value" AS "Value"'
			+ ' FROM (SELECT <%= _Params.D1 %> AS "Value" FROM (<%= _Params.SR0 %>) "p") "v") "k"'
			+ ' GROUP BY "k"."Key") "g"'
			+ ' WHERE "g"."RowNumber" <= :fMaxGroups',

		// K3 pass 1: rows, non-null rows and bounds of the measured column.
		NumericBounds: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", min(<%= _Params.D0 %>) AS "Lo", max(<%= _Params.D0 %>) AS "Hi"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		// K3 pass 2: D0 = the bucket index (Nice: integer units; Edges: CASE, NULL = outside), D1 = the column.
		NumericHistogram: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p" WHERE <%= _Params.D1 %> IS NOT NULL) "d"'
			+ ' GROUP BY "d"."Key"',

		// K4: D0 = first-matching range index, -1 for NULL, -2 for no range.
		Ranges: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."Key"',

		// K5: D0 = the value (canonical text for dates), D1 = the integer-unit sum aggregate (or NULL).
		Stats: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", min(<%= _Params.D0 %>) AS "Min", max(<%= _Params.D0 %>) AS "Max", <%= _Params.D1 %> AS "SumUnits"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		// K6
		DistinctCount: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull", count(DISTINCT <%= _Params.D0 %>) AS "Distinct"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		// K7
		Missing: 'SELECT count(*) AS "Rows", count(<%= _Params.D0 %>) AS "NonNull"'
			+ ' FROM (<%= _Params.SR0 %>) "p"',

		// K14: every non-empty cell (NULL keys included), at most fMaxGroups; marginals and Top per
		// axis in post-processing.
		Pivot: 'SELECT "c"."K1" AS "K1", "c"."K2" AS "K2", "c"."Count" AS "Count"'
			+ ' FROM (SELECT "d"."K1" AS "K1", "d"."K2" AS "K2", count(*) AS "Count", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "K1", <%= _Params.D1 %> AS "K2" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."K1", "d"."K2") "c"'
			+ ' WHERE "c"."RowNumber" <= :fMaxGroups',

		// M2 (internal-contracts §26.4) ------------------------------------------------------------

		// K12 ChildRollup bands / K20 ExistsSplit flags: D0 = the per-row key (band index, 0/1).
		KeyGroups: 'SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT <%= _Params.D0 %> AS "Key" FROM (<%= _Params.SR0 %>) "p") "d"'
			+ ' GROUP BY "d"."Key"',

		// K9: two-level distinct (never count(DISTINCT …)): D0 = the key on the chain's last relation,
		// D1 = the pivot's primary key, JOINS = the chain, AND_WHERE = the chain's path predicates.
		// Ranked and capped like Terms (fTopPlusOne, fMaxGroups, the selected keys in P0).
		MultiTerms: 'SELECT "r"."Key" AS "Key", "r"."Count" AS "Count", "r"."FacetDistinct" AS "FacetDistinct"'
			+ ' FROM (SELECT "t"."Key" AS "Key", "t"."Count" AS "Count",'
			+ ' count(*) OVER () AS "FacetDistinct",'
			+ ' rank() OVER (ORDER BY "t"."Count" DESC) AS "RowRank",'
			+ ' row_number() OVER (ORDER BY "t"."Count" DESC, "t"."Key") AS "RowNumber"'
			+ ' FROM (SELECT "d"."Key" AS "Key", count(*) AS "Count"'
			+ ' FROM (SELECT DISTINCT <%= _Params.D0 %> AS "Key", <%= _Params.D1 %> AS "PK" FROM (<%= _Params.SR0 %>) "p"<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) "d"'
			+ ' GROUP BY "d"."Key") "t") "r"'
			+ ' WHERE ("r"."RowRank" <= :fTopPlusOne AND "r"."RowNumber" <= :fMaxGroups)<%= _Params.P0 %>',

		// K9: pivot rows with at least one key (MissingCount = Total - Covered).
		MultiCovered: 'SELECT count(*) AS "Covered"'
			+ ' FROM (SELECT DISTINCT <%= _Params.D1 %> AS "PK" FROM (<%= _Params.SR0 %>) "p"<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) "k"',

		// The conditional disjunctive scan (§25.3): D0 = per-row dimension keys, flags and bound values;
		// D2 = the grouped columns and per-group aggregates; D3 = the GROUP BY list; D1 = the outer list.
		Cube: 'SELECT <%= _Params.D1 %>'
			+ ' FROM (SELECT <%= _Params.D2 %>, count(*) AS "N", row_number() OVER () AS "RowNumber"'
			+ ' FROM (SELECT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) "p") "g"'
			+ ' GROUP BY <%= _Params.D3 %>) "c"'
			+ ' WHERE "c"."RowNumber" <= :fMaxGroups',

		// Records (§26.5): D1 = the primary key, D0 = the ORDER BY list (NULLs last, PK tie-break).
		RecordKeys: 'SELECT <%= _Params.D1 %> AS "Key" FROM (<%= _Params.SR0 %>) "p"'
			+ ' ORDER BY <%= _Params.D0 %> LIMIT CAST(:fCap AS INTEGER) OFFSET CAST(:fBegin AS INTEGER)',

		// Keys (§26.5): ordered by the primary key, one past the cap tells Truncated.
		Keys: 'SELECT <%= _Params.D1 %> AS "Key" FROM (<%= _Params.SR0 %>) "p"'
			+ ' ORDER BY <%= _Params.D1 %> LIMIT CAST(:fCapPlusOne AS INTEGER)',

		// Staged hop (§26.3): the distinct correlation keys of one scoped relation, one past the cap.
		StagedKeys: 'SELECT DISTINCT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) "p"'
			+ ' LIMIT CAST(:fCapPlusOne AS INTEGER)'
	});

/**
 * Canonical 'YYYY-MM-DD HH:mm:ss' of a TEXT date, or NULL when the value is not a date the
 * contract's canonicalDateTime accepts.  strftime parses more than the contract does, so the
 * text is re-checked against strftime's own reading: the date part must round-trip (rejects
 * '2026-02-30', which strftime normalizes), the HH:MM part must round-trip (rejects any non-zero
 * UTC offset, which strftime applies), hour 24 is refused (strftime keeps it), the separator is
 * ' ' or 'T', and no whitespace follows.  Non-text values are refused (SQLite would read a number
 * as a Julian day).
 *
 * @param {string} pColumnSQL
 * @return {string}
 */
const dateCanonical = (pColumnSQL) =>
{
	return `CASE WHEN typeof(${pColumnSQL}) = 'text'`
		+ ` AND substr(${pColumnSQL}, 1, 10) = strftime('%Y-%m-%d', ${pColumnSQL})`
		+ ` AND (length(${pColumnSQL}) = 10 OR (substr(${pColumnSQL}, 11, 1) IN (' ', 'T')`
		+ ` AND substr(${pColumnSQL}, 12, 5) = strftime('%H:%M', ${pColumnSQL})`
		+ ` AND substr(${pColumnSQL}, 12, 2) < '24'`
		+ ` AND instr(substr(${pColumnSQL}, 12), ' ') = 0`
		+ ` AND rtrim(${pColumnSQL}, char(9, 10, 11, 12, 13)) = ${pColumnSQL}))`
		+ ` THEN strftime('%Y-%m-%d %H:%M:%S', ${pColumnSQL}) END`;
};

/**
 * The bucket start of a canonical date value (NULL stays NULL).
 *
 * @param {string} pValueSQL - a canonical date expression or column
 * @param {string} pInterval
 * @return {string|null}
 */
const dateBucket = (pValueSQL, pInterval) =>
{
	switch (pInterval)
	{
		case 'day':
			return `strftime('%Y-%m-%d 00:00:00', ${pValueSQL})`;
		case 'week':
			// ISO Monday on or before the date
			return `strftime('%Y-%m-%d 00:00:00', ${pValueSQL}, '-6 days', 'weekday 1')`;
		case 'month':
			return `strftime('%Y-%m-01 00:00:00', ${pValueSQL})`;
		case 'quarter':
			// '||' with a NULL year yields NULL, so a non-date never becomes a phantom quarter
			return `strftime('%Y-', ${pValueSQL}) || CASE (CAST(strftime('%m', ${pValueSQL}) AS INTEGER) - 1) / 3 WHEN 0 THEN '01' WHEN 1 THEN '04' WHEN 2 THEN '07' ELSE '10' END || '-01 00:00:00'`;
		case 'year':
			return `strftime('%Y-01-01 00:00:00', ${pValueSQL})`;
		default:
			return null;
	}
};

/**
 * WHEN-condition for one numeric interval [From, To) (either bound may be absent).
 *
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

const EXPRESSIONS = (
	{
		/**
		 * The SQL expression for a date bucket key ('YYYY-MM-DD HH:mm:ss' bucket start) of an
		 * alias-qualified, already-quoted column expression.
		 *
		 * @param {string} pColumnSQL - e.g. "p"."SaleDate"
		 * @param {string} pInterval - day | week | month | quarter | year
		 * @return {string|null} null for an unknown interval
		 */
		dateKey: (pColumnSQL, pInterval) =>
		{
			return dateBucket(dateCanonical(pColumnSQL), pInterval);
		},

		/**
		 * The SQL expression for the numeric bucket index (internal-contracts §10.3.2), using the bound
		 * scalars :fFactor, :fLoUnits, :fWidthUnits, :fLastIndex: the integer-unit candidate (the
		 * numerator is never negative, so truncation is floor), corrected by one against the exact
		 * edges with the RAW value — the comparison the bucket's NumericRange Clause makes.  An edge
		 * (LoUnits + i × WidthUnits) / Factor divides two exact doubles, so it equals the contract's
		 * edge value bit for bit.
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericIndex: (pColumnSQL) =>
		{
			let tmpCandidate = `min(CAST((CAST(ROUND(${pColumnSQL} * ${bind('fFactor')}) AS INTEGER) - ${bind('fLoUnits')}) / ${bind('fWidthUnits')} AS INTEGER), ${bind('fLastIndex')})`;
			let fEdge = (pIndexSQL) => { return `((${bind('fLoUnits')} + (${pIndexSQL}) * ${bind('fWidthUnits')}) / ${bind('fFactor')})`; };
			return `CASE WHEN ${pColumnSQL} < ${fEdge(tmpCandidate)} THEN ${tmpCandidate} - 1`
				+ ` WHEN ${tmpCandidate} < ${bind('fLastIndex')} AND ${pColumnSQL} >= ${fEdge(`${tmpCandidate} + 1`)} THEN ${tmpCandidate} + 1`
				+ ` ELSE ${tmpCandidate} END`;
		},

		dateCanonical: dateCanonical,

		/**
		 * The per-row date value DateHistogram groups and bounds over (canonical text on SQLite).
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		dateValue: (pColumnSQL) =>
		{
			return dateCanonical(pColumnSQL);
		},

		dateBucket: dateBucket,

		/**
		 * A numeric measure value: SQLite keeps '' and non-numeric text in numeric-affinity columns,
		 * which the contract counts as Missing, so only the INTEGER / REAL storage classes are values.
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericValue: (pColumnSQL) =>
		{
			return `CASE WHEN typeof(${pColumnSQL}) IN ('integer', 'real') THEN ${pColumnSQL} END`;
		},

		/**
		 * A Terms / Pivot / DistinctCount key (SQLite compares TEXT with BINARY collation already).
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
		 * The exact integer-unit sum aggregate (Stats SumUnits) with :fFactor.
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		sumUnits: (pColumnSQL, pFactorBind) =>
		{
			return `sum(CAST(ROUND(${pColumnSQL} * ${bind(pFactorBind || 'fFactor')}) AS INTEGER))`;
		},

		/**
		 * Explicit-edges bucket index: i for Edges[i] <= v < Edges[i+1]; the open bucket v >= Edges[last]
		 * when pOpenEnded; NULL otherwise (Other).
		 *
		 * @param {string} pColumnSQL
		 * @param {Array<string>} pEdgeNames - bound names of the edges, ascending
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
		 * Ranges index: -1 for NULL, the first matching declared range, else -2.
		 *
		 * @param {string} pColumnSQL
		 * @param {Array<{ From: string|null, To: string|null }>} pRangeNames - bound names per range
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
		 * ChildRollup band (01 §4.6): 0 when the aggregate is NULL or below the first edge, band i for
		 * [Edges[i-1], Edges[i]), the last band open.
		 *
		 * @param {string} pColumnSQL
		 * @param {Array<string>} pEdgeNames - bound names of the ascending edges
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
		 * A per-group date bound as canonical text (SQLite values already are).
		 *
		 * @param {string} pAggregate - 'min' | 'max'
		 * @param {string} pValueSQL
		 * @return {string}
		 */
		dateBound: (pAggregate, pValueSQL) =>
		{
			return `${(pAggregate === 'max') ? 'max' : 'min'}(${pValueSQL})`;
		},

		/**
		 * The bound names of a staged key set: ONE JSON text for any number of key columns.
		 *
		 * @param {string} pAlias
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindNames: (pAlias, pColumnCount) =>
		{
			return [ `${pAlias}_Keys` ];
		},

		/**
		 * The bound values for stagedBindNames: '[1,2]' (one column) or '[[7,3],[8,1]]' (composite).
		 *
		 * @param {Array<Array<number>>} pKeys - distinct integer tuples
		 * @param {number} pColumnCount
		 * @return {Array<string>}
		 */
		stagedBindValues: (pKeys, pColumnCount) =>
		{
			return [ JSON.stringify((pColumnCount === 1) ? pKeys.map((pKey) => { return pKey[0]; }) : pKeys) ];
		},

		/**
		 * Membership of the outer columns in a staged key set (one scalar bind; NOT EXISTS for an
		 * anti-join so a NULL outer column is "no visible match", never unknown).
		 *
		 * @param {Array<string>} pOuterSQLs - alias-qualified outer columns, in key order
		 * @param {Array<string>} pBindNames - stagedBindNames()
		 * @param {boolean} pNegated
		 * @return {string}
		 */
		stagedMembership: (pOuterSQLs, pBindNames, pNegated) =>
		{
			let tmpSource = `json_each(${bind(pBindNames[0])}) AS "v"`;
			if (pOuterSQLs.length === 1)
			{
				return pNegated
					? `NOT EXISTS (SELECT 1 FROM ${tmpSource} WHERE "v"."value" = ${pOuterSQLs[0]})`
					: `${pOuterSQLs[0]} IN (SELECT "v"."value" FROM ${tmpSource})`;
			}
			let tmpPairs = pOuterSQLs.map((pOuterSQL, pIndex) => { return `json_extract("v"."value", '$[${pIndex}]') = ${pOuterSQL}`; });
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
