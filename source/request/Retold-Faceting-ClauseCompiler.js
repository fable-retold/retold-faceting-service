/**
 * Retold Faceting - Clause Compiler
 *
 * Maps pict-section-recordset clause arrays to FilterAST conjuncts, one conjunct per clause
 * (01 §8.2, D-04).  pict's Filter.js is the oracle, never the executor: values are data, never
 * template-evaluated (F9), coerced by column DataType (L3).
 *
 * Clause semantics (internal-contracts §4.4, pict Filter.js as the reference):
 *   DistinctSelectedValueList  → IN on each FilterByColumn (Or across columns); null values skipped
 *   *Range                     → GE|GT Start, LE|LT End per column (And of all); numeric 0 IS a bound;
 *                                a midnight DateTime bound of GE / LT binds as 'YYYY-MM-DD' (below)
 *   *Match                     → EQ (ExactMatch, or Numeric/DateMatch by default) else LK '%v%' (Or)
 *   RawFilter                  → the FilterString path, ONE NeverExclude conjunct
 *   Enabled === false          → skipped (pict skips disabled clauses)
 *   empty                      → no conjunct + FACET_CLAUSE_EMPTY warning
 *   GUIDGroup + Junction 'OR'  → the group's members combined with SQL precedence (pict wraps each
 *                                member in FOP / FOPOR); two or more OR-branches → ONE conjunct
 *   top-level sequence         → exactly pict's filter string: every RawFilter's stanzas FIRST
 *                                (pict prepends them, unwrapped, in clause order), then each
 *                                clause item as FOP / FOPOR by its Junction.  With no OR anywhere in
 *                                that sequence every clause and every RawFilter is its own conjunct;
 *                                with one, SQL precedence makes the whole sequence ONE conjunct
 *                                (never excluded when it holds a RawFilter)
 *
 * Day-aligned date bounds: stored DateTime text may be 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm', a 'T' form
 * or canonical 'YYYY-MM-DD HH:mm:ss', and SQLite compares TEXT lexicographically, so
 * '2023-04-01' < '2023-04-01 00:00:00'.  A date-only bound sorts before EVERY same-day form, so
 * '>= YYYY-MM-DD' and '< YYYY-MM-DD' select exactly the rows whose canonical value is on or after /
 * before that midnight: the same rows the canonical date bucketing puts in a bucket.  GT and LE
 * have no such single-string form and keep the canonical value.  On typed DATETIME columns
 * (PostgreSQL, MySQL, MSSQL) the date-only literal is the same instant.
 *
 * Synchronous; throws FacetErrors.  Contract: internal-contracts §4.4 (clause table).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingFilterAST = require('./Retold-Faceting-FilterAST.js');

const RANGE_TYPES = [ 'DateRange', 'NumericRange', 'StringRange', 'Range' ];
const MATCH_TYPES = [ 'Match', 'StringMatch', 'DateMatch', 'NumericMatch' ];

// The join clause families (internal-contracts §23.4): SelectedValue(List), the Match and the Range types.
const JOIN_SUFFIXES = [ 'SelectedValue', 'SelectedValueList' ].concat(MATCH_TYPES, RANGE_TYPES);
const INTERNAL_JOIN_TYPES = Object.freeze(JOIN_SUFFIXES.map((pSuffix) => { return `InternalJoin${pSuffix}`; }));
const EXTERNAL_JOIN_TYPES = Object.freeze(JOIN_SUFFIXES.map((pSuffix) => { return `ExternalJoin${pSuffix}`; }));

// Clause types the M2 compiler accepts: M1 + the twenty join types + NamedScope (internal-contracts
// §23.4).  The contract module may publish the same list as M2_CLAUSE_TYPES (wiring).
const M2_CLAUSE_TYPES = Object.freeze(libFacetRequest.M1_CLAUSE_TYPES.concat(INTERNAL_JOIN_TYPES, EXTERNAL_JOIN_TYPES, [ 'NamedScope' ]));

const TILDE_PATTERN = libFacetClauses.TILDE_PATTERN;

// The SQL-precedence algebra (01 §8.2) has ONE implementation: FilterAST's.
const combine = libRetoldFacetingFilterAST.combine;
const branches = libRetoldFacetingFilterAST.branches;
const branchesToPred = libRetoldFacetingFilterAST.branchesToPred;

// The midnight suffix of a canonical DateTime.
const MIDNIGHT_SUFFIX = ' 00:00:00';

/**
 * Stable sort by Ordinal (pict's sortSet; Array.prototype.sort is stable).
 *
 * @param {Array<{ Ordinal: number }>} pItems
 * @return {Array<any>}
 */
const sortByOrdinal = (pItems) =>
{
	return pItems.slice().sort((pA, pB) => { return pA.Ordinal - pB.Ordinal; });
};

// The integer column range rule is the contract's (one rule for clauses, filter strings and binds).
const integerRange = libFacetBuckets.integerRange;

/**
 * Coerce one client / definition value for a column (pure: the ClauseCompiler method, the
 * DefinitionRegistry and the Binder all use this one rule).  See RetoldFacetingClauseCompiler
 * .coerceValue for the table.
 *
 * @param {Record<string, any>} pColumnInfo - internal-contracts §11.1
 * @param {any} pValue
 * @return {any} coerced value (throws FACET_FILTER_INVALID when it cannot be coerced)
 */
const coerceValue = (pColumnInfo, pValue) =>
{
	let tmpColumnInfo = ((typeof(pColumnInfo) === 'object') && (pColumnInfo !== null)) ? pColumnInfo : {};
	let tmpField = (typeof(tmpColumnInfo.Column) === 'string') ? tmpColumnInfo.Column : null;
	let fInvalid = (pReason) =>
	{
		throw libFacetErrors.create('FACET_FILTER_INVALID', 'A filter value cannot be used for this field.', { Field: tmpField, Reason: pReason });
	};

	if ((typeof(pValue) !== 'string') && (typeof(pValue) !== 'number') && (typeof(pValue) !== 'boolean'))
	{
		fInvalid('NonScalarValue');
	}
	if ((typeof(pValue) === 'string') && TILDE_PATTERN.test(pValue))
	{
		fInvalid('TildeInValue');
	}

	let tmpDataType = tmpColumnInfo.DataType;
	if (tmpDataType === 'Boolean')
	{
		if ((pValue === true) || (pValue === 1) || (pValue === '1') || (pValue === 'true'))
		{
			return 1;
		}
		if ((pValue === false) || (pValue === 0) || (pValue === '0') || (pValue === 'false'))
		{
			return 0;
		}
		fInvalid('InvalidBoolean');
	}
	if (libFacetBuckets.isNumericType(tmpDataType))
	{
		let tmpNumber = (typeof(pValue) === 'number') ? (isFinite(pValue) ? pValue : null)
			: ((typeof(pValue) === 'string') ? libFacetUtil.toFiniteNumber(pValue.trim()) : null);
		if (tmpNumber === null)
		{
			fInvalid('InvalidNumber');
		}
		if (tmpColumnInfo.IsInteger === true)
		{
			// An integer column compares only within its type's range: a value outside it is a
			// client error on every dialect (PostgreSQL would fail the statement: never a 500).
			let tmpRange = integerRange(tmpColumnInfo);
			if ((tmpNumber < tmpRange.Min) || (tmpNumber > tmpRange.Max))
			{
				fInvalid('InvalidNumber');
			}
		}
		return tmpNumber;
	}
	if (tmpDataType === 'DateTime')
	{
		let tmpCanonical = (typeof(pValue) === 'string') ? libFacetBuckets.canonicalDateTime(pValue) : null;
		if (tmpCanonical === null)
		{
			fInvalid('InvalidDateTime');
		}
		return tmpCanonical;
	}
	return String(pValue);
};

