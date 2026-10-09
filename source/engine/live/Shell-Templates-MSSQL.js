/**
 * Retold Faceting - Shell templates: MSSQL
 *
 * PURE DATA: zero requires.  Consumed by the RetoldFacetingShellTemplates registry.
 *
 * Dry-built only in M1 (executed from M2).  MSSQL 2012+: '@' sigils and declared parameterTypes
 * (the registry supplies them for every f* bind); bracket identifiers; no GROUP BY ordinals (every
 * grouped shell groups a derived table by its column); no LEAST before 2022 (CASE clamp);
 * DATEFROMPARTS / DATEADD truncation formatted with CONVERT(varchar(19), …, 120) (03 §3.4); string
 * keys under a binary collation.  Same slot and result-column conventions as Shell-Templates-SQLite.js.
 *
 * Every template may reference ONLY the slots _Params.SR<n>, _Params.D<n>, _Params.P<n>,
 * _Params.JOINS, _Params.WHERE, _Params.AND_WHERE (the registry tag-scans them) and scalar bound
 * shell parameters named f* (fTopPlusOne, fFactor, fLoUnits, fWidthUnits, fLastIndex, fE<n>, …).
 * Never a JS array, never a value in template text.
 *
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const DIALECT = 'MSSQL';

const SIGIL = '@';

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
		Count: 'SELECT count(*) AS [Total] FROM (<%= _Params.SR0 %>) [p]',

		Terms: 'SELECT [r].[Key] AS [Key], [r].[Count] AS [Count], [r].[FacetTotal] AS [FacetTotal], [r].[FacetMissing] AS [FacetMissing], [r].[FacetDistinct] AS [FacetDistinct]'
			+ ' FROM (SELECT [t].[Key] AS [Key], [t].[Count] AS [Count],'
			+ ' sum([t].[Count]) OVER () AS [FacetTotal],'
			+ ' sum(CASE WHEN [t].[Key] IS NULL THEN [t].[Count] ELSE 0 END) OVER () AS [FacetMissing],'
			+ ' count([t].[Key]) OVER () AS [FacetDistinct],'
			+ ' rank() OVER (ORDER BY CASE WHEN [t].[Key] IS NULL THEN 1 ELSE 0 END, [t].[Count] DESC) AS [RowRank],'
			+ ' ROW_NUMBER() OVER (ORDER BY CASE WHEN [t].[Key] IS NULL THEN 1 ELSE 0 END, [t].[Count] DESC, [t].[Key]) AS [RowNumber]'
			+ ' FROM (SELECT [d].[Key] AS [Key], count(*) AS [Count]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [Key] FROM (<%= _Params.SR0 %>) [p]) [d]'
			+ ' GROUP BY [d].[Key]) [t]) [r]'
			+ ' WHERE ([r].[RowRank] <= @fTopPlusOne AND [r].[RowNumber] <= @fMaxGroups)<%= _Params.P0 %>',

		DateHistogram: 'SELECT [g].[Key] AS [Key], [g].[Count] AS [Count], [g].[Lo] AS [Lo], [g].[Hi] AS [Hi]'
			+ ' FROM (SELECT [k].[Key] AS [Key], count(*) AS [Count], CONVERT(varchar(19), min([k].[Value]), 120) AS [Lo], CONVERT(varchar(19), max([k].[Value]), 120) AS [Hi], ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [RowNumber]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [Key], [v].[Value] AS [Value]'
			+ ' FROM (SELECT <%= _Params.D1 %> AS [Value] FROM (<%= _Params.SR0 %>) [p]) [v]) [k]'
			+ ' GROUP BY [k].[Key]) [g]'
			+ ' WHERE [g].[RowNumber] <= @fMaxGroups',

		NumericBounds: 'SELECT count(*) AS [Rows], count(<%= _Params.D0 %>) AS [NonNull], min(<%= _Params.D0 %>) AS [Lo], max(<%= _Params.D0 %>) AS [Hi]'
			+ ' FROM (<%= _Params.SR0 %>) [p]',

		NumericHistogram: 'SELECT [d].[Key] AS [Key], count(*) AS [Count]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [Key] FROM (<%= _Params.SR0 %>) [p] WHERE <%= _Params.D1 %> IS NOT NULL) [d]'
			+ ' GROUP BY [d].[Key]',

		Ranges: 'SELECT [d].[Key] AS [Key], count(*) AS [Count]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [Key] FROM (<%= _Params.SR0 %>) [p]) [d]'
			+ ' GROUP BY [d].[Key]',

		Stats: 'SELECT count(*) AS [Rows], count(<%= _Params.D0 %>) AS [NonNull], min(<%= _Params.D0 %>) AS [Min], max(<%= _Params.D0 %>) AS [Max], <%= _Params.D1 %> AS [SumUnits]'
			+ ' FROM (<%= _Params.SR0 %>) [p]',

		DistinctCount: 'SELECT count(*) AS [Rows], count(<%= _Params.D0 %>) AS [NonNull], count(DISTINCT <%= _Params.D0 %>) AS [Distinct]'
			+ ' FROM (<%= _Params.SR0 %>) [p]',

		Missing: 'SELECT count(*) AS [Rows], count(<%= _Params.D0 %>) AS [NonNull]'
			+ ' FROM (<%= _Params.SR0 %>) [p]',

		Pivot: 'SELECT [c].[K1] AS [K1], [c].[K2] AS [K2], [c].[Count] AS [Count]'
			+ ' FROM (SELECT [d].[K1] AS [K1], [d].[K2] AS [K2], count(*) AS [Count], ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [RowNumber]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [K1], <%= _Params.D1 %> AS [K2] FROM (<%= _Params.SR0 %>) [p]) [d]'
			+ ' GROUP BY [d].[K1], [d].[K2]) [c]'
			+ ' WHERE [c].[RowNumber] <= @fMaxGroups',

		// M2 (internal-contracts §26.4; dry-built only in M2) ---------------------------------------

		KeyGroups: 'SELECT [d].[Key] AS [Key], count(*) AS [Count]'
			+ ' FROM (SELECT <%= _Params.D0 %> AS [Key] FROM (<%= _Params.SR0 %>) [p]) [d]'
			+ ' GROUP BY [d].[Key]',

		MultiTerms: 'SELECT [r].[Key] AS [Key], [r].[Count] AS [Count], [r].[FacetDistinct] AS [FacetDistinct]'
			+ ' FROM (SELECT [t].[Key] AS [Key], [t].[Count] AS [Count],'
			+ ' count(*) OVER () AS [FacetDistinct],'
			+ ' rank() OVER (ORDER BY [t].[Count] DESC) AS [RowRank],'
			+ ' ROW_NUMBER() OVER (ORDER BY [t].[Count] DESC, [t].[Key]) AS [RowNumber]'
			+ ' FROM (SELECT [d].[Key] AS [Key], count(*) AS [Count]'
			+ ' FROM (SELECT DISTINCT <%= _Params.D0 %> AS [Key], <%= _Params.D1 %> AS [PK] FROM (<%= _Params.SR0 %>) [p]<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) [d]'
			+ ' GROUP BY [d].[Key]) [t]) [r]'
			+ ' WHERE ([r].[RowRank] <= @fTopPlusOne AND [r].[RowNumber] <= @fMaxGroups)<%= _Params.P0 %>',

		MultiCovered: 'SELECT count(*) AS [Covered]'
			+ ' FROM (SELECT DISTINCT <%= _Params.D1 %> AS [PK] FROM (<%= _Params.SR0 %>) [p]<%= _Params.JOINS %> WHERE <%= _Params.D0 %> IS NOT NULL<%= _Params.AND_WHERE %>) [k]',

		Cube: 'SELECT <%= _Params.D1 %>'
			+ ' FROM (SELECT <%= _Params.D2 %>, count(*) AS [N], ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [RowNumber]'
			+ ' FROM (SELECT <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) [p]) [g]'
			+ ' GROUP BY <%= _Params.D3 %>) [c]'
			+ ' WHERE [c].[RowNumber] <= @fMaxGroups',

		RecordKeys: 'SELECT <%= _Params.D1 %> AS [Key] FROM (<%= _Params.SR0 %>) [p]'
			+ ' ORDER BY <%= _Params.D0 %> OFFSET @fBegin ROWS FETCH NEXT @fCap ROWS ONLY',

		Keys: 'SELECT TOP (@fCapPlusOne) <%= _Params.D1 %> AS [Key] FROM (<%= _Params.SR0 %>) [p]'
			+ ' ORDER BY <%= _Params.D1 %>',

		StagedKeys: 'SELECT DISTINCT TOP (@fCapPlusOne) <%= _Params.D0 %> FROM (<%= _Params.SR0 %>) [p]'
	});

/**
 * Format a datetime2 as 'YYYY-MM-DD HH:mm:ss'.
 *
 * @param {string} pDateSQL
 * @return {string}
 */
const formatDate = (pDateSQL) =>
{
	return `CONVERT(varchar(19), CAST(${pDateSQL} AS datetime2(0)), 120)`;
};

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
			return formatDate(`CAST(${pValueSQL} AS date)`);
		case 'week':
			// ISO Monday, independent of the session's DATEFIRST
			return formatDate(`DATEADD(day, -((DATEPART(weekday, ${pValueSQL}) + @@DATEFIRST - 2) % 7), CAST(${pValueSQL} AS date))`);
		case 'month':
			return formatDate(`DATEFROMPARTS(YEAR(${pValueSQL}), MONTH(${pValueSQL}), 1)`);
		case 'quarter':
			return formatDate(`DATEFROMPARTS(YEAR(${pValueSQL}), (DATEPART(quarter, ${pValueSQL}) - 1) * 3 + 1, 1)`);
		case 'year':
			return formatDate(`DATEFROMPARTS(YEAR(${pValueSQL}), 1, 1)`);
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
		 * Integer-unit bucket index with a CASE clamp (no LEAST before MSSQL 2022).
		 *
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		numericIndex: (pColumnSQL) =>
		{
			let tmpIndex = `FLOOR((ROUND(${pColumnSQL} * ${bind('fFactor')}, 0) - ${bind('fLoUnits')}) / ${bind('fWidthUnits')})`;
			let tmpCandidate = `(CASE WHEN ${tmpIndex} > ${bind('fLastIndex')} THEN ${bind('fLastIndex')} ELSE ${tmpIndex} END)`;
			// Corrected by one against the exact edges with the raw value (the Clause's comparison).
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
			return `CONVERT(varchar(19), ${pColumnSQL}, 120)`;
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
		 * @param {string} pColumnSQL
		 * @param {string} pDataType
		 * @return {string}
		 */
		valueKey: (pColumnSQL, pDataType) =>
		{
			if (STRING_TYPES.indexOf(pDataType) >= 0)
			{
				return `${pColumnSQL} COLLATE Latin1_General_BIN2`;
			}
			return pColumnSQL;
		},

		/**
		 * @param {string} pColumnSQL
		 * @return {string}
		 */
		sumUnits: (pColumnSQL, pFactorBind) =>
		{
			return `sum(CAST(ROUND(${pColumnSQL} * ${bind(pFactorBind || 'fFactor')}, 0) AS bigint))`;
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
			return `CONVERT(varchar(19), ${(pAggregate === 'max') ? 'max' : 'min'}(${pValueSQL}), 120)`;
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
		 * MSSQL 2016+ OPENJSON over one NVarChar(max) bind.
		 *
		 * @param {Array<string>} pOuterSQLs
		 * @param {Array<string>} pBindNames
		 * @param {boolean} pNegated
		 * @return {string}
		 */
		stagedMembership: (pOuterSQLs, pBindNames, pNegated) =>
		{
			let tmpSingle = (pOuterSQLs.length === 1);
			let tmpColumns = pOuterSQLs.map((pOuterSQL, pIndex) => { return `[a${pIndex}] bigint '${tmpSingle ? '$' : `$[${pIndex}]`}'`; }).join(', ');
			let tmpSource = `OPENJSON(${bind(pBindNames[0])}) WITH (${tmpColumns}) AS [v]`;
			if (tmpSingle && !pNegated)
			{
				return `${pOuterSQLs[0]} IN (SELECT [v].[a0] FROM ${tmpSource})`;
			}
			let tmpPairs = pOuterSQLs.map((pOuterSQL, pIndex) => { return `[v].[a${pIndex}] = ${pOuterSQL}`; });
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