class RetoldFacetingClauseCompiler extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingClauseCompiler';
	}

	/**
	 * A sibling service (found through fable only).
	 *
	 * @param {string} pServiceType
	 * @return {any}
	 */
	_service(pServiceType)
	{
		let tmpService = this.fable[pServiceType];
		if (!tmpService)
		{
			throw libFacetErrors.create('FACET_INTERNAL', `RetoldFacetingClauseCompiler needs the ${pServiceType} service.`);
		}
		return tmpService;
	}

	/**
	 * Throw FACET_FILTER_INVALID for a clause.
	 *
	 * @param {string|null} pClauseType
	 * @param {number} pIndex
	 * @param {string} pReason
	 * @param {Record<string, any>} [pExtra]
	 */
	_invalid(pClauseType, pIndex, pReason, pExtra)
	{
		throw libFacetErrors.create('FACET_FILTER_INVALID', 'A filter clause is invalid.', Object.assign({ ClauseType: pClauseType, Index: pIndex, Reason: pReason }, pExtra || {}));
	}

	/**
	 * The whitelisted columns a clause filters on (pict default: [ 'Name' ]).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @return {Array<Record<string, any>>} ColumnInfo per column (deduplicated, in order)
	 */
	_columns(pEntity, pClause, pIndex)
	{
		let tmpNames;
		if (pClause.FilterByColumns)
		{
			if (!Array.isArray(pClause.FilterByColumns))
			{
				this._invalid(pClause.Type, pIndex, 'FilterByColumnsNotArray');
			}
			tmpNames = pClause.FilterByColumns;
		}
		else if (pClause.FilterByColumn)
		{
			tmpNames = [ pClause.FilterByColumn ];
		}
		else
		{
			// pict Filter.js falls back to 'Name' (list parity); the whitelist still applies.
			tmpNames = [ 'Name' ];
		}

		let tmpCatalog = this._service('RetoldFacetingCatalog');
		let tmpSeen = new Set();
		let tmpColumns = [];
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpName = tmpNames[i];
			if ((typeof(tmpName) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(tmpName))
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FIELD', 'A filter clause names an unknown field.', { Field: (typeof(tmpName) === 'string') ? tmpName.substring(0, 64) : null, ClauseType: pClause.Type, Index: pIndex });
			}
			let tmpColumn = tmpCatalog.column(pEntity, tmpName);
			if (!tmpColumn || (tmpColumn.Filterable === false) || (tmpColumn.Sensitive === true))
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FIELD', 'A filter clause names an unknown field.', { Field: tmpName, ClauseType: pClause.Type, Index: pIndex });
			}
			if (tmpColumn.IsDeleteColumn === true)
			{
				// Only RawFilter / FilterString may name the delete column (Show-deleted).
				this._invalid(pClause.Type, pIndex, 'DeleteColumnNotAllowed', { Field: tmpName });
			}
			if (!tmpSeen.has(tmpName))
			{
				tmpSeen.add(tmpName);
				tmpColumns.push(Object.assign({ Column: tmpName }, tmpColumn));
			}
		}
		return tmpColumns;
	}

	/**
	 * The clause's value list (pict: Values array, else [ Value ] when Value is present).
	 * Deviation from pict: a scalar Value of 0 is a value (pict's loose `!= ''` drops it).
	 *
	 * @param {Record<string, any>} pClause
	 * @return {Array<any>}
	 */
	_values(pClause)
	{
		if (Array.isArray(pClause.Values))
		{
			return pClause.Values;
		}
		if ((pClause.Value === null) || (typeof(pClause.Value) === 'undefined') || (pClause.Value === ''))
		{
			return [];
		}
		return [ pClause.Value ];
	}

	/**
	 * Coerce with clause context added to any error.
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {any} pValue
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @return {any}
	 */
	_coerce(pColumn, pValue, pClause, pIndex)
	{
		try
		{
			return this.coerceValue(pColumn, pValue);
		}
		catch (pError)
		{
			if (libFacetErrors.isFacetError(pError) && pError.Detail)
			{
				pError.Detail.ClauseType = pClause.Type;
				pError.Detail.Index = pIndex;
			}
			throw pError;
		}
	}

	/**
	 * A scalar data value usable in a LIKE pattern (never coerced, never decoded).
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {any} pValue
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @return {string}
	 */
	_likeValue(pColumn, pValue, pClause, pIndex)
	{
		if ((typeof(pValue) !== 'string') && (typeof(pValue) !== 'number') && (typeof(pValue) !== 'boolean'))
		{
			this._invalid(pClause.Type, pIndex, 'NonScalarValue', { Field: pColumn.Column });
		}
		let tmpValue = String(pValue);
		if (TILDE_PATTERN.test(tmpValue))
		{
			this._invalid(pClause.Type, pIndex, 'TildeInValue', { Field: pColumn.Column });
		}
		return `%${tmpValue}%`;
	}

	/**
	 * DistinctSelectedValueList → IN per column (Or across columns).
	 *
	 * @return {Record<string, any>|null}
	 */
	_compileValueList(pEntity, pClause, pIndex)
	{
		let tmpColumns = this._columns(pEntity, pClause, pIndex);
		let tmpRawValues = this._values(pClause).filter((pValue) => { return (pValue !== null) && (typeof(pValue) !== 'undefined'); });
		if ((tmpRawValues.length < 1) || (tmpColumns.length < 1))
		{
			return null;
		}
		let tmpPreds = [];
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpSeen = new Set();
			let tmpValues = [];
			for (let j = 0; j < tmpRawValues.length; j++)
			{
				let tmpValue = this._coerce(tmpColumns[i], tmpRawValues[j], pClause, pIndex);
				let tmpSignature = typeof(tmpValue) + ':' + String(tmpValue);
				if (!tmpSeen.has(tmpSignature))
				{
					tmpSeen.add(tmpSignature);
					tmpValues.push(tmpValue);
				}
			}
			tmpPreds.push({ Field: tmpColumns[i].Column, Op: 'IN', Value: tmpValues });
		}
		return combine('Or', tmpPreds);
	}

	/**
	 * DateRange / NumericRange / StringRange / Range → And of bound comparisons.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @param {() => Array<Record<string, any>>} [fColumns] - resolves the columns (default: FilterByColumn(s) of pEntity); called only when a bound is present
	 * @return {Record<string, any>|null}
	 */
	_compileRange(pEntity, pClause, pIndex, fColumns)
	{
		let tmpRange = pClause.Values;
		if ((tmpRange === null) || (typeof(tmpRange) === 'undefined'))
		{
			return null;
		}
		if ((typeof(tmpRange) !== 'object') || Array.isArray(tmpRange))
		{
			this._invalid(pClause.Type, pIndex, 'RangeValuesNotObject');
		}
		let tmpIsDate = (pClause.Type === 'DateRange') || (pClause.Type === 'InternalJoinDateRange') || (pClause.Type === 'ExternalJoinDateRange');
		let fAbsent = (pValue) =>
		{
			if ((pValue === null) || (typeof(pValue) === 'undefined') || (pValue === ''))
			{
				return true;
			}
			// pict: "do not honor '0' for dates"
			return tmpIsDate && (String(pValue) === '0');
		};
		let tmpHasStart = !fAbsent(tmpRange.Start);
		let tmpHasEnd = !fAbsent(tmpRange.End);
		if (!tmpHasStart && !tmpHasEnd)
		{
			return null;
		}
		let tmpColumns = (typeof(fColumns) === 'function') ? fColumns() : this._columns(pEntity, pClause, pIndex);
		if (tmpColumns.length < 1)
		{
			return null;
		}
		let tmpPreds = [];
		for (let i = 0; i < tmpColumns.length; i++)
		{
			if (tmpHasStart)
			{
				let tmpOp = pClause.StartExclusive ? 'GT' : 'GE';
				tmpPreds.push({ Field: tmpColumns[i].Column, Op: tmpOp, Value: this._rangeBound(tmpColumns[i], tmpOp, this._coerce(tmpColumns[i], tmpRange.Start, pClause, pIndex)) });
			}
			if (tmpHasEnd)
			{
				let tmpOp = pClause.EndExclusive ? 'LT' : 'LE';
				tmpPreds.push({ Field: tmpColumns[i].Column, Op: tmpOp, Value: this._rangeBound(tmpColumns[i], tmpOp, this._coerce(tmpColumns[i], tmpRange.End, pClause, pIndex)) });
			}
		}
		return combine('And', tmpPreds);
	}

	/**
	 * The bound a range comparison binds: a midnight DateTime under GE / LT binds date-only
	 * ('YYYY-MM-DD'), so the comparison agrees with canonical date bucketing for every stored
	 * DateTime text shape (see the header).  A fractional bound on an INTEGER column binds its
	 * integer equivalent (GE / LT → ceil, GT / LE → floor): exactly the same integer rows, and a
	 * typed database never sees '0.5' bound to an integer parameter (PostgreSQL refuses it, 22P02).
	 * Everything else binds the coerced value.
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {string} pOp - GE | GT | LE | LT
	 * @param {any} pValue - the coerced value
	 * @return {any}
	 */
	_rangeBound(pColumn, pOp, pValue)
	{
		if ((pColumn.DataType === 'DateTime') && ((pOp === 'GE') || (pOp === 'LT'))
			&& (typeof(pValue) === 'string') && (pValue.length === 19) && (pValue.slice(10) === MIDNIGHT_SUFFIX))
		{
			return pValue.slice(0, 10);
		}
		if (libFacetBuckets.isIntegerType(pColumn.DataType) && (pColumn.DataType !== 'Boolean')
			&& (typeof(pValue) === 'number') && Number.isFinite(pValue) && !Number.isInteger(pValue))
		{
			// (|| 0 turns a -0 into 0)
			return (((pOp === 'GE') || (pOp === 'LT')) ? Math.ceil(pValue) : Math.floor(pValue)) || 0;
		}
		return pValue;
	}

	/**
	 * Match / StringMatch / DateMatch / NumericMatch → Or of EQ or LK '%v%'.
	 *
	 * @return {Record<string, any>|null}
	 */
	_compileMatch(pEntity, pClause, pIndex, fColumns)
	{
		let tmpRawValues = this._values(pClause).filter((pValue) => { return (pValue !== null) && (typeof(pValue) !== 'undefined'); });
		if (tmpRawValues.length < 1)
		{
			return null;
		}
		let tmpColumns = (typeof(fColumns) === 'function') ? fColumns() : this._columns(pEntity, pClause, pIndex);
		let tmpExactByType = (pClause.Type === 'NumericMatch') || (pClause.Type === 'DateMatch')
			|| (pClause.Type === 'InternalJoinNumericMatch') || (pClause.Type === 'InternalJoinDateMatch')
			|| (pClause.Type === 'ExternalJoinNumericMatch') || (pClause.Type === 'ExternalJoinDateMatch');
		let tmpExact = (pClause.ExactMatch) ? true
			: ((typeof(pClause.ExactMatch) === 'undefined') && tmpExactByType);
		let tmpPreds = [];
		for (let i = 0; i < tmpColumns.length; i++)
		{
			for (let j = 0; j < tmpRawValues.length; j++)
			{
				if (tmpExact)
				{
					tmpPreds.push({ Field: tmpColumns[i].Column, Op: 'EQ', Value: this._coerce(tmpColumns[i], tmpRawValues[j], pClause, pIndex) });
				}
				else
				{
					tmpPreds.push({ Field: tmpColumns[i].Column, Op: 'LK', Value: this._likeValue(tmpColumns[i], tmpRawValues[j], pClause, pIndex) });
				}
			}
		}
		if (tmpPreds.length < 1)
		{
			return null;
		}
		return combine('Or', tmpPreds);
	}

	/**
	 * RawFilter → the FilterString path, one conjunct (its conjuncts ANDed).
	 *
	 * @return {{ Pred: Record<string, any>, Warnings: Array<any> }|null}
	 */
	_compileRawFilter(pEntity, pClause, pIndex)
	{
		let tmpText = ((typeof(pClause.Filter) === 'string') && (pClause.Filter.length > 0)) ? pClause.Filter
			: ((typeof(pClause.Value) === 'string') && (pClause.Value.length > 0)) ? pClause.Value
			: null;
		if (tmpText === null)
		{
			if (((pClause.Filter !== null) && (typeof(pClause.Filter) !== 'undefined') && (typeof(pClause.Filter) !== 'string'))
				|| ((pClause.Value !== null) && (typeof(pClause.Value) !== 'undefined') && (typeof(pClause.Value) !== 'string')))
			{
				this._invalid(pClause.Type, pIndex, 'RawFilterNotAString');
			}
			return null;
		}
		let tmpValidated;
		let tmpConjuncts;
		try
		{
			tmpValidated = this._service('RetoldFacetingFilterValidator').validate(pEntity, tmpText, { AllowDeleteColumn: true });
			tmpConjuncts = this._service('RetoldFacetingFilterAST').fromStanzas(pEntity, tmpValidated.Stanzas,
				{ Kind: 'RawFilter', Hash: pClause.Hash, FilterKey: pClause.FilterKey, ClauseType: 'RawFilter', Index: pIndex });
		}
		catch (pError)
		{
			if (libFacetErrors.isFacetError(pError) && pError.Detail)
			{
				pError.Detail.ClauseType = 'RawFilter';
				pError.Detail.ClauseIndex = pIndex;
			}
			throw pError;
		}
		if (tmpConjuncts.length < 1)
		{
			return { Pred: null, Terms: [], Warnings: tmpValidated.Warnings };
		}
		return (
			{
				Pred: combine('And', tmpConjuncts.map((pConjunct) => { return pConjunct.Pred; })),
				// Its depth-0 terms with their own connectors, for pict's top-level sequence.
				Terms: this._service('RetoldFacetingFilterAST').terms(tmpValidated.Stanzas),
				Warnings: tmpValidated.Warnings
			});
	}

	// ------------------------------------------------------------ Join clauses (internal-contracts §23.4)

	/**
	 * Refuse a join clause that does not walk a declared graph edge (clients cannot invent joins).
	 *
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 */
	_undeclaredJoin(pClause, pIndex)
	{
		this._invalid(pClause.Type, pIndex, 'UndeclaredJoin');
	}

	/**
	 * A graph edge by name, or null (no graph service, a non-identifier, an unknown edge).
	 *
	 * @param {any} pEntity
	 * @param {any} pColumn
	 * @return {Record<string, any>|null}
	 */
	_edge(pEntity, pColumn)
	{
		let tmpGraph = this.fable.RetoldFacetingGraph;
		if (!tmpGraph || (typeof(tmpGraph.edge) !== 'function'))
		{
			return null;
		}
		if ((typeof(pEntity) !== 'string') || (typeof(pColumn) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pEntity) || !libFacetRequest.IDENTIFIER_PATTERN.test(pColumn))
		{
			return null;
		}
		return tmpGraph.edge(`${pEntity}.${pColumn}`);
	}

	/**
	 * The primary key of an entity (catalog, else graph).
	 *
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	_primaryKey(pEntity)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpDescriptor = (tmpCatalog && (typeof(tmpCatalog.getFacetable) === 'function')) ? tmpCatalog.getFacetable(pEntity) : null;
		if (tmpDescriptor && (typeof(tmpDescriptor.PK) === 'string'))
		{
			return tmpDescriptor.PK;
		}
		let tmpGraph = this.fable.RetoldFacetingGraph;
		return (tmpGraph && (typeof(tmpGraph.primaryKey) === 'function')) ? tmpGraph.primaryKey(pEntity) : null;
	}

	/**
	 * The per-entity gate for an entity a join clause reads (internal-contracts §19.6): a refusal
	 * fails the whole request with 403 and no Detail, BEFORE that entity's fields are validated.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pOptions - { CanFacet }
	 */
	_gate(pEntity, pOptions)
	{
		if ((typeof(pEntity) !== 'string') || !pOptions || (typeof(pOptions.CanFacet) !== 'function'))
		{
			// No name at all is a malformed clause (UndeclaredJoin follows): nothing to probe.
			return;
		}
		if (!libFacetRequest.IDENTIFIER_PATTERN.test(pEntity) || (pOptions.CanFacet(pEntity) !== true))
		{
			// An unknown, hidden, unreadable or malformed entity name all get this same answer.
			throw libFacetErrors.create('FACET_FORBIDDEN');
		}
	}

	/**
	 * A resolved PathPlan for a join clause path (internal-contracts §21.2), built from graph edges:
	 * each entry { Direction: 'Forward' | 'Reverse', Edge: <graph edge> }.
	 *
	 * @param {string} pFrom
	 * @param {Array<{ Direction: string, Edge: Record<string, any> }>} pSteps
	 * @return {Record<string, any>} PathPlan
	 */
	pathPlan(pFrom, pSteps)
	{
		let tmpCurrent = pFrom;
		let tmpSteps = [];
		for (let i = 0; i < pSteps.length; i++)
		{
			let tmpEdge = pSteps[i].Edge;
			let tmpForward = (pSteps[i].Direction === 'Forward');
			if ((tmpForward && (tmpEdge.From !== tmpCurrent)) || (!tmpForward && (tmpEdge.To !== tmpCurrent)))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A join path step does not start where the previous one ended.');
			}
			let tmpTo = tmpForward ? tmpEdge.To : tmpEdge.From;
			tmpSteps.push(
				{
					Index: i,
					Raw: (tmpForward ? '>' : '<') + tmpEdge.Name,
					Direction: tmpForward ? 'Forward' : 'Reverse',
					Edge: tmpEdge.Name,
					From: tmpCurrent,
					To: tmpTo,
					On: tmpForward ? [ [ tmpEdge.FromColumn, tmpEdge.ToColumn ] ] : [ [ tmpEdge.ToColumn, tmpEdge.FromColumn ] ],
					Via: null,
					Parent: null,
					CheckParent: false,
					Cardinality: tmpForward ? 'ToOne' : 'ToMany',
					Where: null,
					Scope: 'Inherit',
					ScopeReason: null,
					Elide: false,
					As: null
				});
			tmpCurrent = tmpTo;
		}
		return (
			{
				From: pFrom,
				To: tmpCurrent,
				Steps: tmpSteps,
				Hops: tmpSteps.length,
				ToOne: tmpSteps.every((pStep) => { return pStep.Direction === 'Forward'; }),
				Signature: tmpSteps.map((pStep) => { return pStep.Raw; }).join(' ')
			});
	}

	/**
	 * The remote columns a join clause filters on: every name must be a filterable, non-Sensitive
	 * column of the remote entity (FACET_UNKNOWN_FIELD { Field, Entity } — only after the gate); the
	 * delete column is refused (hop predicates never name it).
	 *
	 * @param {string} pRemote
	 * @param {Array<any>} pNames
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @return {Array<Record<string, any>>}
	 */
	_remoteColumns(pRemote, pNames, pClause, pIndex)
	{
		let tmpCatalog = this._service('RetoldFacetingCatalog');
		let tmpSeen = new Set();
		let tmpColumns = [];
		for (let i = 0; i < pNames.length; i++)
		{
			let tmpName = pNames[i];
			let tmpColumn = ((typeof(tmpName) === 'string') && libFacetRequest.IDENTIFIER_PATTERN.test(tmpName)) ? tmpCatalog.column(pRemote, tmpName) : null;
			if (!tmpColumn || (tmpColumn.Filterable === false) || (tmpColumn.Sensitive === true))
			{
				throw libFacetErrors.create('FACET_UNKNOWN_FIELD', 'A filter clause names an unknown field.',
					{ Field: (typeof(tmpName) === 'string') ? tmpName.substring(0, 64) : null, Entity: pRemote, ClauseType: pClause.Type, Index: pIndex });
			}
			if (tmpColumn.IsDeleteColumn === true)
			{
				this._invalid(pClause.Type, pIndex, 'DeleteColumnNotAllowed', { Field: tmpName });
			}
			if (!tmpSeen.has(tmpName))
			{
				tmpSeen.add(tmpName);
				tmpColumns.push(Object.assign({ Column: tmpName }, tmpColumn));
			}
		}
		return tmpColumns;
	}

	/**
	 * The remote predicate of a join clause (on the remote entity), or null when the clause carries
	 * no value (ignored + FACET_CLAUSE_EMPTY, like an empty column clause).
	 *
	 * @param {string} pFamily - 'SelectedValue' | 'Match' | 'Range'
	 * @param {string} pRemote
	 * @param {string} pLookupField - the SelectedValue lookup column
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @return {{ Pred: Record<string, any>|null, Fields: Array<string> }}
	 */
	_remotePred(pFamily, pRemote, pLookupField, pClause, pIndex)
	{
		if (pFamily === 'SelectedValue')
		{
			let tmpRawValues = this._values(pClause).filter((pValue) => { return (pValue !== null) && (typeof(pValue) !== 'undefined'); });
			if (tmpRawValues.length < 1)
			{
				return { Pred: null, Fields: [ pLookupField ] };
			}
			let tmpColumn = this._remoteColumns(pRemote, [ pLookupField ], pClause, pIndex)[0];
			let tmpSeen = new Set();
			let tmpValues = [];
			for (let i = 0; i < tmpRawValues.length; i++)
			{
				let tmpValue = this._coerce(tmpColumn, tmpRawValues[i], pClause, pIndex);
				let tmpSignature = typeof(tmpValue) + ':' + String(tmpValue);
				if (!tmpSeen.has(tmpSignature))
				{
					tmpSeen.add(tmpSignature);
					tmpValues.push(tmpValue);
				}
			}
			return { Pred: { Field: tmpColumn.Column, Op: 'IN', Value: tmpValues }, Fields: [ tmpColumn.Column ] };
		}
		let tmpNames = Array.isArray(pClause.ExternalFilterByColumns) ? pClause.ExternalFilterByColumns
			: ((typeof(pClause.ExternalFilterByColumn) === 'string') && (pClause.ExternalFilterByColumn.length > 0)) ? [ pClause.ExternalFilterByColumn ]
			: [ 'Name' ];
		if (pClause.ExternalFilterByColumns && !Array.isArray(pClause.ExternalFilterByColumns))
		{
			this._invalid(pClause.Type, pIndex, 'FilterByColumnsNotArray');
		}
		let fColumns = () => { return this._remoteColumns(pRemote, tmpNames, pClause, pIndex); };
		let tmpPred = (pFamily === 'Match') ? this._compileMatch(pRemote, pClause, pIndex, fColumns) : this._compileRange(pRemote, pClause, pIndex, fColumns);
		return { Pred: tmpPred, Fields: tmpNames.filter((pName) => { return (typeof(pName) === 'string'); }) };
	}

	/**
	 * The clause family of a join clause type.
	 *
	 * @param {string} pType
	 * @return {string} 'SelectedValue' | 'Match' | 'Range'
	 */
	_joinFamily(pType)
	{
		let tmpSuffix = pType.replace(/^(InternalJoin|ExternalJoin)/, '');
		if ((tmpSuffix === 'SelectedValue') || (tmpSuffix === 'SelectedValueList'))
		{
			return 'SelectedValue';
		}
		return (MATCH_TYPES.indexOf(tmpSuffix) >= 0) ? 'Match' : 'Range';
	}

	/**
	 * InternalJoin* → Exists([ '>E.JoinInternalConnectionColumn' ], <RemoteTable predicate>).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @param {Record<string, any>} pOptions - { CanFacet }
	 * @return {{ Pred: Record<string, any>|null, Fields: Array<string>, Entities: Array<string>, FilterKey: string|null }}
	 */
	_compileInternalJoin(pEntity, pClause, pIndex, pOptions)
	{
		// Gate the client-named entity BEFORE any graph lookup (§19.6): a hidden entity and a
		// nonexistent one must be indistinguishable (403, no Detail); UndeclaredJoin only follows.
		this._gate(pClause.RemoteTable, pOptions);
		let tmpEdge = this._edge(pEntity, pClause.JoinInternalConnectionColumn);
		if (!tmpEdge || (typeof(pClause.RemoteTable) !== 'string') || (tmpEdge.To !== pClause.RemoteTable)
			|| (((typeof(pClause.JoinExternalConnectionColumn) === 'string') && (pClause.JoinExternalConnectionColumn.length > 0)) && (pClause.JoinExternalConnectionColumn !== tmpEdge.ToColumn))
			|| ((pClause.JoinExternalConnectionColumn !== null) && (typeof(pClause.JoinExternalConnectionColumn) !== 'undefined') && (typeof(pClause.JoinExternalConnectionColumn) !== 'string')))
		{
			this._undeclaredJoin(pClause, pIndex);
		}
		let tmpRemote = tmpEdge.To;
		this._gate(tmpRemote, pOptions);
		let tmpFamily = this._joinFamily(pClause.Type);
		let tmpLookup = ((typeof(pClause.ExternalFilterTableLookupColumn) === 'string') && (pClause.ExternalFilterTableLookupColumn.length > 0))
			? pClause.ExternalFilterTableLookupColumn : `ID${tmpRemote}`;
		let tmpRemotePred = this._remotePred(tmpFamily, tmpRemote, tmpLookup, pClause, pIndex);
		if (!tmpRemotePred.Pred)
		{
			return { Pred: null, Fields: [], Entities: [ tmpRemote ], FilterKey: null };
		}
		let tmpPath = this.pathPlan(pEntity, [ { Direction: 'Forward', Edge: tmpEdge } ]);
		let tmpRemoteFields = this._service('RetoldFacetingFilterAST').fieldsOf(tmpRemotePred.Pred);
		// L3: a lookup by the target key is owned like the FK column itself (internal-contracts §23.5).
		let tmpByKey = (tmpRemoteFields.length > 0) && tmpRemoteFields.every((pField) => { return pField === tmpEdge.ToColumn; });
		return (
			{
				Pred: { Exists: { From: null, Path: tmpPath, Where: tmpRemotePred.Pred, Correlate: [] } },
				Fields: tmpByKey ? [ tmpEdge.FromColumn ] : tmpRemoteFields.map((pField) => { return `@path:${tmpPath.Signature}#${pField}`; }),
				Entities: [ tmpRemote ],
				FilterKey: tmpByKey ? tmpEdge.FromColumn : null
			});
	}

	/**
	 * ExternalJoin* → Exists([ '<JoinTable.JoinTableCoreConnectionColumn', '>JoinTable.JoinTableExternalConnectionColumn' ],
	 * <ExternalFilterByTable predicate>).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pClause
	 * @param {number} pIndex
	 * @param {Record<string, any>} pOptions - { CanFacet }
	 * @return {{ Pred: Record<string, any>|null, Fields: Array<string>, Entities: Array<string>, FilterKey: string|null }}
	 */
	_compileExternalJoin(pEntity, pClause, pIndex, pOptions)
	{
		let tmpJoinTable = pClause.JoinTable;
		// Gate every client-named entity BEFORE any graph lookup (§19.6, see _compileInternalJoin).
		this._gate(tmpJoinTable, pOptions);
		this._gate(pClause.ExternalFilterByTable, pOptions);
		let tmpCoreEdge = this._edge(tmpJoinTable, pClause.JoinTableCoreConnectionColumn);
		let tmpExternalEdge = this._edge(tmpJoinTable, pClause.JoinTableExternalConnectionColumn);
		let tmpCoreColumn = ((typeof(pClause.CoreConnectionColumn) === 'string') && (pClause.CoreConnectionColumn.length > 0)) ? pClause.CoreConnectionColumn : this._primaryKey(pEntity);
		if (!tmpCoreEdge || !tmpExternalEdge || (tmpCoreEdge.To !== pEntity) || (tmpCoreEdge.ToColumn !== tmpCoreColumn)
			|| (typeof(pClause.ExternalFilterByTable) !== 'string') || (tmpExternalEdge.To !== pClause.ExternalFilterByTable)
			|| (((typeof(pClause.ExternalFilterByTableConnectionColumn) === 'string') && (pClause.ExternalFilterByTableConnectionColumn.length > 0)) && (pClause.ExternalFilterByTableConnectionColumn !== tmpExternalEdge.ToColumn)))
		{
			this._undeclaredJoin(pClause, pIndex);
		}
		let tmpRemote = tmpExternalEdge.To;
		this._gate(tmpJoinTable, pOptions);
		this._gate(tmpRemote, pOptions);
		let tmpFamily = this._joinFamily(pClause.Type);
		let tmpLookup = ((typeof(pClause.ExternalFilterTableLookupColumn) === 'string') && (pClause.ExternalFilterTableLookupColumn.length > 0))
			? pClause.ExternalFilterTableLookupColumn : `ID${tmpRemote}`;
		let tmpRemotePred = this._remotePred(tmpFamily, tmpRemote, tmpLookup, pClause, pIndex);
		if (!tmpRemotePred.Pred)
		{
			return { Pred: null, Fields: [], Entities: [ tmpJoinTable, tmpRemote ], FilterKey: null };
		}
		let tmpPath = this.pathPlan(pEntity, [ { Direction: 'Reverse', Edge: tmpCoreEdge }, { Direction: 'Forward', Edge: tmpExternalEdge } ]);
		// pict's polymorphic join tables: only the join rows of that remote type count (a step Where on
		// the join table).  Never ignored: dropping it would widen the client's filter.
		let tmpPolyType = pClause.PolyJoinRemoteType;
		if ((tmpPolyType !== null) && (typeof(tmpPolyType) !== 'undefined') && (tmpPolyType !== ''))
		{
			let tmpPolyName = ((typeof(pClause.PolyJoinRemoteColumn) === 'string') && (pClause.PolyJoinRemoteColumn.length > 0)) ? pClause.PolyJoinRemoteColumn : 'RemoteType';
			let tmpPolyColumn = this._remoteColumns(tmpJoinTable, [ tmpPolyName ], pClause, pIndex)[0];
			tmpPath.Steps[0].Where = { Field: tmpPolyColumn.Column, Op: 'EQ', Value: this._coerce(tmpPolyColumn, tmpPolyType, pClause, pIndex) };
		}
		let tmpRemoteFields = this._service('RetoldFacetingFilterAST').fieldsOf(tmpRemotePred.Pred);
		return (
			{
				Pred: { Exists: { From: null, Path: tmpPath, Where: tmpRemotePred.Pred, Correlate: [] } },
				Fields: tmpRemoteFields.map((pField) => { return `@path:${tmpPath.Signature}#${pField}`; }),
				Entities: [ tmpJoinTable, tmpRemote ],
				FilterKey: null
			});
	}

	/**
	 * A conjunct (no Id) for one or more clause units.
	 *
	 * Fields are the union of the units' ownership fields (a column unit's Pred fields; a join unit's
	 * §23.5 fields); Shape is 'Path' when any unit is a join; Entities the union of the entities the
	 * join units read.  A conjunct of column units only is exactly the M1 conjunct (plus Shape
	 * 'Column', Binds [], Entities []).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPred
	 * @param {Array<Record<string, any>>} pUnits - the contributing units (array order)
	 * @param {string} pKind - 'Clause' | 'RawFilter' | 'Join'
	 * @return {Record<string, any>}
	 */
	_conjunct(pEntity, pPred, pUnits, pKind)
	{
		let tmpUnits = pUnits.slice().sort((pA, pB) => { return pA.Index - pB.Index; });
		let fShared = (pProperty) =>
		{
			let tmpValue = tmpUnits[0][pProperty];
			for (let i = 1; i < tmpUnits.length; i++)
			{
				if (tmpUnits[i][pProperty] !== tmpValue)
				{
					return null;
				}
			}
			return tmpValue;
		};
		let tmpHasRawFilter = tmpUnits.some((pUnit) => { return pUnit.Kind === 'RawFilter'; });
		let tmpMerged = (tmpUnits.length > 1);
		let tmpAST = this._service('RetoldFacetingFilterAST');
		let tmpFields = new Set();
		let tmpEntities = [];
		let tmpHasJoin = false;
		for (let i = 0; i < tmpUnits.length; i++)
		{
			let tmpUnitFields = Array.isArray(tmpUnits[i].Fields) ? tmpUnits[i].Fields : tmpAST.fieldsOf(tmpUnits[i].Pred);
			tmpUnitFields.forEach((pField) => { tmpFields.add(pField); });
			(Array.isArray(tmpUnits[i].Entities) ? tmpUnits[i].Entities : []).forEach((pTarget) => { if ((pTarget !== pEntity) && (tmpEntities.indexOf(pTarget) < 0)) { tmpEntities.push(pTarget); } });
			if (tmpUnits[i].Kind === 'Join')
			{
				tmpHasJoin = true;
			}
		}
		let tmpConjunct = tmpAST.newConjunct(pEntity, pPred,
			{
				// A merged conjunct is reported per member (Origin.Kinds), so its own Kind is 'Clause'.
				Kind: tmpMerged ? 'Clause' : pKind,
				Hash: tmpUnits[0].Hash,
				FilterKey: fShared('FilterKey'),
				ClauseType: fShared('ClauseType'),
				Index: tmpUnits[0].Index
			}, tmpHasRawFilter,
			{
				Fields: Array.from(tmpFields).sort(),
				Entities: tmpEntities.sort(),
				Shape: tmpHasJoin ? 'Path' : undefined
			});
		if (tmpMerged)
		{
			// A merged (OR) conjunct: every contributing clause, for envelope Filter.Applied.
			tmpConjunct.Origin.Hashes = tmpUnits.map((pUnit) => { return pUnit.Hash; });
			tmpConjunct.Origin.Indexes = tmpUnits.map((pUnit) => { return pUnit.Index; });
			tmpConjunct.Origin.Kinds = tmpUnits.map((pUnit) => { return pUnit.Kind; });
		}
		return tmpConjunct;
	}

	/**
	 * Compile pict clauses into conjuncts (Ids are assigned later by FilterAST.build).
	 *
	 * M2 (internal-contracts §23.3, §23.4): the twenty InternalJoin* / ExternalJoin* types compile to
	 * one Exists conjunct each (Path shape) and take part in pict's top-level sequence exactly like
	 * column clauses; a NamedScope clause is taken OUT of that sequence (it is never OR-combined with
	 * client intent; Junction 'OR' or a GUIDGroup on it is refused) and compiled through
	 * FilterAST.scopeConjunct at its own index.  pOptions carries the BindContext (required once a
	 * scope or join clause is present) and the per-entity gate.
	 *
	 * @param {string} pEntity
	 * @param {Array<Record<string, any>>} pClauses
	 * @param {{ Bind?: Record<string, any>|null, CanFacet?: ((pEntity: string) => boolean)|null }} [pOptions]
	 * @return {{ Conjuncts: Array<Record<string, any>>, Warnings: Array<{ Code: string, Detail: any }> }}
	 */
	compile(pEntity, pClauses, pOptions)
	{
		if ((pClauses === null) || (typeof(pClauses) === 'undefined'))
		{
			return { Conjuncts: [], Warnings: [] };
		}
		if (!Array.isArray(pClauses))
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'Clauses must be an array.', { ClauseType: null, Reason: 'ClausesNotArray' });
		}
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let tmpBindRequired = false;

		let tmpWarnings = [];
		let tmpUnits = [];
		let tmpScopeConjuncts = [];
		for (let i = 0; i < pClauses.length; i++)
		{
			let tmpClause = pClauses[i];
			if ((typeof(tmpClause) !== 'object') || (tmpClause === null) || Array.isArray(tmpClause) || (typeof(tmpClause.Type) !== 'string'))
			{
				this._invalid(null, i, 'MalformedClause');
			}
			if (tmpClause.Enabled === false)
			{
				continue;
			}
			if (tmpClause.Type === 'NamedScope')
			{
				if ((tmpClause.Junction === 'OR') || ((typeof(tmpClause.GUIDGroup) === 'string') && (tmpClause.GUIDGroup.length > 0)))
				{
					this._invalid('NamedScope', i, 'NamedScopeJunction');
				}
				let tmpHash = ((typeof(tmpClause.Hash) === 'string') && (tmpClause.Hash.length > 0)) ? tmpClause.Hash : null;
				tmpScopeConjuncts.push(this._service('RetoldFacetingFilterAST').scopeConjunct(pEntity, { Scope: tmpClause.Scope, Params: tmpClause.Params },
					{ Hash: tmpHash, ClauseType: 'NamedScope', Index: i }, tmpOptions));
				continue;
			}
			if (M2_CLAUSE_TYPES.indexOf(tmpClause.Type) < 0)
			{
				this._invalid(tmpClause.Type.substring(0, 64), i, 'UnsupportedClauseType');
			}

			let tmpPred = null;
			let tmpKind = 'Clause';
			let tmpRawTerms = null;
			let tmpJoin = null;
			if (tmpClause.Type === 'DistinctSelectedValueList')
			{
				tmpPred = this._compileValueList(pEntity, tmpClause, i);
			}
			else if (RANGE_TYPES.indexOf(tmpClause.Type) >= 0)
			{
				tmpPred = this._compileRange(pEntity, tmpClause, i);
			}
			else if (MATCH_TYPES.indexOf(tmpClause.Type) >= 0)
			{
				tmpPred = this._compileMatch(pEntity, tmpClause, i);
			}
			else if (INTERNAL_JOIN_TYPES.indexOf(tmpClause.Type) >= 0)
			{
				tmpKind = 'Join';
				tmpJoin = this._compileInternalJoin(pEntity, tmpClause, i, tmpOptions);
				tmpPred = tmpJoin.Pred;
				tmpBindRequired = true;
			}
			else if (EXTERNAL_JOIN_TYPES.indexOf(tmpClause.Type) >= 0)
			{
				tmpKind = 'Join';
				tmpJoin = this._compileExternalJoin(pEntity, tmpClause, i, tmpOptions);
				tmpPred = tmpJoin.Pred;
				tmpBindRequired = true;
			}
			else
			{
				// RawFilter
				tmpKind = 'RawFilter';
				let tmpRaw = this._compileRawFilter(pEntity, tmpClause, i);
				if (tmpRaw)
				{
					tmpWarnings = tmpWarnings.concat(tmpRaw.Warnings || []);
					tmpPred = tmpRaw.Pred;
					tmpRawTerms = tmpRaw.Terms;
				}
			}

			let tmpHash = ((typeof(tmpClause.Hash) === 'string') && (tmpClause.Hash.length > 0)) ? tmpClause.Hash : null;
			if (!tmpPred)
			{
				tmpWarnings.push({ Code: 'FACET_CLAUSE_EMPTY', Detail: { Index: i, Hash: tmpHash, ClauseType: tmpClause.Type } });
				continue;
			}

			let tmpFilterKey = ((typeof(tmpClause.FilterKey) === 'string') && (tmpClause.FilterKey.length > 0)) ? tmpClause.FilterKey : null;
			if ((tmpFilterKey === null) && (tmpKind === 'Clause'))
			{
				// Default: the FilterByColumn when the clause filters exactly one column.
				let tmpFields = this._service('RetoldFacetingFilterAST').fieldsOf(tmpPred);
				if (tmpFields.length === 1)
				{
					tmpFilterKey = tmpFields[0];
				}
			}
			else if ((tmpFilterKey === null) && tmpJoin)
			{
				// Default: the FK column for a lookup by the target key (internal-contracts §23.5).
				tmpFilterKey = tmpJoin.FilterKey;
			}

			tmpUnits.push(
				{
					Index: i,
					Kind: tmpKind,
					Pred: tmpPred,
					Hash: tmpHash,
					FilterKey: tmpFilterKey,
					ClauseType: tmpClause.Type,
					Connector: (tmpClause.Junction === 'OR') ? 'OR' : 'AND',
					GUIDGroup: ((typeof(tmpClause.GUIDGroup) === 'string') && (tmpClause.GUIDGroup.length > 0)) ? tmpClause.GUIDGroup : null,
					Ordinal: ((typeof(tmpClause.Ordinal) === 'number') && isFinite(tmpClause.Ordinal)) ? tmpClause.Ordinal : 0,
					Terms: tmpRawTerms,
					Fields: tmpJoin ? tmpJoin.Fields : null,
					Entities: tmpJoin ? tmpJoin.Entities : []
				});
		}
		if (tmpBindRequired && !tmpOptions.Bind)
		{
			// A join clause or scope reached FilterAST without the Bind stage: a wiring bug.
			throw libFacetErrors.create('FACET_INTERNAL', 'A join clause needs the request BindContext (FilterAST.build pInput.Bind).');
		}

		let tmpConjuncts = [];

		// pict's string puts every RawFilter's stanzas first (unwrapped, clause order), then the
		// clause items; the RawFilter units here only contribute their terms to that sequence.
		let tmpRawUnits = [];
		let tmpClauseUnits = [];
		for (let i = 0; i < tmpUnits.length; i++)
		{
			if (tmpUnits[i].Kind === 'RawFilter')
			{
				tmpRawUnits.push(tmpUnits[i]);
			}
			else
			{
				tmpClauseUnits.push(tmpUnits[i]);
			}
		}

		// pict's top-level clause sequence: ungrouped clauses (array order), then each GUIDGroup
		// (first appearance), stable-sorted by Ordinal (an implicit group's Ordinal is 0).
		let tmpGroups = new Map();
		let tmpGroupOrder = [];
		let tmpTop = [];
		for (let i = 0; i < tmpClauseUnits.length; i++)
		{
			let tmpUnit = tmpClauseUnits[i];
			if (tmpUnit.GUIDGroup === null)
			{
				tmpTop.push({ Connector: tmpUnit.Connector, Ordinal: tmpUnit.Ordinal, Units: [ tmpUnit ], Group: false });
				continue;
			}
			if (!tmpGroups.has(tmpUnit.GUIDGroup))
			{
				tmpGroups.set(tmpUnit.GUIDGroup, []);
				tmpGroupOrder.push(tmpUnit.GUIDGroup);
			}
			tmpGroups.get(tmpUnit.GUIDGroup).push(tmpUnit);
		}
		for (let i = 0; i < tmpGroupOrder.length; i++)
		{
			tmpTop.push({ Connector: 'AND', Ordinal: 0, Units: sortByOrdinal(tmpGroups.get(tmpGroupOrder[i])), Group: true });
		}
		tmpTop = sortByOrdinal(tmpTop);

		// Each top-level item's Pred (a group's members combined with SQL precedence).  Units carry
		// { Connector, Pred }, the shape FilterAST.branches reads.
		let fItemPred = (pItem) =>
		{
			if (!pItem.Group)
			{
				return pItem.Units[0].Pred;
			}
			return branchesToPred(branches(pItem.Units));
		};

		// The whole top-level sequence, in pict's string order: RawFilter terms, then clause items.
		let tmpSequence = [];
		for (let i = 0; i < tmpRawUnits.length; i++)
		{
			let tmpTerms = Array.isArray(tmpRawUnits[i].Terms) ? tmpRawUnits[i].Terms : [ { Connector: 'AND', Pred: tmpRawUnits[i].Pred } ];
			tmpSequence = tmpSequence.concat(tmpTerms.map((pTerm) => { return { Connector: pTerm.Connector, Pred: pTerm.Pred }; }));
		}
		tmpSequence = tmpSequence.concat(tmpTop.map((pItem) => { return { Connector: pItem.Connector, Pred: fItemPred(pItem) }; }));

		let tmpSequenceBranches = branches(tmpSequence);
		if (tmpSequenceBranches.length > 1)
		{
			// (a AND b) OR c anywhere in the sequence: the whole client clause filter is ONE conjunct,
			// never excluded when a RawFilter is part of it.
			let tmpAllUnits = tmpRawUnits.concat(tmpClauseUnits);
			tmpConjuncts.push(this._conjunct(pEntity, branchesToPred(tmpSequenceBranches), tmpAllUnits, (tmpRawUnits.length > 0) ? 'RawFilter' : 'Clause'));
		}
		else
		{
			// No OR: every RawFilter (fenced alone, NeverExclude) and every clause is its own conjunct.
			for (let i = 0; i < tmpRawUnits.length; i++)
			{
				tmpConjuncts.push(this._conjunct(pEntity, tmpRawUnits[i].Pred, [ tmpRawUnits[i] ], 'RawFilter'));
			}
			for (let i = 0; i < tmpTop.length; i++)
			{
				let tmpItem = tmpTop[i];
				if (!tmpItem.Group)
				{
					tmpConjuncts.push(this._conjunct(pEntity, tmpItem.Units[0].Pred, tmpItem.Units, tmpItem.Units[0].Kind));
					continue;
				}
				if (branches(tmpItem.Units).length > 1)
				{
					tmpConjuncts.push(this._conjunct(pEntity, fItemPred(tmpItem), tmpItem.Units, 'Clause'));
				}
				else
				{
					for (let j = 0; j < tmpItem.Units.length; j++)
					{
						tmpConjuncts.push(this._conjunct(pEntity, tmpItem.Units[j].Pred, [ tmpItem.Units[j] ], tmpItem.Units[j].Kind));
					}
				}
			}
		}

		// NamedScope clauses (extracted from the sequence) sit at their own clause index.
		tmpConjuncts = tmpConjuncts.concat(tmpScopeConjuncts);

		// Conjunct order = clause array order (a merged conjunct sits at its first clause).
		tmpConjuncts.sort((pA, pB) => { return pA.Origin.Index - pB.Origin.Index; });

		return { Conjuncts: tmpConjuncts, Warnings: tmpWarnings };
	}

	/**
	 * Coerce one clause value by the column's DataType (L3).
	 *
	 *   Boolean  → 0 | 1 (true/false/'true'/'false'/0/1/'0'/'1')
	 *   any other numeric DataType (FacetBuckets.NUMERIC_KEY_TYPES) → Number (finite; numeric strings accepted)
	 *   DateTime → 'YYYY-MM-DD HH:mm:ss' via FacetBuckets.canonicalDateTime
	 *   String / Text / GUID / anything else → String(v)
	 * Strings containing '~' (or '%7E', which decodes to it) are refused everywhere.
	 *
	 * @param {Record<string, any>} pColumnInfo - internal-contracts §11.1
	 * @param {any} pValue
	 * @return {any} coerced value (throws FACET_FILTER_INVALID when it cannot be coerced)
	 */
	coerceValue(pColumnInfo, pValue)
	{
		return coerceValue(pColumnInfo, pValue);
	}
}

module.exports = RetoldFacetingClauseCompiler;
module.exports.serviceType = 'RetoldFacetingClauseCompiler';
module.exports.M2_CLAUSE_TYPES = M2_CLAUSE_TYPES;
module.exports.INTERNAL_JOIN_TYPES = INTERNAL_JOIN_TYPES;
module.exports.EXTERNAL_JOIN_TYPES = EXTERNAL_JOIN_TYPES;
module.exports.coerceValue = coerceValue;
module.exports.integerRange = integerRange;
