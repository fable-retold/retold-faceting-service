/**
 * ClickHouse-FoldCompiler — FoldIR + the captured scope of every relation → ClickHouse SQL
 * (design 04 §5.4; internal-contracts §63).
 *
 *   compileAgg(pAgg, pInput)               → { Statements: [ { Purpose, SQL, Params, Types, Settings, MaxRows } ], Fold } | { Refused }
 *   compileCube(pCubePlan, pMembers, pInput) → { Statement, Fold: 'CubeGrain' } | { Refused }
 *   compileRelation(pRel, pInput)          → { SQL: '(SELECT … FROM `db`.`E` FINAL WHERE `_IsDeleted` = 0 AND (…)) AS <As>', Params, Types } | { Refused }
 *   compileFilter(pSpec, pEntries, pInput) → { SQL, Params, Types } | { Refused }     (FoxHound filter entries → WHERE)
 *   compileFoldPred(pPred, pInput)         → { SQL, Params, Types } | { Refused }     (Exists / NotExists / CountCmp / Cmp / And / Or)
 *   dimensionExpression(pDimension, pColumnSQL, pInput) → { SQL, Params, Types } | { Refused }
 *   collectRelations(pAgg, pVariant)       → { Relations: [ { Alias, Entity, Rel, Columns } ], Leaves: { Alias: [ leaf ] } }
 *   paramName(pPrefix, pIndex)             → '<prefix>_<index>'
 *
 * Every relation is one FINAL scan with `_IsDeleted` = 0 and its FINAL post-behavior filter (client
 * fence, Where fence, explicit soft delete, behavior entries, operator transforms, TenantOnly
 * relaxation, guard repair); semi / anti joins are IN / tuple IN subqueries (NULL-safe:
 * [NOT] ifNull(… IN …, 0): an anti-join keeps a NULL outer row, as NOT EXISTS does), while a column
 * NOT IN drops a NULL row exactly as SQL does ('(isNotNull(c) AND NOT (c IN …))'); to-one dimensions
 * are ANY LEFT JOIN derived tables (join_use_nulls);
 * K9 counts distinct pivot rows with uniqExact; date buckets are toStartOf* in Date32
 * (enable_extended_results_for_datetime_functions) formatted to the M1 wire format; numeric buckets
 * follow the M1 integer-unit edge rule.  Every value is a {name:Type} parameter; identifiers come only
 * from the MirrorSpec whitelist (validated, backtick-quoted).  Statements return the row shapes of the
 * Live shells, so EngineLive.foldRows folds both.
 *
 * Composition mirrors the Live StatementComposer (internal-contracts §26.4) so the two engines answer
 * the same FoldIR the same way:
 *
 *   R  relation   SELECT <PK>, <cols> FROM `db`.`E` FINAL WHERE `_IsDeleted` = 0 AND (<captured filter>)
 *   W  where      SELECT p.<cols>, <computed> FROM (R) AS p WHERE <PathPred AND Agg.Where>
 *                 computed: ExistsFlag `FacetX<i>`, cube flags `b<n>` / `w<n>` (if(<cond>, 1, 0))
 *   J  joins      SELECT p.<cols>, l<k>.<Field> AS FacetV<i>, ifNull(ca<i>.N, 0) AS FacetC<i>
 *                 FROM (W) AS p ANY LEFT JOIN (<R l1>) AS l1 ON … LEFT JOIN (<child counts>) AS ca<i> ON …
 *   shell         SELECT … FROM (<base>) AS p …   (one per kind; same row shapes as Live)
 *
 * A TuplePivot composes SELECT DISTINCT <Key> AS TK<i>, <dims> AS FacetT<i> FROM (<R p>) AS p INNER
 * JOIN (<R u1>) AS u1 ON … WHERE <preds> (one row per distinct Key tuple), K9 joins its chain to the
 * base inside the MultiTerms / MultiCovered statements.  Column predicates are qualified
 * (alias.`column`), so a fragment renders inline wherever its alias is in scope (no Live-style flag
 * wrappers); an existence node whose On pair names an alias out of its scope (a multi-level
 * correlation ClickHouse 24.8 cannot express without a correlated subquery) is refused
 * (ShapeUnsupported:Correlation).
 *
 * Refusal is never a wrong number: a value the mirror cannot compare exactly, an operator it cannot
 * reproduce, a column it does not hold, an unscoped tenant relation — every such case returns
 * { Refused: '<reason>' } (internal-contracts §65) and the Agg runs Live.
 *
 * A pure module: requires only source/contract/* and its store/clickhouse/ siblings.
 *
 * Contract: internal-contracts §63, §65.  Owner: builder C (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetBuckets = require('../../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../../contract/Facet-Contract-Clauses.js');
const libFacetRequest = require('../../contract/Facet-Contract-Request.js');
const libTypeMap = require('./ClickHouse-TypeMap.js');
const libDDL = require('./ClickHouse-DDL.js');
const libClickHouseClient = require('./ClickHouse-Client.js');

// Bumped whenever the generated SQL changes shape (goldens: test/goldens/Facet-ClickHouse-Goldens.json).
const COMPILER_VERSION = 1;

// FoxHound operator → ClickHouse (§63.3).  LIKE / NOT LIKE depend on the source dialect.
const OPERATOR_MAP = Object.freeze(
	{
		'=': '=',
		'!=': '!=',
		'<>': '!=',
		'<': '<',
		'<=': '<=',
		'>': '>',
		'>=': '>=',
		'IN': 'IN',
		'NOT IN': 'NOT IN',
		'IS': 'isNull',
		'IS NULL': 'isNull',
		'IS NOT NULL': 'isNotNull',
		'LIKE': { SQLite: 'ilike', PostgreSQL: 'like' },
		'NOT LIKE': { SQLite: 'NOT ilike', PostgreSQL: 'notLike' },
		'ILIKE': 'ilike',
		'NOT ILIKE': 'NOT ilike'
	});

// The settings every store read carries (§57.3); the engine adds max_execution_time / max_result_rows.
const READ_SETTINGS = Object.freeze(
	{
		enable_extended_results_for_datetime_functions: 1,
		join_use_nulls: 1,
		transform_null_in: 0,
		cancel_http_readonly_queries_on_client_close: 1,
		output_format_json_quote_64bit_integers: 1,
		// toFloat64(<String>) of a bound Float64 value is exact only with this (§68 #22; see bind).
		precise_float_parsing: 1,
		// Request-path reads never write or run DDL, whatever the credential could do (code 164
		// READONLY); 2 still lets every setting above (and the engine's limits) be set per query.
		readonly: 2
	});

// The longest formatted parameter a statement binds (ClickHouse-Client.MAX_PARAM_TEXT is the hard
// limit; a bigger IN list or behavior-appended key set is refused here and answered Live).
const MAX_PARAM_TEXT = Math.floor(libClickHouseClient.MAX_PARAM_TEXT * 0.9);

// Every refusal reason class (§65); Reason.split(':')[0] is always one of them.  'ShapeUnsupported'
// (M5 build, §68): a FoldIR shape this compiler does not express (a multi-level correlation, a
// DateTime Terms key, a malformed tree) — the Agg runs Live.
const REASON_CLASSES = Object.freeze(
	[
		'Requested', 'StoreUnavailable', 'Mode', 'KindUnsupported', 'DeletedRowsNotMirrored', 'NotMirrored', 'LossyColumn',
		'Breaker', 'State', 'Unverified', 'NotExact', 'Lagging', 'NoChangeSource', 'OpaqueScope', 'ScopeMissing',
		'OperatorUnsupported', 'OperatorType', 'ValueType', 'DateLiteral', 'LikeCase', 'StringOrder', 'Transformed', 'StoreError',
		'ShapeUnsupported', 'ParameterSize', 'StoreBusy', 'Freshness'
	]);

const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// FoldIR aliases (ScopedRelationBuilder.ALIAS_PATTERN): never 'f…' (statement parameters are f*).
const ALIAS_PATTERN = /^[a-eg-z][a-z0-9]{0,7}$/;

// Mirror base types.
const TYPE_INT64 = 'Int64';
const TYPE_UINT8 = 'UInt8';
const TYPE_UINT64 = 'UInt64';
const TYPE_FLOAT64 = 'Float64';
const TYPE_STRING = 'String';
const TYPE_DATETIME = "DateTime64(3, 'UTC')";
const NUMERIC_BASE_TYPES = Object.freeze([ TYPE_INT64, TYPE_UINT8, TYPE_UINT64, TYPE_FLOAT64 ]);

// FilterAST Op → FoxHound operator (FilterAST.FOXHOUND_OPERATORS; fragments are rendered the way the
// Live PredicateFragment renders them, so the probed operator transforms match by signature).
const FOXHOUND_OPERATORS = Object.freeze(
	{
		EQ: '=', NE: '!=', GT: '>', GE: '>=', LT: '<', LE: '<=',
		LK: 'LIKE', NLK: 'NOT LIKE',
		IN: 'IN', NIN: 'NOT IN',
		NOTNULL: 'IS NOT NULL'
	});

// CountCmp operators (K19).
const COUNT_OPERATORS = Object.freeze({ EQ: '=', NE: '!=', GT: '>', GE: '>=', LT: '<', LE: '<=' });

const EXISTENCE_NODES = Object.freeze([ 'Exists', 'NotExists', 'CountCmp' ]);

// The date bucket of a DateTime64 value (Date32 under extended results).
const DATE_BUCKETS = Object.freeze(
	{
		day: 'toDate32',
		week: 'toMonday',
		month: 'toStartOfMonth',
		quarter: 'toStartOfQuarter',
		year: 'toStartOfYear'
	});

const KEY_FORMAT = "'%Y-%m-%d 00:00:00'";
const VALUE_FORMAT = "'%Y-%m-%d %H:%i:%S'";

// Integer / decimal literals a value may be written as (SQLite affinity converts them).
const INTEGER_LITERAL_PATTERN = /^-?\d+$/;
const NUMERIC_LITERAL_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------------- refusal

/**
 * A refusal travelling up the recursion (caught at every public entry point).
 */
class CompilerRefusal
{
	/**
	 * @param {string} pReason - internal-contracts §65
	 */
	constructor(pReason)
	{
		this.Reason = pReason;
	}
}

/**
 * @param {string} pReason
 */
const refuse = (pReason) =>
{
	throw new CompilerRefusal(pReason);
};

/**
 * Run a compilation; a refusal becomes { Refused }.
 *
 * @param {() => Record<string, any>} fWork
 * @return {Record<string, any>}
 */
const guarded = (fWork) =>
{
	try
	{
		return fWork();
	}
	catch (pError)
	{
		if (pError instanceof CompilerRefusal)
		{
			return { Refused: pError.Reason };
		}
		throw pError;
	}
};

// ---------------------------------------------------------------------------------- small helpers

const hasOwn = (pObject, pKey) =>
{
	return (pObject !== null) && (typeof(pObject) === 'object') && Object.prototype.hasOwnProperty.call(pObject, pKey);
};

/**
 * '"T"."C"' / '`T`.`C`' / 'T.C' → 'C' (the Live Util rule; a pure copy so this module moves alone).
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
 * The table qualifier of a filter column, or null.
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
 * A backtick-quoted identifier (schema whitelist names only).
 *
 * @param {string} pName
 * @return {string}
 */
const quote = (pName) =>
{
	if ((typeof(pName) !== 'string') || !libDDL.IDENTIFIER_PATTERN.test(pName))
	{
		refuse('ShapeUnsupported:Identifier');
	}
	return `\`${pName}\``;
};

/**
 * A validated relation alias.
 *
 * @param {string} pAlias
 * @return {string}
 */
const aliasOf = (pAlias) =>
{
	if ((typeof(pAlias) !== 'string') || !ALIAS_PATTERN.test(pAlias))
	{
		refuse('ShapeUnsupported:Alias');
	}
	return pAlias;
};

/**
 * alias.`column`
 *
 * @param {string} pAlias
 * @param {string} pColumn
 * @return {string}
 */
const qualify = (pAlias, pColumn) =>
{
	return `${pAlias}.${quote(pColumn)}`;
};

/**
 * @param {string} pPrefix - a relation alias, 'f' (statement values) or 'q<n>' (fragments)
 * @param {number} pIndex
 * @return {string}
 */
const paramName = (pPrefix, pIndex) =>
{
	let tmpName = `${pPrefix}_${pIndex}`;
	if (!PARAM_NAME_PATTERN.test(tmpName))
	{
		throw new Error('ClickHouse-FoldCompiler: an invalid parameter name.');
	}
	return tmpName;
};

/**
 * And of the non-null predicates (null when none).
 *
 * @param {Array<Record<string, any>|null>} pPreds
 * @return {Record<string, any>|null}
 */
const andOf = (pPreds) =>
{
	let tmpItems = (Array.isArray(pPreds) ? pPreds : []).filter((pPred) => { return (pPred !== null) && (typeof(pPred) === 'object'); });
	if (tmpItems.length < 1)
	{
		return null;
	}
	return (tmpItems.length === 1) ? tmpItems[0] : { Node: 'And', Items: tmpItems };
};

/**
 * The single alias of a column-only FoldPred subtree (Cmp, or And/Or of those on one alias), else null.
 *
 * @param {Record<string, any>} pNode
 * @return {string|null}
 */
const columnAlias = (pNode) =>
{
	if (!pNode || (typeof(pNode) !== 'object'))
	{
		return null;
	}
	if (pNode.Node === 'Cmp')
	{
		return (typeof(pNode.Alias) === 'string') ? pNode.Alias : null;
	}
	if (((pNode.Node === 'And') || (pNode.Node === 'Or')) && Array.isArray(pNode.Items) && (pNode.Items.length > 0))
	{
		let tmpAlias = columnAlias(pNode.Items[0]);
		for (let i = 1; (i < pNode.Items.length) && (tmpAlias !== null); i++)
		{
			if (columnAlias(pNode.Items[i]) !== tmpAlias)
			{
				tmpAlias = null;
			}
		}
		return tmpAlias;
	}
	return null;
};

/**
 * A column-only FoldPred subtree as a Part I Pred ({ Field, Op, Value } / { And } / { Or }).
 *
 * @param {Record<string, any>} pNode
 * @return {Record<string, any>}
 */
const toColumnPred = (pNode) =>
{
	if (pNode.Node === 'Cmp')
	{
		let tmpLeaf = { Field: pNode.Field, Op: pNode.Op };
		if ((pNode.Op !== 'NULL') && (pNode.Op !== 'NOTNULL'))
		{
			tmpLeaf.Value = pNode.Value;
		}
		return tmpLeaf;
	}
	let tmpResult = {};
	tmpResult[(pNode.Node === 'And') ? 'And' : 'Or'] = pNode.Items.map(toColumnPred);
	return tmpResult;
};

/**
 * The identity of one FoxHound filter entry for operator transforms (PredicateCompiler.entrySignature).
 *
 * @param {Record<string, any>} pEntry
 * @return {string|null}
 */
const entrySignature = (pEntry) =>
{
	if (!pEntry || (pEntry.Operator === '(') || (pEntry.Operator === ')'))
	{
		return null;
	}
	return `${stripColumn(pEntry.Column)}|${String(pEntry.Operator)}|${libFacetClauses.canonicalJSON(pEntry.Value)}`;
};

/**
 * A positive integer option, else the default.
 *
 * @param {any} pValue
 * @param {number} pDefault
 * @return {number}
 */
const positive = (pValue, pDefault) =>
{
	return ((typeof(pValue) === 'number') && Number.isFinite(pValue) && (pValue >= 1)) ? Math.floor(pValue) : pDefault;
};

// ---------------------------------------------------------------------------------- the session

/**
 * One compilation's state: the input, the bound parameters, counters, rendered relations.
 *
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const newSession = (pInput) =>
{
	let tmpInput = ((typeof(pInput) === 'object') && (pInput !== null)) ? pInput : {};
	let tmpDialect = (tmpInput.SourceDialect === 'PostgreSQL') ? 'PostgreSQL' : 'SQLite';
	let tmpOrder = tmpInput.SourceStringOrder;
	if ((tmpOrder !== 'Binary') && (tmpOrder !== 'Collated'))
	{
		tmpOrder = (tmpDialect === 'SQLite') ? 'Binary' : 'Collated';
	}
	return (
		{
			Input: tmpInput,
			Database: tmpInput.Database,
			Specs: ((typeof(tmpInput.Specs) === 'object') && (tmpInput.Specs !== null)) ? tmpInput.Specs : {},
			Relations: ((typeof(tmpInput.Relations) === 'object') && (tmpInput.Relations !== null)) ? tmpInput.Relations : {},
			Fragments: ((typeof(tmpInput.Fragments) === 'object') && (tmpInput.Fragments !== null)) ? tmpInput.Fragments : {},
			Lossy: ((typeof(tmpInput.Lossy) === 'object') && (tmpInput.Lossy !== null)) ? tmpInput.Lossy : {},
			Filling: ((typeof(tmpInput.Filling) === 'object') && (tmpInput.Filling !== null)) ? tmpInput.Filling : {},
			Limits: ((typeof(tmpInput.Limits) === 'object') && (tmpInput.Limits !== null)) ? tmpInput.Limits : {},
			Dialect: tmpDialect,
			StringOrder: tmpOrder,
			Params: {},
			Types: {},
			FragmentCount: 0,
			ColumnIndex: new Map(),
			Needs: null
		});
};

/**
 * Bind a value: '{name:Type}'.  A name bound twice must carry the same value and type (a relation
 * rendered twice under one alias binds identical parameters).
 *
 * @param {Record<string, any>} pSession
 * @param {string} pName
 * @param {any} pValue
 * @param {string} pType
 * @return {string}
 */
const bindParameter = (pSession, pName, pValue, pType) =>
{
	if (!PARAM_NAME_PATTERN.test(pName))
	{
		refuse('ShapeUnsupported:Parameter');
	}
	if (hasOwn(pSession.Params, pName))
	{
		if ((libFacetClauses.canonicalJSON(pSession.Params[pName]) !== libFacetClauses.canonicalJSON(pValue)) || (pSession.Types[pName] !== pType))
		{
			refuse('ShapeUnsupported:ParameterCollision');
		}
	}
	let tmpText;
	try
	{
		tmpText = libClickHouseClient.formatParamText(pValue);
	}
	catch (pFormatError)
	{
		refuse('ShapeUnsupported:ParameterValue');
	}
	if (Buffer.byteLength(tmpText, 'utf8') > MAX_PARAM_TEXT)
	{
		// Over the HTTP field limit: a store round trip would fail deterministically (code 1000).
		refuse('ParameterSize');
	}
	pSession.Params[pName] = pValue;
	pSession.Types[pName] = pType;
	return `{${pName}:${pType}}`;
};

/**
 * The text a Float64 value travels as: its shortest round-trip decimal form (JavaScript's own).
 *
 * @param {any} pValue - a finite number (or numeric text)
 * @return {string}
 */
const float64Text = (pValue) =>
{
	return String(numberValue(pValue));
};

/**
 * Bind a value: '{name:Type}'.  A name bound twice must carry the same value and type (a relation
 * rendered twice under one alias binds identical parameters).
 *
 * A Float64 value is bound as its text and converted in the statement, 'toFloat64({name:String})':
 * ClickHouse 24.8 parses a {name:Float64} parameter (like JSONEachRow input) with a fast parser that
 * lands one ulp off for values such as 5.94 / 7.56, so '=', 'IN' and the range edges would disagree
 * with Live at exactly those values; toFloat64(<String>) under precise_float_parsing = 1 (READ_SETTINGS)
 * is exact (internal-contracts §68 #22).  An IN list of Float64 values goes through inList().
 *
 * @param {Record<string, any>} pSession
 * @param {string} pName
 * @param {any} pValue
 * @param {string} pType
 * @return {string}
 */
const bind = (pSession, pName, pValue, pType) =>
{
	if (pType === TYPE_FLOAT64)
	{
		return `toFloat64(${bindParameter(pSession, pName, float64Text(pValue), TYPE_STRING)})`;
	}
	if (pType === `Array(${TYPE_FLOAT64})`)
	{
		// Only inList() may bind a Float64 array (as text, converted inside has()).
		refuse('ShapeUnsupported:Float64Array');
	}
	return bindParameter(pSession, pName, pValue, pType);
};

/**
 * '<column> IN <values>' over a bound array of the column's base type.  Float64 values travel as text
 * (see bind) and the membership test is has(arrayMap(toFloat64, …), <column>): ClickHouse's IN needs a
 * constant right side, and has() answers exactly like IN wherever the compiler uses it — 1 / 0 for a
 * value, and for a NULL column 0 where IN gives NULL, which a WHERE / HAVING treats the same; a column
 * NOT IN guards the NULL itself ('(isNotNull(c) AND NOT (…))', SQL's three-valued logic).
 *
 * @param {Record<string, any>} pSession
 * @param {string} pColumnSQL - the (qualified) column expression
 * @param {string} pName - the parameter name
 * @param {Array<any>} pValues - typed values
 * @param {string} pBase - the column's base mirror type
 * @return {string}
 */
const inList = (pSession, pColumnSQL, pName, pValues, pBase) =>
{
	if (pBase === TYPE_FLOAT64)
	{
		let tmpArray = bindParameter(pSession, pName, pValues.map(float64Text), `Array(${TYPE_STRING})`);
		return `has(arrayMap(rfsValue -> toFloat64(rfsValue), ${tmpArray}), ${pColumnSQL})`;
	}
	return `${pColumnSQL} IN ${bindParameter(pSession, pName, pValues, `Array(${pBase})`)}`;
};

/**
 * The MirrorSpec of an entity (refused when the entity is not mirrored).
 *
 * @param {Record<string, any>} pSession
 * @param {string} pEntity
 * @return {Record<string, any>}
 */
const specOf = (pSession, pEntity) =>
{
	let tmpSpec = hasOwn(pSession.Specs, pEntity) ? pSession.Specs[pEntity] : null;
	if (!tmpSpec || !Array.isArray(tmpSpec.Columns))
	{
		refuse(`NotMirrored:${pEntity}`);
	}
	return tmpSpec;
};

/**
 * A spec column with its usage checked (§63.2): not mirrored or still filling → NotMirrored; a
 * 'Value'-lossy column read anywhere, or a 'Compare'-lossy one in a predicate → LossyColumn.
 *
 * @param {Record<string, any>} pSession
 * @param {string} pEntity
 * @param {string} pColumn
 * @param {string} pUsage - 'Read' | 'Predicate'
 * @return {{ Entity: string, Column: string, DataType: string, Mirror: string, Base: string }}
 */
const specColumn = (pSession, pEntity, pColumn, pUsage) =>
{
	let tmpSpec = specOf(pSession, pEntity);
	let tmpKey = `${pEntity}.${pColumn}`;
	let tmpInfo = pSession.ColumnIndex.get(tmpKey);
	if (!tmpInfo)
	{
		let tmpColumn = tmpSpec.Columns.find((pEntry) => { return pEntry && (pEntry.Column === pColumn); });
		if (!tmpColumn || (typeof(tmpColumn.Mirror) !== 'string') || !libDDL.IDENTIFIER_PATTERN.test(pColumn))
		{
			refuse(`NotMirrored:${pEntity}.${pColumn}`);
		}
		tmpInfo = { Entity: pEntity, Column: pColumn, DataType: tmpColumn.DataType, Mirror: tmpColumn.Mirror, Base: libTypeMap.paramType(tmpColumn.Mirror) };
		pSession.ColumnIndex.set(tmpKey, tmpInfo);
	}
	let tmpFilling = hasOwn(pSession.Filling, pEntity) ? pSession.Filling[pEntity] : null;
	if (Array.isArray(tmpFilling) && (tmpFilling.indexOf(pColumn) >= 0))
	{
		refuse(`NotMirrored:${pEntity}.${pColumn}`);
	}
	let tmpLossy = (hasOwn(pSession.Lossy, pEntity) && hasOwn(pSession.Lossy[pEntity], pColumn)) ? pSession.Lossy[pEntity][pColumn] : null;
	if ((tmpLossy === 'Value') || ((tmpLossy === 'Compare') && (pUsage === 'Predicate')))
	{
		refuse(`LossyColumn:${pEntity}.${pColumn}`);
	}
	return tmpInfo;
};

// ---------------------------------------------------------------------------------- needs

/**
 * A needs collector: every Rel the trees use (by alias) and every column read on every alias.
 *
 * @return {{ Rels: Map<string, Record<string, any>>, Columns: Map<string, Set<string>>, Leaves: Map<string, Array<Record<string, any>>> }}
 */
const newNeeds = () =>
{
	return { Rels: new Map(), Columns: new Map(), Leaves: new Map() };
};

/**
 * @param {Record<string, any>} pNeeds
 * @param {string} pAlias
 * @param {string} pColumn
 */
const need = (pNeeds, pAlias, pColumn) =>
{
	if ((typeof(pAlias) !== 'string') || (typeof(pColumn) !== 'string') || (pColumn.length < 1))
	{
		refuse('ShapeUnsupported:ColumnReference');
	}
	if (!pNeeds.Columns.has(pAlias))
	{
		pNeeds.Columns.set(pAlias, new Set());
	}
	pNeeds.Columns.get(pAlias).add(pColumn);
};

/**
 * Record a Rel used through On pairs.
 *
 * @param {Record<string, any>} pNeeds
 * @param {Record<string, any>} pRel
 * @param {Array<Record<string, any>>} pOn
 */
const useRel = (pNeeds, pRel, pOn) =>
{
	if (!pRel || (typeof(pRel.Entity) !== 'string') || (typeof(pRel.As) !== 'string'))
	{
		refuse('ShapeUnsupported:Relation');
	}
	aliasOf(pRel.As);
	if (!pNeeds.Rels.has(pRel.As))
	{
		pNeeds.Rels.set(pRel.As, pRel);
	}
	let tmpOn = Array.isArray(pOn) ? pOn : [];
	for (let i = 0; i < tmpOn.length; i++)
	{
		if (!tmpOn[i] || !tmpOn[i].Outer || (typeof(tmpOn[i].Inner) !== 'string'))
		{
			refuse('ShapeUnsupported:OnPair');
		}
		need(pNeeds, pRel.As, tmpOn[i].Inner);
		need(pNeeds, tmpOn[i].Outer.Alias, tmpOn[i].Outer.Field);
	}
	let tmpProject = Array.isArray(pRel.Project) ? pRel.Project : [];
	for (let i = 0; i < tmpProject.length; i++)
	{
		need(pNeeds, pRel.As, tmpProject[i]);
	}
};

/**
 * Note one column leaf a fragment renders outside its relation (probed for operator transforms).
 *
 * @param {Record<string, any>} pNeeds
 * @param {string} pAlias
 * @param {Record<string, any>} pLeaf
 */
const noteLeaf = (pNeeds, pAlias, pLeaf) =>
{
	if (!pNeeds.Leaves.has(pAlias))
	{
		pNeeds.Leaves.set(pAlias, []);
	}
	pNeeds.Leaves.get(pAlias).push(pLeaf);
};

/**
 * Collect a FoldPred tree.
 *
 * @param {Record<string, any>} pNeeds
 * @param {Record<string, any>|null} pNode
 */
const collectPred = (pNeeds, pNode) =>
{
	if (!pNode)
	{
		return;
	}
	if (typeof(pNode) !== 'object')
	{
		refuse('ShapeUnsupported:Predicate');
	}
	switch (pNode.Node)
	{
		case 'Cmp':
			{
				need(pNeeds, pNode.Alias, pNode.Field);
				let tmpLeaf = { Field: pNode.Field, Op: pNode.Op };
				if ((pNode.Op !== 'NULL') && (pNode.Op !== 'NOTNULL'))
				{
					tmpLeaf.Value = pNode.Value;
				}
				noteLeaf(pNeeds, pNode.Alias, tmpLeaf);
			}
			return;
		case 'And':
		case 'Or':
			(Array.isArray(pNode.Items) ? pNode.Items : []).forEach((pItem) => { collectPred(pNeeds, pItem); });
			return;
		case 'Exists':
		case 'NotExists':
		case 'CountCmp':
			useRel(pNeeds, pNode.Rel, pNode.On);
			collectPred(pNeeds, pNode.Where || null);
			return;
		case 'True':
		case 'False':
			return;
		default:
			refuse('ShapeUnsupported:Predicate');
	}
};

/**
 * Note every leaf of a Part I column Pred on an alias (cube column flags).
 *
 * @param {Record<string, any>} pNeeds
 * @param {string} pAlias
 * @param {Record<string, any>} pColumnPred
 */
const collectColumnPred = (pNeeds, pAlias, pColumnPred) =>
{
	if (!pColumnPred || (typeof(pColumnPred) !== 'object'))
	{
		return;
	}
	if (Array.isArray(pColumnPred.And) || Array.isArray(pColumnPred.Or))
	{
		(pColumnPred.And || pColumnPred.Or).forEach((pChild) => { collectColumnPred(pNeeds, pAlias, pChild); });
		return;
	}
	if (typeof(pColumnPred.Field) === 'string')
	{
		need(pNeeds, pAlias, pColumnPred.Field);
		noteLeaf(pNeeds, pAlias, pColumnPred);
	}
};

/**
 * Collect one dimension.
 *
 * @param {Record<string, any>} pNeeds
 * @param {Record<string, any>} pDimension
 */
const collectDimension = (pNeeds, pDimension) =>
{
	if (!pDimension || (typeof(pDimension) !== 'object'))
	{
		refuse('ShapeUnsupported:Dimension');
	}
	switch (pDimension.Kind)
	{
		case 'Multi':
			{
				let tmpChain = Array.isArray(pDimension.Chain) ? pDimension.Chain : [];
				if (tmpChain.length < 1)
				{
					refuse('ShapeUnsupported:Dimension');
				}
				for (let i = 0; i < tmpChain.length; i++)
				{
					useRel(pNeeds, tmpChain[i].Rel, tmpChain[i].On);
				}
				need(pNeeds, tmpChain[tmpChain.length - 1].Rel.As, pDimension.KeyField);
				collectPred(pNeeds, pDimension.Where || null);
			}
			return;
		case 'ChildAgg':
			useRel(pNeeds, pDimension.Rel, pDimension.On);
			collectPred(pNeeds, pDimension.Where || null);
			return;
		case 'ExistsFlag':
			collectPred(pNeeds, pDimension.Pred);
			return;
		default:
			break;
	}
	if (Array.isArray(pDimension.Via) && (pDimension.Via.length > 0))
	{
		for (let i = 0; i < pDimension.Via.length; i++)
		{
			useRel(pNeeds, pDimension.Via[i].Rel, pDimension.Via[i].On);
		}
		need(pNeeds, pDimension.Via[pDimension.Via.length - 1].Rel.As, pDimension.Field);
		return;
	}
	if (typeof(pDimension.Field) === 'string')
	{
		need(pNeeds, (typeof(pDimension.Alias) === 'string') ? pDimension.Alias : 'p', pDimension.Field);
	}
};

/**
 * Is an Agg a TuplePivot?
 *
 * @param {Record<string, any>} pAgg
 * @return {boolean}
 */
const isTuple = (pAgg) =>
{
	return !!(pAgg && pAgg.Tuple && (typeof(pAgg.Tuple) === 'object'));
};

/**
 * Is an Agg's first dimension a K9 Multi chain?
 *
 * @param {Record<string, any>} pAgg
 * @return {boolean}
 */
const isMulti = (pAgg) =>
{
	let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
	return (tmpDimensions.length > 0) && tmpDimensions[0] && (tmpDimensions[0].Kind === 'Multi');
};

/**
 * Every Rel and column an Agg (with its Variant's PathPred) reads, by alias.
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>|null} pVariant - { PathPred }
 * @return {Record<string, any>}
 */
const collectAgg = (pAgg, pVariant) =>
{
	let tmpNeeds = newNeeds();
	collectPred(tmpNeeds, (pVariant && pVariant.PathPred) ? pVariant.PathPred : null);
	collectPred(tmpNeeds, pAgg.Where || null);
	let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
	for (let i = 0; i < tmpDimensions.length; i++)
	{
		collectDimension(tmpNeeds, tmpDimensions[i]);
	}
	if ((typeof(pAgg.Field) === 'string') && ([ 'Stats', 'DistinctCount', 'Missing' ].indexOf(pAgg.Kind) >= 0))
	{
		need(tmpNeeds, 'p', pAgg.Field);
	}
	if (isTuple(pAgg))
	{
		let tmpTuple = pAgg.Tuple;
		if (!Array.isArray(tmpTuple.Sides) || !Array.isArray(tmpTuple.Key) || !Array.isArray(tmpTuple.On))
		{
			refuse('ShapeUnsupported:Tuple');
		}
		for (let i = 0; i < tmpTuple.Sides.length; i++)
		{
			let tmpSide = tmpTuple.Sides[i];
			if (!tmpSide || !tmpSide.Rel || (tmpSide.Rel.As !== tmpSide.Alias))
			{
				refuse('ShapeUnsupported:Tuple');
			}
			useRel(tmpNeeds, tmpSide.Rel, []);
		}
		tmpTuple.Key.forEach((pKey) => { need(tmpNeeds, pKey.Alias, pKey.Field); });
		tmpTuple.On.forEach((pPair) => { need(tmpNeeds, pPair.Left.Alias, pPair.Left.Field); need(tmpNeeds, pPair.Right.Alias, pPair.Right.Field); });
	}
	return tmpNeeds;
};

/**
 * Every column pNeeds reads on an alias, the identity first, then sorted.
 *
 * @param {Record<string, any>} pNeeds
 * @param {string} pAlias
 * @param {string} pIdentity
 * @return {Array<string>}
 */
const projectionOf = (pNeeds, pAlias, pIdentity) =>
{
	let tmpColumns = pNeeds.Columns.has(pAlias) ? Array.from(pNeeds.Columns.get(pAlias)) : [];
	let tmpOthers = Array.from(new Set(tmpColumns)).filter((pColumn) => { return pColumn !== pIdentity; }).sort();
	return [ pIdentity ].concat(tmpOthers);
};

// ---------------------------------------------------------------------------------- filters

/**
 * A FoxHound-shaped entry list for a Part I column Pred, rendered exactly as FilterAST.applyToQuery
 * renders it (so the probed operator transforms match the entries by signature).
 *
 * @param {Record<string, any>} pColumnPred
 * @param {string} pDialect
 * @return {Array<Record<string, any>>}
 */
const columnPredEntries = (pColumnPred, pDialect) =>
{
	let tmpEntries = [];
	let fBindable = (pValue) =>
	{
		if (typeof(pValue) === 'boolean')
		{
			return pValue ? 1 : 0;
		}
		if ((typeof(pValue) === 'string') || ((typeof(pValue) === 'number') && Number.isFinite(pValue)))
		{
			return pValue;
		}
		refuse('ShapeUnsupported:PredicateValue');
	};
	let fApply = (pPred, pConnector) =>
	{
		if (!pPred || (typeof(pPred) !== 'object'))
		{
			refuse('ShapeUnsupported:Predicate');
		}
		let tmpKind = Array.isArray(pPred.And) ? 'And' : (Array.isArray(pPred.Or) ? 'Or' : null);
		if (tmpKind)
		{
			let tmpChildren = pPred[tmpKind];
			if (tmpChildren.length < 1)
			{
				refuse('ShapeUnsupported:Predicate');
			}
			tmpEntries.push({ Column: '', Operator: '(', Value: '', Connector: pConnector });
			for (let i = 0; i < tmpChildren.length; i++)
			{
				fApply(tmpChildren[i], (i === 0) ? 'AND' : ((tmpKind === 'Or') ? 'OR' : 'AND'));
			}
			tmpEntries.push({ Column: '', Operator: ')', Value: '', Connector: 'AND' });
			return;
		}
		if (typeof(pPred.Field) !== 'string')
		{
			refuse('ShapeUnsupported:Predicate');
		}
		switch (pPred.Op)
		{
			case 'NULL':
				tmpEntries.push((pDialect === 'SQLite')
					? { Column: pPred.Field, Operator: 'IS', Value: null, Connector: pConnector }
					: { Column: pPred.Field, Operator: 'IS NULL', Value: '', Connector: pConnector });
				return;
			case 'NOTNULL':
				tmpEntries.push({ Column: pPred.Field, Operator: 'IS NOT NULL', Value: '', Connector: pConnector });
				return;
			case 'IN':
			case 'NIN':
				if (!Array.isArray(pPred.Value) || (pPred.Value.length < 1))
				{
					refuse('ShapeUnsupported:PredicateValue');
				}
				tmpEntries.push({ Column: pPred.Field, Operator: FOXHOUND_OPERATORS[pPred.Op], Value: pPred.Value.map(fBindable), Connector: pConnector });
				return;
			default:
				if (!hasOwn(FOXHOUND_OPERATORS, pPred.Op))
				{
					refuse(`OperatorUnsupported:${String(pPred.Op)}`);
				}
				tmpEntries.push({ Column: pPred.Field, Operator: FOXHOUND_OPERATORS[pPred.Op], Value: fBindable(pPred.Value), Connector: pConnector });
				return;
		}
	};
	fApply(pColumnPred, 'AND');
	return tmpEntries;
};

/**
 * One value typed for a mirror column (§63.3 value typing), or a refusal.
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pInfo - specColumn()
 * @param {any} pValue
 * @return {any}
 */
const typedValue = (pSession, pInfo, pValue) =>
{
	let tmpReason = `ValueType:${pInfo.Entity}.${pInfo.Column}`;
	switch (pInfo.Base)
	{
		case TYPE_INT64:
		case TYPE_UINT64:
			if ((typeof(pValue) === 'number') && Number.isSafeInteger(pValue))
			{
				return pValue;
			}
			if ((typeof(pValue) === 'string') && INTEGER_LITERAL_PATTERN.test(pValue) && Number.isSafeInteger(Number(pValue)))
			{
				return Number(pValue);
			}
			return refuse(tmpReason);
		case TYPE_FLOAT64:
			if ((typeof(pValue) === 'number') && Number.isFinite(pValue))
			{
				return pValue;
			}
			if ((typeof(pValue) === 'string') && NUMERIC_LITERAL_PATTERN.test(pValue) && Number.isFinite(Number(pValue)))
			{
				return Number(pValue);
			}
			return refuse(tmpReason);
		case TYPE_UINT8:
			if ((pValue === 0) || (pValue === 1))
			{
				return pValue;
			}
			if ((pValue === '0') || (pValue === '1'))
			{
				return Number(pValue);
			}
			if (typeof(pValue) === 'boolean')
			{
				return pValue ? 1 : 0;
			}
			return refuse(tmpReason);
		case TYPE_STRING:
			if (typeof(pValue) === 'string')
			{
				return pValue;
			}
			return refuse(tmpReason);
		default:
			return refuse(`OperatorType:${pInfo.Entity}.${pInfo.Column}`);
	}
};

/**
 * A DateTime literal (TypeMap.canonicalDateLiteral, §63.3), or a refusal.
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pInfo
 * @param {any} pValue - a scalar or an array (IN)
 * @param {string} pOperator
 * @return {any}
 */
const dateLiteral = (pSession, pInfo, pValue, pOperator) =>
{
	let tmpResult;
	try
	{
		tmpResult = libTypeMap.canonicalDateLiteral(pValue, pOperator, pSession.Dialect);
	}
	catch (pError)
	{
		tmpResult = { Refused: 'DateLiteral' };
	}
	if (!tmpResult || tmpResult.Refused || !hasOwn(tmpResult, 'Literal'))
	{
		refuse(`DateLiteral:${pInfo.Entity}.${pInfo.Column}`);
	}
	return tmpResult.Literal;
};

/**
 * Render FoxHound filter entries as a ClickHouse boolean expression (connectors and groups exactly as
 * FoxHound renders them: the first entry of a group ignores its connector).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pSpec
 * @param {Array<Record<string, any>>} pEntries
 * @param {{ Prefix: string, Qualifier?: string|null }} pOptions
 * @return {string} '' when there are no entries
 */
const compileEntries = (pSession, pSpec, pEntries, pOptions) =>
{
	let tmpEntries = Array.isArray(pEntries) ? pEntries : [];
	let tmpPrefix = pOptions.Prefix;
	let tmpQualifier = (typeof(pOptions.Qualifier) === 'string') ? pOptions.Qualifier : null;
	let tmpEntity = pSpec.Entity;
	let tmpTokens = [];
	let tmpDepth = 0;
	let tmpOrdinal = 0;
	let tmpSuppressConnector = true;
	let fColumn = (pEntry) =>
	{
		let tmpColumn = stripColumn(pEntry.Column);
		let tmpTable = columnQualifier(pEntry.Column);
		if ((tmpTable !== null) && (tmpTable !== tmpEntity))
		{
			// A column of another table means a join the capture cannot see (ScopeCapture: Opaque).
			refuse(`OpaqueScope:${tmpEntity}`);
		}
		if (!libDDL.IDENTIFIER_PATTERN.test(tmpColumn))
		{
			refuse(`NotMirrored:${tmpEntity}.${tmpColumn}`);
		}
		return tmpColumn;
	};
	let fValueName = () =>
	{
		let tmpName = paramName(tmpPrefix, tmpOrdinal);
		tmpOrdinal++;
		return tmpName;
	};
	for (let i = 0; i < tmpEntries.length; i++)
	{
		let tmpEntry = tmpEntries[i];
		if (!tmpEntry || (typeof(tmpEntry) !== 'object'))
		{
			refuse('ShapeUnsupported:FilterEntry');
		}
		let tmpOperator = (typeof(tmpEntry.Operator) === 'string') ? tmpEntry.Operator.trim().toUpperCase() : '';
		let tmpConnector = (typeof(tmpEntry.Connector) === 'string') ? tmpEntry.Connector.trim().toUpperCase() : 'AND';
		if ((tmpConnector !== 'AND') && (tmpConnector !== 'OR') && (tmpConnector !== 'NONE'))
		{
			refuse(`OperatorUnsupported:${tmpConnector}`);
		}
		if (tmpOperator === ')')
		{
			if (tmpDepth < 1)
			{
				refuse('ShapeUnsupported:Parentheses');
			}
			tmpDepth--;
			tmpTokens.push(')');
			tmpSuppressConnector = false;
			continue;
		}
		if (!tmpSuppressConnector)
		{
			if (tmpConnector === 'NONE')
			{
				// FoxHound renders no connector: not a valid boolean expression.
				refuse('OperatorUnsupported:NONE');
			}
			tmpTokens.push(tmpConnector);
		}
		if (tmpOperator === '(')
		{
			tmpDepth++;
			tmpTokens.push('(');
			tmpSuppressConnector = true;
			continue;
		}
		tmpSuppressConnector = false;
		if (!hasOwn(OPERATOR_MAP, tmpOperator))
		{
			refuse(`OperatorUnsupported:${tmpOperator || '?'}`);
		}
		let tmpColumnName = fColumn(tmpEntry);
		let tmpInfo = specColumn(pSession, tmpEntity, tmpColumnName, 'Predicate');
		let tmpColumnSQL = tmpQualifier ? qualify(tmpQualifier, tmpColumnName) : quote(tmpColumnName);
		let tmpIsDate = (tmpInfo.Base === TYPE_DATETIME);
		switch (tmpOperator)
		{
			case 'IS':
				if ((tmpEntry.Value !== null) && (typeof(tmpEntry.Value) !== 'undefined'))
				{
					refuse('OperatorUnsupported:IS');
				}
				tmpTokens.push(`isNull(${tmpColumnSQL})`);
				break;
			case 'IS NULL':
				tmpTokens.push(`isNull(${tmpColumnSQL})`);
				break;
			case 'IS NOT NULL':
				tmpTokens.push(`isNotNull(${tmpColumnSQL})`);
				break;
			case 'IN':
			case 'NOT IN':
				{
					let tmpValues = Array.isArray(tmpEntry.Value) ? tmpEntry.Value : [ tmpEntry.Value ];
					if (tmpValues.some((pValue) => { return (pValue === null) || (typeof(pValue) === 'undefined'); }))
					{
						// NULL inside an IN list: SQL would compare NULL (unknown); not reproduced.
						refuse(`ValueType:${tmpEntity}.${tmpColumnName}`);
					}
					if (tmpValues.length < 1)
					{
						tmpTokens.push((tmpOperator === 'IN') ? '0' : '1');
						break;
					}
					let tmpTyped = tmpIsDate ? dateLiteral(pSession, tmpInfo, tmpValues, '=') : tmpValues.map((pValue) => { return typedValue(pSession, tmpInfo, pValue); });
					let tmpMember = inList(pSession, tmpColumnSQL, fValueName(), tmpTyped, tmpInfo.Base);
					// A column NOT IN keeps SQL's three-valued logic: NULL NOT IN (…) is unknown, so the row
					// is dropped exactly as Live / FoxHound drops it (only an anti-join keeps a NULL row).
					tmpTokens.push((tmpOperator === 'IN') ? tmpMember : `(isNotNull(${tmpColumnSQL}) AND NOT (${tmpMember}))`);
				}
				break;
			case 'LIKE':
			case 'NOT LIKE':
			case 'ILIKE':
			case 'NOT ILIKE':
				{
					if (tmpInfo.Base !== TYPE_STRING)
					{
						refuse(`OperatorType:${tmpEntity}.${tmpColumnName}`);
					}
					if (typeof(tmpEntry.Value) !== 'string')
					{
						refuse(`ValueType:${tmpEntity}.${tmpColumnName}`);
					}
					let tmpPattern = tmpEntry.Value;
					let tmpFunction;
					if ((tmpOperator === 'LIKE') || (tmpOperator === 'NOT LIKE'))
					{
						if (pSession.Dialect === 'SQLite')
						{
							// SQLite LIKE: ASCII case-insensitive, no escape character (a '\' is literal).
							if (/[^\x00-\x7F]/.test(tmpPattern))
							{
								refuse(`LikeCase:${tmpEntity}.${tmpColumnName}`);
							}
							tmpPattern = tmpPattern.replace(/\\/g, '\\\\');
							tmpFunction = 'ILIKE';
						}
						else
						{
							tmpFunction = 'LIKE';
						}
					}
					else
					{
						tmpFunction = 'ILIKE';
					}
					let tmpNegated = (tmpOperator.indexOf('NOT ') === 0);
					let tmpBind = bind(pSession, fValueName(), tmpPattern, TYPE_STRING);
					tmpTokens.push(`${tmpColumnSQL} ${tmpNegated ? 'NOT ' : ''}${tmpFunction} ${tmpBind}`);
				}
				break;
			default:
				{
					// = != <> < <= > >=
					let tmpSQLOperator = OPERATOR_MAP[tmpOperator];
					if ((tmpEntry.Value === null) || (typeof(tmpEntry.Value) === 'undefined'))
					{
						// A comparison with NULL is unknown: never true in a filter (FoxHound binds NULL).
						tmpTokens.push('0');
						break;
					}
					if (Array.isArray(tmpEntry.Value))
					{
						refuse(`ValueType:${tmpEntity}.${tmpColumnName}`);
					}
					if ((tmpInfo.Base === TYPE_STRING) && ([ '<', '<=', '>', '>=' ].indexOf(tmpSQLOperator) >= 0) && (pSession.StringOrder !== 'Binary'))
					{
						refuse(`StringOrder:${tmpEntity}.${tmpColumnName}`);
					}
					let tmpTyped = tmpIsDate ? dateLiteral(pSession, tmpInfo, tmpEntry.Value, tmpOperator) : typedValue(pSession, tmpInfo, tmpEntry.Value);
					let tmpBind = bind(pSession, fValueName(), tmpTyped, tmpInfo.Base);
					tmpTokens.push(`${tmpColumnSQL} ${tmpSQLOperator} ${tmpBind}`);
				}
				break;
		}
	}
	if (tmpDepth !== 0)
	{
		refuse('ShapeUnsupported:Parentheses');
	}
	return tmpTokens.join(' ');
};

/**
 * Fail closed (06 §4.3): a Tenant / Personal entity's final filter must hold a depth-0 '=' AND entry
 * on its tenant column (the owner column for a Personal entity without one), with no depth-0 OR.
 *
 * @param {Record<string, any>} pSpec
 * @param {Array<Record<string, any>>} pEntries
 */
const assertScoped = (pSpec, pEntries) =>
{
	if ((pSpec.Kind !== 'Tenant') && (pSpec.Kind !== 'Personal'))
	{
		return;
	}
	let tmpColumn = pSpec.TenantColumn || ((pSpec.Kind === 'Personal') ? pSpec.OwnerColumn : null);
	let tmpReason = `ScopeMissing:${pSpec.Entity}`;
	if (typeof(tmpColumn) !== 'string')
	{
		refuse(tmpReason);
	}
	let tmpEntries = Array.isArray(pEntries) ? pEntries : [];
	let tmpDepth = 0;
	let tmpFound = false;
	let tmpFirstAtDepth0 = true;
	for (let i = 0; i < tmpEntries.length; i++)
	{
		let tmpEntry = tmpEntries[i] || {};
		let tmpOperator = (typeof(tmpEntry.Operator) === 'string') ? tmpEntry.Operator.trim().toUpperCase() : '';
		let tmpConnector = (typeof(tmpEntry.Connector) === 'string') ? tmpEntry.Connector.trim().toUpperCase() : 'AND';
		if (tmpOperator === ')')
		{
			tmpDepth--;
			continue;
		}
		if (tmpDepth === 0)
		{
			if (!tmpFirstAtDepth0 && (tmpConnector === 'OR'))
			{
				refuse(tmpReason);
			}
			if ((tmpOperator === '=') && (stripColumn(tmpEntry.Column) === tmpColumn) && (tmpEntry.Value !== null) && (typeof(tmpEntry.Value) !== 'undefined') && (tmpEntry.Value !== '')
				&& (tmpFirstAtDepth0 || (tmpConnector === 'AND')))
			{
				tmpFound = true;
			}
			tmpFirstAtDepth0 = false;
		}
		if (tmpOperator === '(')
		{
			tmpDepth++;
		}
	}
	if (!tmpFound)
	{
		refuse(tmpReason);
	}
};

// ---------------------------------------------------------------------------------- relations

/**
 * The derived-table SQL of one relation alias (without its alias): one FINAL scan of the mirror
 * with `_IsDeleted` = 0 and the relation's captured, post-behavior filter.  Identical for every
 * rendering of the same (alias, projection) in a statement.
 *
 * @param {Record<string, any>} pSession
 * @param {string} pAlias
 * @param {Array<string>} [pColumns] - the projection (default: everything the needs read on the alias)
 * @return {string}
 */
const relationSQL = (pSession, pAlias, pColumns) =>
{
	aliasOf(pAlias);
	let tmpRelation = hasOwn(pSession.Relations, pAlias) ? pSession.Relations[pAlias] : null;
	if (!tmpRelation || (typeof(tmpRelation.Entity) !== 'string'))
	{
		refuse('ShapeUnsupported:Relation');
	}
	let tmpEntity = tmpRelation.Entity;
	let tmpCapture = tmpRelation.Capture || null;
	if (tmpCapture && ((tmpCapture.Opaque === true) || (tmpCapture.Portable === false)))
	{
		refuse(`OpaqueScope:${tmpEntity}`);
	}
	let tmpSpec = specOf(pSession, tmpEntity);
	let tmpIdentity = tmpSpec.Identity;
	specColumn(pSession, tmpEntity, tmpIdentity, 'Read');
	let tmpColumns = Array.isArray(pColumns) ? pColumns : (pSession.Needs ? projectionOf(pSession.Needs, pAlias, tmpIdentity) : [ tmpIdentity ]);
	let tmpProjection = [ tmpIdentity ].concat(Array.from(new Set(tmpColumns)).filter((pColumn) => { return pColumn !== tmpIdentity; }));
	for (let i = 0; i < tmpProjection.length; i++)
	{
		specColumn(pSession, tmpEntity, tmpProjection[i], 'Read');
	}
	let tmpFilter = Array.isArray(tmpRelation.Filter) ? tmpRelation.Filter : [];
	assertScoped(tmpSpec, tmpFilter);
	let tmpWhere = compileEntries(pSession, tmpSpec, tmpFilter, { Prefix: pAlias, Qualifier: null });
	if (!libDDL.IDENTIFIER_PATTERN.test(String(pSession.Database)))
	{
		refuse('StoreUnavailable');
	}
	let tmpTable = libDDL.qualified(pSession.Database, libDDL.mirrorTableName(tmpEntity));
	return `SELECT ${tmpProjection.map(quote).join(', ')} FROM ${tmpTable} FINAL WHERE \`_IsDeleted\` = 0${(tmpWhere.length > 0) ? ` AND (${tmpWhere})` : ''}`;
};

/**
 * The entity an alias reads.
 *
 * @param {Record<string, any>} pSession
 * @param {string} pAlias
 * @return {string}
 */
const aliasEntity = (pSession, pAlias) =>
{
	let tmpRelation = hasOwn(pSession.Relations, pAlias) ? pSession.Relations[pAlias] : null;
	if (!tmpRelation || (typeof(tmpRelation.Entity) !== 'string'))
	{
		refuse('ShapeUnsupported:Relation');
	}
	return tmpRelation.Entity;
};

// ---------------------------------------------------------------------------------- predicates

/**
 * A column-only subtree on one alias as an inline fragment (qualified columns), with the probed
 * post-behavior operators of its entity (§63.3, the Live PredicateFragment rule).
 *
 * @param {Record<string, any>} pSession
 * @param {string} pAlias
 * @param {Record<string, any>} pColumnPred - Part I Pred
 * @return {string}
 */
const fragmentSQL = (pSession, pAlias, pColumnPred) =>
{
	let tmpEntity = aliasEntity(pSession, pAlias);
	let tmpSpec = specOf(pSession, tmpEntity);
	let tmpEntries = columnPredEntries(pColumnPred, pSession.Dialect);
	let tmpTransforms = hasOwn(pSession.Fragments, tmpEntity) ? pSession.Fragments[tmpEntity] : null;
	if (tmpTransforms && (typeof(tmpTransforms) === 'object'))
	{
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpSignature = entrySignature(tmpEntries[i]);
			if (tmpSignature && hasOwn(tmpTransforms, tmpSignature))
			{
				let tmpOperator = String(tmpTransforms[tmpSignature]).trim().toUpperCase();
				if (!hasOwn(OPERATOR_MAP, tmpOperator) || (tmpOperator === '(') || (tmpOperator === ')'))
				{
					refuse(`Transformed:${tmpEntity}`);
				}
				tmpEntries[i] = Object.assign({}, tmpEntries[i], { Operator: tmpOperator });
			}
		}
	}
	pSession.FragmentCount++;
	let tmpSQL = compileEntries(pSession, tmpSpec, tmpEntries, { Prefix: `q${pSession.FragmentCount}`, Qualifier: pAlias });
	return `(${tmpSQL})`;
};

/**
 * The On pairs of an existence node, checked (every outer alias in scope) and typed for comparison.
 *
 * @param {Record<string, any>} pSession
 * @param {Array<Record<string, any>>} pOn
 * @param {string} pInnerAlias
 * @param {Array<string>} pScope
 * @return {{ Outer: Array<string>, Inner: Array<string> }}
 */
const onColumns = (pSession, pOn, pInnerAlias, pScope) =>
{
	if (!Array.isArray(pOn) || (pOn.length < 1))
	{
		refuse('ShapeUnsupported:OnPair');
	}
	let tmpInnerEntity = aliasEntity(pSession, pInnerAlias);
	let tmpOuter = [];
	let tmpInner = [];
	for (let i = 0; i < pOn.length; i++)
	{
		let tmpPair = pOn[i];
		if (!tmpPair || !tmpPair.Outer || (typeof(tmpPair.Outer.Alias) !== 'string') || (typeof(tmpPair.Outer.Field) !== 'string') || (typeof(tmpPair.Inner) !== 'string'))
		{
			refuse('ShapeUnsupported:OnPair');
		}
		if (pScope.indexOf(tmpPair.Outer.Alias) < 0)
		{
			// The outer column is not in this subquery's scope: a correlated reference ClickHouse 24.8
			// cannot evaluate (multi-level correlation).
			refuse('ShapeUnsupported:Correlation');
		}
		specColumn(pSession, aliasEntity(pSession, tmpPair.Outer.Alias), tmpPair.Outer.Field, 'Predicate');
		specColumn(pSession, tmpInnerEntity, tmpPair.Inner, 'Predicate');
		tmpOuter.push(qualify(tmpPair.Outer.Alias, tmpPair.Outer.Field));
		tmpInner.push(qualify(pInnerAlias, tmpPair.Inner));
	}
	return { Outer: tmpOuter, Inner: tmpInner };
};

/**
 * Compile a FoldPred node in a scope (the aliases visible at this level).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pNode
 * @param {Array<string>} pScope
 * @return {string}
 */
const predSQL = (pSession, pNode, pScope) =>
{
	if (!pNode || (typeof(pNode) !== 'object') || (typeof(pNode.Node) !== 'string'))
	{
		refuse('ShapeUnsupported:Predicate');
	}
	switch (pNode.Node)
	{
		case 'True':
			return '1';
		case 'False':
			return '0';
		case 'Cmp':
		case 'And':
		case 'Or':
			{
				if (((pNode.Node === 'And') || (pNode.Node === 'Or')) && (!Array.isArray(pNode.Items) || (pNode.Items.length < 1)))
				{
					return (pNode.Node === 'And') ? '1' : '0';
				}
				let tmpAlias = columnAlias(pNode);
				if (tmpAlias !== null)
				{
					if (pScope.indexOf(tmpAlias) < 0)
					{
						refuse('ShapeUnsupported:Correlation');
					}
					return fragmentSQL(pSession, tmpAlias, toColumnPred(pNode));
				}
				if (pNode.Node === 'Cmp')
				{
					refuse('ShapeUnsupported:Predicate');
				}
				let tmpParts = pNode.Items.map((pItem) => { return predSQL(pSession, pItem, pScope); });
				return (tmpParts.length === 1) ? tmpParts[0] : `(${tmpParts.join((pNode.Node === 'And') ? ' AND ' : ' OR ')})`;
			}
		case 'Exists':
		case 'NotExists':
			return existsSQL(pSession, pNode, pScope);
		case 'CountCmp':
			return countCmpSQL(pSession, pNode, pScope);
		default:
			return refuse('ShapeUnsupported:Predicate');
	}
};

/**
 * Exists / NotExists → [NOT] ifNull((outer…) IN (SELECT inner… FROM (<R>) AS <As> [WHERE …]), 0).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pNode
 * @param {Array<string>} pScope
 * @return {string}
 */
const existsSQL = (pSession, pNode, pScope) =>
{
	if (!pNode.Rel || (typeof(pNode.Rel.As) !== 'string'))
	{
		refuse('ShapeUnsupported:Relation');
	}
	let tmpAlias = aliasOf(pNode.Rel.As);
	let tmpOn = onColumns(pSession, pNode.On, tmpAlias, pScope);
	let tmpNested = pNode.Where ? predSQL(pSession, pNode.Where, [ tmpAlias ]) : '';
	let tmpRelation = relationSQL(pSession, tmpAlias);
	let tmpOuter = (tmpOn.Outer.length === 1) ? tmpOn.Outer[0] : `(${tmpOn.Outer.join(', ')})`;
	let tmpSubquery = `SELECT ${tmpOn.Inner.join(', ')} FROM (${tmpRelation}) AS ${tmpAlias}${(tmpNested.length > 0) ? ` WHERE ${tmpNested}` : ''}`;
	let tmpSQL = `ifNull(${tmpOuter} IN (${tmpSubquery}), 0)`;
	return (pNode.Node === 'NotExists') ? `NOT ${tmpSQL}` : tmpSQL;
};

/**
 * CountCmp (K19) with P(c) = c Op N: P(0) false → ifNull(o IN (… GROUP BY … HAVING P(count())), 0);
 * P(0) true → NOT ifNull(o IN (… HAVING NOT P(count())), 0) — a row with no visible match counts 0.
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pNode
 * @param {Array<string>} pScope
 * @return {string}
 */
const countCmpSQL = (pSession, pNode, pScope) =>
{
	let tmpOperator = hasOwn(COUNT_OPERATORS, pNode.Op) ? COUNT_OPERATORS[pNode.Op] : null;
	if (!tmpOperator || (typeof(pNode.N) !== 'number') || !Number.isSafeInteger(pNode.N) || (pNode.N < 0))
	{
		refuse('ShapeUnsupported:CountCmp');
	}
	if (!pNode.Rel || (typeof(pNode.Rel.As) !== 'string'))
	{
		refuse('ShapeUnsupported:Relation');
	}
	let tmpAlias = aliasOf(pNode.Rel.As);
	let tmpOn = onColumns(pSession, pNode.On, tmpAlias, pScope);
	let tmpNested = pNode.Where ? predSQL(pSession, pNode.Where, [ tmpAlias ]) : '';
	let tmpRelation = relationSQL(pSession, tmpAlias);
	pSession.FragmentCount++;
	let tmpN = bind(pSession, `q${pSession.FragmentCount}_N`, pNode.N, TYPE_UINT64);
	let tmpZeroHolds = { '=': (0 === pNode.N), '!=': (0 !== pNode.N), '>': (0 > pNode.N), '>=': (0 >= pNode.N), '<': (0 < pNode.N), '<=': (0 <= pNode.N) }[tmpOperator];
	let tmpHaving = tmpZeroHolds ? `NOT (count() ${tmpOperator} ${tmpN})` : `count() ${tmpOperator} ${tmpN}`;
	let tmpOuter = (tmpOn.Outer.length === 1) ? tmpOn.Outer[0] : `(${tmpOn.Outer.join(', ')})`;
	let tmpSubquery = `SELECT ${tmpOn.Inner.join(', ')} FROM (${tmpRelation}) AS ${tmpAlias}${(tmpNested.length > 0) ? ` WHERE ${tmpNested}` : ''} GROUP BY ${tmpOn.Inner.join(', ')} HAVING ${tmpHaving}`;
	let tmpSQL = `ifNull(${tmpOuter} IN (${tmpSubquery}), 0)`;
	return tmpZeroHolds ? `NOT ${tmpSQL}` : tmpSQL;
};

// ---------------------------------------------------------------------------------- bases

/**
 * The type info of a base column (pass-through or synthetic).
 *
 * @param {string} pBase
 * @param {string} pDataType
 * @return {Record<string, any>}
 */
const syntheticInfo = (pBase, pDataType) =>
{
	return { Entity: null, Column: null, DataType: pDataType, Mirror: pBase, Base: pBase };
};

/**
 * Compose the entity-pivot base (layers R / W / J), §26.4 with ClickHouse forms.
 *
 * pSpec: { Preds: [ FoldPred … ], Dims: [ Dim … ], Flags: [ { Column, ColumnPred } | { Column, Pred } ] }
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pSpec
 * @return {{ SQL: string, Columns: Map<string, Record<string, any>>, Dims: Array<Record<string, any>> }}
 */
const entityBase = (pSession, pSpec) =>
{
	let tmpPivotEntity = aliasEntity(pSession, 'p');
	let tmpPivotSpec = specOf(pSession, tmpPivotEntity);
	let tmpPivotColumns = projectionOf(pSession.Needs, 'p', tmpPivotSpec.Identity);
	let tmpColumns = new Map();
	tmpPivotColumns.forEach((pColumn) => { tmpColumns.set(pColumn, specColumn(pSession, tmpPivotEntity, pColumn, 'Read')); });
	let fName = (pName) =>
	{
		if (tmpColumns.has(pName))
		{
			refuse('ShapeUnsupported:ColumnCollision');
		}
		return pName;
	};

	let tmpSQL = relationSQL(pSession, 'p', tmpPivotColumns);

	// W: pivot-level predicates first, computed 0/1 columns.
	let tmpWhere = andOf(Array.isArray(pSpec.Preds) ? pSpec.Preds : []);
	let tmpWhereSQL = tmpWhere ? predSQL(pSession, tmpWhere, [ 'p' ]) : '';
	let tmpComputed = [];
	let tmpFlags = Array.isArray(pSpec.Flags) ? pSpec.Flags : [];
	for (let i = 0; i < tmpFlags.length; i++)
	{
		let tmpName = fName(tmpFlags[i].Column);
		quote(tmpName);
		let tmpCondition = tmpFlags[i].ColumnPred ? fragmentSQL(pSession, 'p', tmpFlags[i].ColumnPred) : predSQL(pSession, tmpFlags[i].Pred, [ 'p' ]);
		tmpComputed.push({ Name: tmpName, SQL: `if(${tmpCondition}, 1, 0)` });
		tmpColumns.set(tmpName, syntheticInfo(TYPE_UINT8, 'Boolean'));
	}
	let tmpDims = Array.isArray(pSpec.Dims) ? pSpec.Dims : [];
	let tmpRewritten = [];
	let tmpJoins = [];
	let tmpJoinColumns = [];
	for (let i = 0; i < tmpDims.length; i++)
	{
		let tmpDimension = tmpDims[i];
		if (!tmpDimension || (typeof(tmpDimension) !== 'object'))
		{
			refuse('ShapeUnsupported:Dimension');
		}
		if (tmpDimension.Kind === 'ExistsFlag')
		{
			let tmpName = fName(`FacetX${i}`);
			if (!tmpDimension.Pred)
			{
				refuse('ShapeUnsupported:Dimension');
			}
			tmpComputed.push({ Name: tmpName, SQL: `if(${predSQL(pSession, tmpDimension.Pred, [ 'p' ])}, 1, 0)` });
			tmpColumns.set(tmpName, syntheticInfo(TYPE_UINT8, 'Boolean'));
			tmpRewritten.push(Object.assign({}, tmpDimension, { Field: tmpName, DataType: 'Boolean', IsInteger: true }));
		}
		else if (tmpDimension.Kind === 'ChildAgg')
		{
			let tmpName = fName(`FacetC${i}`);
			let tmpJoin = childJoinSQL(pSession, tmpDimension, i, tmpPivotSpec.Identity);
			tmpJoins.push(tmpJoin.Join);
			tmpJoinColumns.push(`${tmpJoin.Value} AS ${quote(tmpName)}`);
			tmpColumns.set(tmpName, syntheticInfo(TYPE_UINT64, 'Numeric'));
			tmpRewritten.push(Object.assign({}, tmpDimension, { Field: tmpName, DataType: 'Numeric', IsInteger: true }));
		}
		else if (Array.isArray(tmpDimension.Via) && (tmpDimension.Via.length > 0))
		{
			let tmpName = fName(`FacetV${i}`);
			let tmpPlaced = [ 'p' ];
			for (let j = 0; j < tmpDimension.Via.length; j++)
			{
				let tmpLink = tmpDimension.Via[j];
				if (!tmpLink || !tmpLink.Rel)
				{
					refuse('ShapeUnsupported:Dimension');
				}
				let tmpAlias = aliasOf(tmpLink.Rel.As);
				let tmpOn = onColumns(pSession, tmpLink.On, tmpAlias, tmpPlaced);
				let tmpConditions = tmpOn.Inner.map((pInner, pIndex) => { return `${pInner} = ${tmpOn.Outer[pIndex]}`; });
				tmpJoins.push(`ANY LEFT JOIN (${relationSQL(pSession, tmpAlias)}) AS ${tmpAlias} ON ${tmpConditions.join(' AND ')}`);
				tmpPlaced.push(tmpAlias);
			}
			let tmpLast = tmpDimension.Via[tmpDimension.Via.length - 1].Rel.As;
			let tmpInfo = specColumn(pSession, aliasEntity(pSession, tmpLast), tmpDimension.Field, 'Read');
			tmpJoinColumns.push(`${qualify(tmpLast, tmpDimension.Field)} AS ${quote(tmpName)}`);
			tmpColumns.set(tmpName, tmpInfo);
			let tmpCopy = Object.assign({}, tmpDimension, { Field: tmpName });
			delete tmpCopy.Via;
			tmpRewritten.push(tmpCopy);
		}
		else
		{
			if ((typeof(tmpDimension.Alias) === 'string') && (tmpDimension.Alias !== 'p'))
			{
				refuse('ShapeUnsupported:Dimension');
			}
			if ((typeof(tmpDimension.Field) === 'string') && !tmpColumns.has(tmpDimension.Field))
			{
				refuse('ShapeUnsupported:Dimension');
			}
			tmpRewritten.push(tmpDimension);
		}
	}

	let tmpPassThrough = (pNames) => { return pNames.map((pName) => { return `${qualify('p', pName)} AS ${quote(pName)}`; }); };
	if ((tmpWhereSQL.length > 0) || (tmpComputed.length > 0))
	{
		let tmpSelect = tmpPassThrough(tmpPivotColumns).concat(tmpComputed.map((pComputed) => { return `${pComputed.SQL} AS ${quote(pComputed.Name)}`; }));
		tmpSQL = `SELECT ${tmpSelect.join(', ')} FROM (${tmpSQL}) AS p${(tmpWhereSQL.length > 0) ? ` WHERE ${tmpWhereSQL}` : ''}`;
	}
	if (tmpJoins.length > 0)
	{
		let tmpWColumns = tmpPivotColumns.concat(tmpComputed.map((pComputed) => { return pComputed.Name; }));
		let tmpSelect = tmpPassThrough(tmpWColumns).concat(tmpJoinColumns);
		tmpSQL = `SELECT ${tmpSelect.join(', ')} FROM (${tmpSQL}) AS p ${tmpJoins.join(' ')}`;
	}
	return { SQL: tmpSQL, Columns: tmpColumns, Dims: tmpRewritten, Identity: tmpPivotSpec.Identity };
};

/**
 * K12: the per-pivot-row count of matching visible children, as a LEFT JOIN of the child counts
 * restricted to the pivot's keys (03 §3.4's restricted form; join_use_nulls → no child = NULL → 0).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pDimension - ChildAgg
 * @param {number} pIndex
 * @param {string} pPivotIdentity
 * @return {{ Join: string, Value: string }}
 */
const childJoinSQL = (pSession, pDimension, pIndex, pPivotIdentity) =>
{
	if (!pDimension.Rel || (typeof(pDimension.Rel.As) !== 'string') || ((pDimension.Agg !== 'count') && (typeof(pDimension.Agg) !== 'undefined')))
	{
		refuse('ShapeUnsupported:ChildAgg');
	}
	let tmpAlias = aliasOf(pDimension.Rel.As);
	let tmpOn = onColumns(pSession, pDimension.On, tmpAlias, [ 'p' ]);
	let tmpGroupAlias = `ca${pIndex}`;
	let tmpKeys = tmpOn.Inner.map((pInner, pKeyIndex) => { return `${pInner} AS ${quote(`K${pKeyIndex}`)}`; });
	let tmpKeyNames = tmpOn.Inner.map((pInner, pKeyIndex) => { return quote(`K${pKeyIndex}`); });
	let tmpConditions = [];
	if (pDimension.On.length === 1)
	{
		// Restrict the child scan to the pivot's own keys (a second rendering of the pivot relation).
		let tmpOuterField = pDimension.On[0].Outer.Field;
		tmpConditions.push(`${tmpOn.Inner[0]} IN (SELECT ${qualify('p2', tmpOuterField)} FROM (${relationSQL(pSession, 'p', [ pPivotIdentity, tmpOuterField ])}) AS p2)`);
	}
	if (pDimension.Where)
	{
		tmpConditions.push(predSQL(pSession, pDimension.Where, [ tmpAlias ]));
	}
	let tmpJoin = `LEFT JOIN (SELECT ${tmpKeys.join(', ')}, count() AS \`N\` FROM (${relationSQL(pSession, tmpAlias)}) AS ${tmpAlias}`
		+ `${(tmpConditions.length > 0) ? ` WHERE ${tmpConditions.join(' AND ')}` : ''} GROUP BY ${tmpKeyNames.join(', ')}) AS ${tmpGroupAlias}`
		+ ` ON ${tmpOn.Outer.map((pOuter, pKeyIndex) => { return `${tmpGroupAlias}.${quote(`K${pKeyIndex}`)} = ${pOuter}`; }).join(' AND ')}`;
	return { Join: tmpJoin, Value: `ifNull(${tmpGroupAlias}.\`N\`, 0)` };
};

/**
 * The TuplePivot base (K18): one row per distinct Key tuple with its dimension values.
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pAgg
 * @param {Array<Record<string, any>|null>} pPreds
 * @return {{ SQL: string, Columns: Map<string, Record<string, any>>, Dims: Array<Record<string, any>> }}
 */
const tupleBase = (pSession, pAgg, pPreds) =>
{
	let tmpTuple = pAgg.Tuple;
	let tmpSides = tmpTuple.Sides;
	if (!Array.isArray(tmpSides) || (tmpSides.length < 2) || (tmpSides[0].Alias !== 'p'))
	{
		refuse('ShapeUnsupported:Tuple');
	}
	let tmpAliases = tmpSides.map((pSide) => { return aliasOf(pSide.Alias); });
	let tmpWhere = andOf(pPreds);
	let tmpWhereSQL = tmpWhere ? predSQL(pSession, tmpWhere, tmpAliases) : '';
	let tmpColumns = new Map();
	let tmpSelect = [];
	for (let i = 0; i < tmpTuple.Key.length; i++)
	{
		let tmpKey = tmpTuple.Key[i];
		if (tmpAliases.indexOf(tmpKey.Alias) < 0)
		{
			refuse('ShapeUnsupported:Tuple');
		}
		let tmpInfo = specColumn(pSession, aliasEntity(pSession, tmpKey.Alias), tmpKey.Field, 'Read');
		tmpSelect.push(`${qualify(tmpKey.Alias, tmpKey.Field)} AS ${quote(`TK${i}`)}`);
		tmpColumns.set(`TK${i}`, tmpInfo);
	}
	let tmpDims = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
	let tmpRewritten = [];
	for (let i = 0; i < tmpDims.length; i++)
	{
		let tmpDimension = tmpDims[i];
		let tmpAlias = (typeof(tmpDimension.Alias) === 'string') ? tmpDimension.Alias : 'p';
		if ((tmpAliases.indexOf(tmpAlias) < 0) || Array.isArray(tmpDimension.Via) || (typeof(tmpDimension.Field) !== 'string'))
		{
			refuse('ShapeUnsupported:Tuple');
		}
		let tmpInfo = specColumn(pSession, aliasEntity(pSession, tmpAlias), tmpDimension.Field, 'Read');
		let tmpName = `FacetT${i}`;
		tmpSelect.push(`${qualify(tmpAlias, tmpDimension.Field)} AS ${quote(tmpName)}`);
		tmpColumns.set(tmpName, tmpInfo);
		let tmpCopy = Object.assign({}, tmpDimension, { Field: tmpName });
		delete tmpCopy.Alias;
		tmpRewritten.push(tmpCopy);
	}
	let tmpFrom = [];
	let tmpPlaced = [];
	for (let i = 0; i < tmpSides.length; i++)
	{
		let tmpAlias = tmpSides[i].Alias;
		let tmpRelation = relationSQL(pSession, tmpAlias);
		if (i === 0)
		{
			tmpFrom.push(`(${tmpRelation}) AS ${tmpAlias}`);
		}
		else
		{
			let tmpConditions = [];
			for (let j = 0; j < tmpTuple.On.length; j++)
			{
				let tmpPair = tmpTuple.On[j];
				let tmpInvolves = (tmpPair.Left.Alias === tmpAlias) || (tmpPair.Right.Alias === tmpAlias);
				let tmpOther = (tmpPair.Left.Alias === tmpAlias) ? tmpPair.Right.Alias : tmpPair.Left.Alias;
				if (tmpInvolves && ((tmpPlaced.indexOf(tmpOther) >= 0) || (tmpOther === tmpAlias)))
				{
					specColumn(pSession, aliasEntity(pSession, tmpPair.Left.Alias), tmpPair.Left.Field, 'Predicate');
					specColumn(pSession, aliasEntity(pSession, tmpPair.Right.Alias), tmpPair.Right.Field, 'Predicate');
					tmpConditions.push(`${qualify(tmpPair.Left.Alias, tmpPair.Left.Field)} = ${qualify(tmpPair.Right.Alias, tmpPair.Right.Field)}`);
				}
			}
			if (tmpConditions.length < 1)
			{
				refuse('ShapeUnsupported:Tuple');
			}
			tmpFrom.push(`INNER JOIN (${tmpRelation}) AS ${tmpAlias} ON ${tmpConditions.join(' AND ')}`);
		}
		tmpPlaced.push(tmpAlias);
	}
	let tmpSQL = `SELECT DISTINCT ${tmpSelect.join(', ')} FROM ${tmpFrom.join(' ')}${(tmpWhereSQL.length > 0) ? ` WHERE ${tmpWhereSQL}` : ''}`;
	return { SQL: tmpSQL, Columns: tmpColumns, Dims: tmpRewritten, Identity: null };
};

// ---------------------------------------------------------------------------------- keys

/**
 * The info of a base column a dimension / measure reads.
 *
 * @param {Record<string, any>} pBase
 * @param {string} pField
 * @return {Record<string, any>}
 */
const baseColumn = (pBase, pField) =>
{
	if ((typeof(pField) !== 'string') || !pBase.Columns.has(pField))
	{
		refuse('ShapeUnsupported:Dimension');
	}
	return pBase.Columns.get(pField);
};

/**
 * A numeric base column (refused for String / DateTime columns).
 *
 * @param {Record<string, any>} pInfo
 */
const requireNumeric = (pInfo) =>
{
	if (NUMERIC_BASE_TYPES.indexOf(pInfo.Base) < 0)
	{
		refuse(`OperatorType:${pInfo.Entity || 'Base'}.${pInfo.Column || 'Value'}`);
	}
};

/**
 * The integer units of a numeric value (half away from zero, = FacetBuckets.units / SQL ROUND).
 *
 * @param {string} pValueSQL
 * @param {string} pFactorBind
 * @return {string}
 */
const unitsSQL = (pValueSQL, pFactorBind) =>
{
	return `if(${pValueSQL} < 0, -floor(-${pValueSQL} * ${pFactorBind} + 0.5), floor(${pValueSQL} * ${pFactorBind} + 0.5))`;
};

/**
 * A per-row key expression of a single-valued dimension over a base column (§63.4).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pDimension - rewritten (Field = the base column)
 * @param {string} pColumnSQL
 * @param {Record<string, any>} pInfo - the base column's type info
 * @param {string} pPrefix - the f* bind prefix ('f', 'fD1', 'fd<i>')
 * @return {string}
 */
const keySQL = (pSession, pDimension, pColumnSQL, pInfo, pPrefix) =>
{
	switch (pDimension.Kind)
	{
		case 'Column':
			if (pInfo.Base === TYPE_DATETIME)
			{
				// Live returns the stored text (SQLite) or a driver Date (PostgreSQL) as a Terms key.
				refuse('ShapeUnsupported:DateTimeKey');
			}
			return pColumnSQL;
		case 'DateBucket':
			{
				if (pInfo.Base !== TYPE_DATETIME)
				{
					refuse(`OperatorType:${pInfo.Entity || 'Base'}.${pInfo.Column || 'Value'}`);
				}
				if (!hasOwn(DATE_BUCKETS, pDimension.Interval))
				{
					refuse('ShapeUnsupported:Interval');
				}
				return `formatDateTime(${DATE_BUCKETS[pDimension.Interval]}(${pColumnSQL}), ${KEY_FORMAT})`;
			}
		case 'Range':
			{
				requireNumeric(pInfo);
				let tmpRanges = Array.isArray(pDimension.Ranges) ? pDimension.Ranges : [];
				if (tmpRanges.length < 1)
				{
					refuse('ShapeUnsupported:Range');
				}
				let tmpParts = [ `isNull(${pColumnSQL})`, '-1' ];
				for (let i = 0; i < tmpRanges.length; i++)
				{
					let tmpConditions = [];
					if ((tmpRanges[i].From !== null) && (typeof(tmpRanges[i].From) !== 'undefined'))
					{
						tmpConditions.push(`${pColumnSQL} >= ${bind(pSession, `${pPrefix}R${i}From`, numberValue(tmpRanges[i].From), TYPE_FLOAT64)}`);
					}
					if ((tmpRanges[i].To !== null) && (typeof(tmpRanges[i].To) !== 'undefined'))
					{
						tmpConditions.push(`${pColumnSQL} < ${bind(pSession, `${pPrefix}R${i}To`, numberValue(tmpRanges[i].To), TYPE_FLOAT64)}`);
					}
					tmpParts.push((tmpConditions.length > 0) ? tmpConditions.join(' AND ') : '1', String(i));
				}
				tmpParts.push('-2');
				return `multiIf(${tmpParts.join(', ')})`;
			}
		case 'NumericBucket':
			{
				requireNumeric(pInfo);
				if ((pDimension.Mode !== 'Edges') || !Array.isArray(pDimension.Edges) || (pDimension.Edges.length < 2))
				{
					refuse('ShapeUnsupported:NumericBucket');
				}
				return edgesSQL(pSession, pColumnSQL, pDimension.Edges, !!pDimension.OpenEnded, pPrefix);
			}
		case 'ChildAgg':
			{
				let tmpEdges = Array.isArray(pDimension.Edges) ? pDimension.Edges : [];
				if ((tmpEdges.length < 1) || !tmpEdges.every((pEdge) => { return Number.isSafeInteger(pEdge); }))
				{
					refuse('ShapeUnsupported:ChildAgg');
				}
				let tmpParts = [];
				for (let i = 0; i < tmpEdges.length; i++)
				{
					tmpParts.push(`${pColumnSQL} < ${bind(pSession, `${pPrefix}E${i}`, tmpEdges[i], TYPE_INT64)}`, String(i));
				}
				tmpParts.push(String(tmpEdges.length));
				return `multiIf(${tmpParts.join(', ')})`;
			}
		case 'ExistsFlag':
			return pColumnSQL;
		default:
			return refuse(`KindUnsupported:${String(pDimension.Kind)}`);
	}
};

/**
 * A finite number for a numeric bind (geometry, edges, ranges).
 *
 * @param {any} pValue
 * @return {number}
 */
const numberValue = (pValue) =>
{
	let tmpNumber = (typeof(pValue) === 'number') ? pValue : Number(pValue);
	if (!Number.isFinite(tmpNumber))
	{
		refuse('ShapeUnsupported:Number');
	}
	return tmpNumber;
};

/**
 * Explicit-edges bucket index: i for Edges[i] <= v < Edges[i+1]; the open bucket v >= Edges[last];
 * NULL otherwise.
 *
 * @param {Record<string, any>} pSession
 * @param {string} pColumnSQL
 * @param {Array<number>} pEdges
 * @param {boolean} pOpenEnded
 * @param {string} pPrefix
 * @return {string}
 */
const edgesSQL = (pSession, pColumnSQL, pEdges, pOpenEnded, pPrefix) =>
{
	let tmpNames = pEdges.map((pEdge, pIndex) => { return bind(pSession, `${pPrefix}E${pIndex}`, numberValue(pEdge), TYPE_FLOAT64); });
	let tmpParts = [];
	for (let i = 0; i < (tmpNames.length - 1); i++)
	{
		tmpParts.push(`${pColumnSQL} >= ${tmpNames[i]} AND ${pColumnSQL} < ${tmpNames[i + 1]}`, String(i));
	}
	if (pOpenEnded)
	{
		tmpParts.push(`${pColumnSQL} >= ${tmpNames[tmpNames.length - 1]}`, String(tmpNames.length - 1));
	}
	tmpParts.push('NULL');
	return `multiIf(${tmpParts.join(', ')})`;
};

// ---------------------------------------------------------------------------------- statements

/**
 * One statement record.
 *
 * @param {Record<string, any>} pSession
 * @param {string} pPurpose
 * @param {string} pSQL
 * @param {number} pMaxRows
 * @return {Record<string, any>}
 */
const statement = (pSession, pPurpose, pSQL, pMaxRows) =>
{
	return (
		{
			Purpose: pPurpose,
			SQL: pSQL,
			Params: Object.assign({}, pSession.Params),
			Types: Object.assign({}, pSession.Types),
			Settings: Object.assign({}, READ_SETTINGS),
			MaxRows: pMaxRows
		});
};

/**
 * The Terms ranking binds (Live's Terms shell: rank within Top + 1, at most max(Top + 1,
 * MaxTermsGroups) rows, plus the selected keys).
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pKeyInfo - the key column's type info
 * @return {{ Filter: string, MaxRows: number }}
 */
const termsRanking = (pSession, pAgg, pKeyInfo) =>
{
	let tmpLimits = pSession.Limits;
	let tmpTop = positive(pAgg.Top, positive(tmpLimits.DefaultTop, libFacetRequest.LIMIT_DEFAULTS.DefaultTop));
	let tmpMaxGroups = Math.max(tmpTop + 1, positive(tmpLimits.MaxTermsGroups, 10000));
	let tmpTopBind = bind(pSession, 'fTopPlusOne', tmpTop + 1, 'UInt32');
	let tmpMaxBind = bind(pSession, 'fMaxGroups', tmpMaxGroups, 'UInt32');
	let tmpSelected = [];
	let tmpRaw = Array.isArray(pAgg.SelectedKeys) ? pAgg.SelectedKeys : [];
	for (let i = 0; i < tmpRaw.length; i++)
	{
		let tmpKey = tmpRaw[i];
		switch (pKeyInfo.Base)
		{
			case TYPE_STRING:
				if (typeof(tmpKey) === 'string')
				{
					tmpSelected.push(tmpKey);
				}
				break;
			case TYPE_INT64:
			case TYPE_UINT64:
			case TYPE_UINT8:
				{
					let tmpNumber = libFacetBuckets.normalizeKey(tmpKey, 'Numeric');
					if ((typeof(tmpNumber) === 'number') && Number.isSafeInteger(tmpNumber) && ((pKeyInfo.Base === TYPE_INT64) || (tmpNumber >= 0)))
					{
						tmpSelected.push(tmpNumber);
					}
				}
				break;
			case TYPE_FLOAT64:
				{
					let tmpNumber = libFacetBuckets.normalizeKey(tmpKey, 'Decimal');
					if ((typeof(tmpNumber) === 'number') && Number.isFinite(tmpNumber))
					{
						tmpSelected.push(tmpNumber);
					}
				}
				break;
			default:
				break;
		}
	}
	tmpSelected = Array.from(new Set(tmpSelected));
	let tmpFilter = `(FacetRank <= ${tmpTopBind} AND FacetRow <= ${tmpMaxBind})`;
	if (tmpSelected.length > 0)
	{
		tmpFilter += ` OR ${inList(pSession, 'Key', 'fSelected', tmpSelected, pKeyInfo.Base)}`;
	}
	return { Filter: tmpFilter, MaxRows: tmpMaxGroups + tmpSelected.length };
};

/**
 * The base of an Agg for one statement (entity or tuple), with the session's needs set.
 *
 * @param {Record<string, any>} pSession
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pVariant
 * @param {boolean} pWithDimensions - false for K9 (the chain joins in the statement)
 * @return {Record<string, any>}
 */
const aggBase = (pSession, pAgg, pVariant, pWithDimensions) =>
{
	let tmpPreds = [ (pVariant && pVariant.PathPred) ? pVariant.PathPred : null, pAgg.Where || null ];
	if (isTuple(pAgg))
	{
		return tupleBase(pSession, pAgg, tmpPreds);
	}
	return entityBase(pSession, { Preds: tmpPreds, Dims: pWithDimensions ? (Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : []) : [], Flags: [] });
};

/**
 * Compile one statement of an Agg in a fresh session (exactly the parameters it references).
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pInput
 * @param {Record<string, any>} pNeeds
 * @param {(pSession: Record<string, any>) => Record<string, any>} fBuild
 * @return {Record<string, any>}
 */
const withSession = (pAgg, pInput, pNeeds, fBuild) =>
{
	let tmpSession = newSession(pInput);
	tmpSession.Needs = pNeeds;
	return fBuild(tmpSession);
};

/**
 * The single key dimension of a bucketed Agg over its base.
 *
 * @param {Record<string, any>} pBase
 * @return {{ Dimension: Record<string, any>, Info: Record<string, any>, SQL: string }}
 */
const firstKey = (pBase) =>
{
	let tmpDimension = pBase.Dims[0];
	if (!tmpDimension || (typeof(tmpDimension.Field) !== 'string'))
	{
		refuse('ShapeUnsupported:Dimension');
	}
	let tmpInfo = baseColumn(pBase, tmpDimension.Field);
	return { Dimension: tmpDimension, Info: tmpInfo, SQL: qualify('p', tmpDimension.Field) };
};

/**
 * The measured column of Stats / DistinctCount / Missing / NumericHistogram over its base.
 *
 * @param {Record<string, any>} pBase
 * @param {Record<string, any>} pAgg
 * @return {{ Info: Record<string, any>, SQL: string }}
 */
const measure = (pBase, pAgg) =>
{
	let tmpField = (typeof(pAgg.Field) === 'string') && ([ 'Stats', 'DistinctCount', 'Missing' ].indexOf(pAgg.Kind) >= 0) ? pAgg.Field
		: ((pBase.Dims[0] && (typeof(pBase.Dims[0].Field) === 'string')) ? pBase.Dims[0].Field : null);
	let tmpInfo = baseColumn(pBase, tmpField);
	return { Info: tmpInfo, SQL: qualify('p', tmpField) };
};

/**
 * Every statement of an Agg (§63.5 row shapes).
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pInput
 * @return {{ Statements: Array<Record<string, any>>, Fold: string }}
 */
const aggStatements = (pAgg, pInput) =>
{
	if (!pAgg || (typeof(pAgg) !== 'object') || (typeof(pAgg.Kind) !== 'string'))
	{
		refuse('ShapeUnsupported:Agg');
	}
	let tmpVariant = (pInput && pInput.Variant) ? pInput.Variant : null;
	let tmpNeeds = collectAgg(pAgg, tmpVariant);
	let tmpLimits = ((pInput && pInput.Limits) || {});
	let fBase = (pSession) => { return aggBase(pSession, pAgg, tmpVariant, !isMulti(pAgg)); };

	if (isMulti(pAgg))
	{
		if (pAgg.Kind !== 'Terms')
		{
			refuse(`KindUnsupported:${pAgg.Kind}`);
		}
		let tmpDimension = pAgg.Dimensions[0];
		let fChain = (pSession, pBase) =>
		{
			let tmpChain = tmpDimension.Chain;
			let tmpScope = [ 'p' ];
			let tmpJoins = [];
			for (let i = 0; i < tmpChain.length; i++)
			{
				let tmpAlias = aliasOf(tmpChain[i].Rel.As);
				let tmpOn = onColumns(pSession, tmpChain[i].On, tmpAlias, tmpScope);
				let tmpConditions = tmpOn.Inner.map((pInner, pIndex) => { return `${pInner} = ${tmpOn.Outer[pIndex]}`; });
				tmpJoins.push(`INNER JOIN (${relationSQL(pSession, tmpAlias)}) AS ${tmpAlias} ON ${tmpConditions.join(' AND ')}`);
				tmpScope.push(tmpAlias);
			}
			let tmpKeyAlias = tmpChain[tmpChain.length - 1].Rel.As;
			let tmpKeyInfo = specColumn(pSession, aliasEntity(pSession, tmpKeyAlias), tmpDimension.KeyField, 'Read');
			if (tmpKeyInfo.Base === TYPE_DATETIME)
			{
				refuse('ShapeUnsupported:DateTimeKey');
			}
			let tmpKey = qualify(tmpKeyAlias, tmpDimension.KeyField);
			let tmpWhere = [ `isNotNull(${tmpKey})` ];
			if (tmpDimension.Where)
			{
				tmpWhere.push(predSQL(pSession, tmpDimension.Where, tmpScope));
			}
			return { From: `(${pBase.SQL}) AS p ${tmpJoins.join(' ')}`, Where: tmpWhere.join(' AND '), Key: tmpKey, KeyInfo: tmpKeyInfo, PK: qualify('p', pBase.Identity) };
		};
		let tmpTerms = withSession(pAgg, pInput, tmpNeeds,
			(pSession) =>
			{
				let tmpBase = fBase(pSession);
				let tmpChain = fChain(pSession, tmpBase);
				let tmpRanking = termsRanking(pSession, Object.assign({}, pAgg), tmpChain.KeyInfo);
				let tmpSQL = 'SELECT Key, Count, FacetDistinct FROM (SELECT Key, Count, count() OVER () AS FacetDistinct,'
					+ ' rank() OVER (ORDER BY Count DESC) AS FacetRank, row_number() OVER (ORDER BY Count DESC, Key ASC) AS FacetRow'
					+ ` FROM (SELECT ${tmpChain.Key} AS Key, uniqExact(${tmpChain.PK}) AS Count FROM ${tmpChain.From} WHERE ${tmpChain.Where} GROUP BY Key))`
					+ ` WHERE ${tmpRanking.Filter} ORDER BY FacetRow`;
				return statement(pSession, 'MultiTerms', tmpSQL, tmpRanking.MaxRows);
			});
		let tmpTotal = withSession(pAgg, pInput, tmpNeeds,
			(pSession) =>
			{
				let tmpBase = fBase(pSession);
				return statement(pSession, 'Count', `SELECT count() AS Total FROM (${tmpBase.SQL}) AS p`, 1);
			});
		let tmpCovered = withSession(pAgg, pInput, tmpNeeds,
			(pSession) =>
			{
				let tmpBase = fBase(pSession);
				let tmpChain = fChain(pSession, tmpBase);
				return statement(pSession, 'MultiCovered', `SELECT uniqExact(${tmpChain.PK}) AS Covered FROM ${tmpChain.From} WHERE ${tmpChain.Where}`, 1);
			});
		return { Statements: [ tmpTerms, tmpTotal, tmpCovered ], Fold: 'Multi' };
	}

	switch (pAgg.Kind)
	{
		case 'Count':
			return (
				{
					Statements: [ withSession(pAgg, pInput, tmpNeeds, (pSession) => { return statement(pSession, 'Count', `SELECT count() AS Total FROM (${fBase(pSession).SQL}) AS p`, 1); }) ],
					Fold: 'Count'
				});

		case 'Terms':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpKey = firstKey(tmpBase);
								if (tmpKey.Dimension.Kind !== 'Column')
								{
									refuse('ShapeUnsupported:Dimension');
								}
								let tmpKeySQL = keySQL(pSession, tmpKey.Dimension, tmpKey.SQL, tmpKey.Info, 'f');
								let tmpRanking = termsRanking(pSession, pAgg, tmpKey.Info);
								let tmpSQL = 'SELECT Key, Count, FacetTotal, FacetMissing, FacetDistinct FROM (SELECT Key, Count,'
									+ ' sum(Count) OVER () AS FacetTotal, sumIf(Count, isNull(Key)) OVER () AS FacetMissing, countIf(isNotNull(Key)) OVER () AS FacetDistinct,'
									+ ' rank() OVER (ORDER BY isNull(Key) ASC, Count DESC) AS FacetRank,'
									+ ' row_number() OVER (ORDER BY isNull(Key) ASC, Count DESC, Key ASC) AS FacetRow'
									+ ` FROM (SELECT ${tmpKeySQL} AS Key, count() AS Count FROM (${tmpBase.SQL}) AS p GROUP BY Key))`
									+ ` WHERE ${tmpRanking.Filter} ORDER BY FacetRow`;
								return statement(pSession, 'Terms', tmpSQL, tmpRanking.MaxRows);
							})
					],
					Fold: 'Terms'
				});

		case 'DateHistogram':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpKey = firstKey(tmpBase);
								if ((tmpKey.Dimension.Kind !== 'DateBucket') || (tmpKey.Info.Base !== TYPE_DATETIME) || !hasOwn(DATE_BUCKETS, tmpKey.Dimension.Interval))
								{
									refuse('ShapeUnsupported:Dimension');
								}
								let tmpMaxGroups = positive(tmpLimits.MaxDateBuckets, libFacetRequest.LIMIT_DEFAULTS.MaxDateBuckets) + 2;
								let tmpMaxBind = bind(pSession, 'fMaxGroups', tmpMaxGroups, 'UInt32');
								let tmpSQL = `SELECT formatDateTime(B, ${KEY_FORMAT}) AS Key, Count, formatDateTime(LoV, ${VALUE_FORMAT}) AS Lo, formatDateTime(HiV, ${VALUE_FORMAT}) AS Hi`
									+ ` FROM (SELECT ${DATE_BUCKETS[tmpKey.Dimension.Interval]}(${tmpKey.SQL}) AS B, count() AS Count, min(${tmpKey.SQL}) AS LoV, max(${tmpKey.SQL}) AS HiV`
									+ ` FROM (${tmpBase.SQL}) AS p GROUP BY B)`
									+ ` ORDER BY isNull(B), B LIMIT ${tmpMaxBind}`;
								return statement(pSession, 'DateHistogram', tmpSQL, tmpMaxGroups);
							})
					],
					Fold: 'DateHistogram'
				});

		case 'NumericHistogram':
			{
				let tmpGeometry = (pInput && pInput.Geometry) ? pInput.Geometry : null;
				let tmpDimension = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions[0] : null;
				if (!tmpDimension || (tmpDimension.Kind !== 'NumericBucket'))
				{
					refuse('ShapeUnsupported:Dimension');
				}
				if (!tmpGeometry)
				{
					return (
						{
							Statements:
							[
								withSession(pAgg, pInput, tmpNeeds,
									(pSession) =>
									{
										let tmpBase = fBase(pSession);
										let tmpMeasure = measure(tmpBase, pAgg);
										requireNumeric(tmpMeasure.Info);
										return statement(pSession, 'NumericBounds',
											`SELECT count() AS Rows, count(${tmpMeasure.SQL}) AS NonNull, min(${tmpMeasure.SQL}) AS Lo, max(${tmpMeasure.SQL}) AS Hi FROM (${tmpBase.SQL}) AS p`, 1);
									})
							],
							Fold: 'NumericBounds'
						});
				}
				return (
					{
						Statements:
						[
							withSession(pAgg, pInput, tmpNeeds,
								(pSession) =>
								{
									let tmpBase = fBase(pSession);
									let tmpMeasure = measure(tmpBase, pAgg);
									requireNumeric(tmpMeasure.Info);
									let tmpValue = tmpMeasure.SQL;
									let tmpIndex;
									let tmpMaxRows;
									if (tmpGeometry.Mode === 'Edges')
									{
										let tmpEdges = Array.isArray(tmpGeometry.Edges) ? tmpGeometry.Edges : [];
										if (tmpEdges.length < 2)
										{
											refuse('ShapeUnsupported:NumericBucket');
										}
										tmpIndex = edgesSQL(pSession, tmpValue, tmpEdges, !!tmpGeometry.OpenEnded, 'f');
										tmpMaxRows = tmpEdges.length + 1;
									}
									else
									{
										if (!(tmpGeometry.WidthUnits > 0) || !(tmpGeometry.N >= 1) || !Number.isSafeInteger(tmpGeometry.LoUnits) || !Number.isSafeInteger(tmpGeometry.WidthUnits) || !Number.isSafeInteger(tmpGeometry.Factor))
										{
											refuse('ShapeUnsupported:Geometry');
										}
										let tmpFactor = bind(pSession, 'fFactor', tmpGeometry.Factor, TYPE_INT64);
										let tmpLo = bind(pSession, 'fLoUnits', tmpGeometry.LoUnits, TYPE_INT64);
										let tmpWidth = bind(pSession, 'fWidthUnits', tmpGeometry.WidthUnits, TYPE_INT64);
										let tmpLast = bind(pSession, 'fLastIndex', tmpGeometry.N - 1, TYPE_INT64);
										let tmpCandidate = `least(intDiv(toInt64(${unitsSQL(tmpValue, tmpFactor)}) - ${tmpLo}, ${tmpWidth}), ${tmpLast})`;
										tmpIndex = `multiIf(${tmpValue} < (${tmpLo} + FacetCand * ${tmpWidth}) / ${tmpFactor}, FacetCand - 1,`
											+ ` FacetCand < ${tmpLast} AND ${tmpValue} >= (${tmpLo} + (FacetCand + 1) * ${tmpWidth}) / ${tmpFactor}, FacetCand + 1, FacetCand)`;
										tmpIndex = `${tmpCandidate} AS FacetCand, ${tmpIndex}`;
										tmpMaxRows = tmpGeometry.N + 1;
									}
									let tmpSQL = `SELECT Key, count() AS Count FROM (SELECT ${tmpIndex} AS Key FROM (${tmpBase.SQL}) AS p WHERE isNotNull(${tmpValue})) GROUP BY Key`;
									return statement(pSession, 'NumericHistogram', tmpSQL, tmpMaxRows);
								})
						],
						Fold: 'NumericHistogram'
					});
			}

		case 'Ranges':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpKey = firstKey(tmpBase);
								if (tmpKey.Dimension.Kind !== 'Range')
								{
									refuse('ShapeUnsupported:Dimension');
								}
								let tmpSQL = `SELECT Key, count() AS Count FROM (SELECT ${keySQL(pSession, tmpKey.Dimension, tmpKey.SQL, tmpKey.Info, 'f')} AS Key FROM (${tmpBase.SQL}) AS p) GROUP BY Key`;
								return statement(pSession, 'Ranges', tmpSQL, tmpKey.Dimension.Ranges.length + 2);
							})
					],
					Fold: 'Ranges'
				});

		case 'Stats':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpMeasure = measure(tmpBase, pAgg);
								let tmpValue = tmpMeasure.SQL;
								let tmpSQL;
								if (tmpMeasure.Info.Base === TYPE_DATETIME)
								{
									tmpSQL = `SELECT count() AS Rows, count(${tmpValue}) AS NonNull, formatDateTime(min(${tmpValue}), ${VALUE_FORMAT}) AS Min, formatDateTime(max(${tmpValue}), ${VALUE_FORMAT}) AS Max, NULL AS SumUnits FROM (${tmpBase.SQL}) AS p`;
								}
								else
								{
									requireNumeric(tmpMeasure.Info);
									let tmpScale = (pAgg.FieldInfo && (typeof(pAgg.FieldInfo.Scale) === 'number')) ? pAgg.FieldInfo.Scale : 0;
									let tmpFactorValue = Math.pow(10, tmpScale);
									let tmpSum = ((tmpMeasure.Info.Base !== TYPE_FLOAT64) && (tmpFactorValue === 1))
										? `sum(${tmpValue})`
										: `sum(toInt64(${unitsSQL(tmpValue, bind(pSession, 'fFactor', tmpFactorValue, TYPE_INT64))}))`;
									tmpSQL = `SELECT count() AS Rows, count(${tmpValue}) AS NonNull, min(${tmpValue}) AS Min, max(${tmpValue}) AS Max, ${tmpSum} AS SumUnits FROM (${tmpBase.SQL}) AS p`;
								}
								return statement(pSession, 'Stats', tmpSQL, 1);
							})
					],
					Fold: 'Stats'
				});

		case 'DistinctCount':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpMeasure = measure(tmpBase, pAgg);
								return statement(pSession, 'DistinctCount',
									`SELECT count() AS Rows, count(${tmpMeasure.SQL}) AS NonNull, uniqExact(${tmpMeasure.SQL}) AS Distinct FROM (${tmpBase.SQL}) AS p`, 1);
							})
					],
					Fold: 'DistinctCount'
				});

		case 'Missing':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpMeasure = measure(tmpBase, pAgg);
								return statement(pSession, 'Missing', `SELECT count() AS Rows, count(${tmpMeasure.SQL}) AS NonNull FROM (${tmpBase.SQL}) AS p`, 1);
							})
					],
					Fold: 'Missing'
				});

		case 'Pivot':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								if (tmpBase.Dims.length !== 2)
								{
									refuse('ShapeUnsupported:Dimension');
								}
								let tmpAxes = tmpBase.Dims.map(
									(pDimension, pIndex) =>
									{
										if ([ 'Column', 'DateBucket', 'Range' ].indexOf(pDimension.Kind) < 0)
										{
											refuse(`KindUnsupported:PivotAxis`);
										}
										return keySQL(pSession, pDimension, qualify('p', pDimension.Field), baseColumn(tmpBase, pDimension.Field), (pIndex === 0) ? 'f' : 'fD1');
									});
								let tmpMaxGroups = positive(tmpLimits.CubeMaxGroups, 100000) + 1;
								let tmpMaxBind = bind(pSession, 'fMaxGroups', tmpMaxGroups, 'UInt32');
								let tmpSQL = `SELECT K1, K2, count() AS Count FROM (SELECT ${tmpAxes[0]} AS K1, ${tmpAxes[1]} AS K2 FROM (${tmpBase.SQL}) AS p) GROUP BY K1, K2 LIMIT ${tmpMaxBind}`;
								return statement(pSession, 'Pivot', tmpSQL, tmpMaxGroups);
							})
					],
					Fold: 'Pivot'
				});

		case 'ChildRollup':
		case 'ExistsSplit':
			return (
				{
					Statements:
					[
						withSession(pAgg, pInput, tmpNeeds,
							(pSession) =>
							{
								let tmpBase = fBase(pSession);
								let tmpKey = firstKey(tmpBase);
								if (tmpKey.Dimension.Kind !== ((pAgg.Kind === 'ChildRollup') ? 'ChildAgg' : 'ExistsFlag'))
								{
									refuse('ShapeUnsupported:Dimension');
								}
								let tmpSQL = `SELECT Key, count() AS Count FROM (SELECT ${keySQL(pSession, tmpKey.Dimension, tmpKey.SQL, tmpKey.Info, 'f')} AS Key FROM (${tmpBase.SQL}) AS p) GROUP BY Key`;
								let tmpMaxRows = (pAgg.Kind === 'ChildRollup') ? (tmpKey.Dimension.Edges.length + 1) : 2;
								return statement(pSession, 'KeyGroups', tmpSQL, tmpMaxRows);
							})
					],
					Fold: 'KeyGroups'
				});

		default:
			return refuse(`KindUnsupported:${pAgg.Kind}`);
	}
};

// ---------------------------------------------------------------------------------- public API

/**
 * FoxHound entries → a WHERE fragment (unqualified columns unless pInput.Qualifier), §63.3.  Also
 * the materializer's filter-resolution entry point (§58.8): pInput may carry only SourceDialect.
 *
 * @param {Record<string, any>} pSpec
 * @param {Array<Record<string, any>>} pEntries
 * @param {Record<string, any>} pInput - { SourceDialect, SourceStringOrder?, Lossy?, Filling?, Prefix? (default 'w'), Qualifier? }
 * @return {Record<string, any>}
 */
const compileFilter = (pSpec, pEntries, pInput) =>
{
	return guarded(
		() =>
		{
			if (!pSpec || (typeof(pSpec.Entity) !== 'string'))
			{
				refuse('ShapeUnsupported:Spec');
			}
			let tmpInput = Object.assign({}, pInput || {});
			let tmpSpecs = Object.assign({}, tmpInput.Specs || {});
			tmpSpecs[pSpec.Entity] = pSpec;
			tmpInput.Specs = tmpSpecs;
			let tmpSession = newSession(tmpInput);
			let tmpPrefix = (typeof(tmpInput.Prefix) === 'string') ? tmpInput.Prefix : 'w';
			if (!/^[a-z][a-z0-9]{0,7}$/.test(tmpPrefix))
			{
				refuse('ShapeUnsupported:Prefix');
			}
			let tmpQualifier = (typeof(tmpInput.Qualifier) === 'string') ? aliasOf(tmpInput.Qualifier) : null;
			let tmpSQL = compileEntries(tmpSession, pSpec, pEntries, { Prefix: tmpPrefix, Qualifier: tmpQualifier });
			return { SQL: (tmpSQL.length > 0) ? tmpSQL : '1', Params: tmpSession.Params, Types: tmpSession.Types };
		});
};

/**
 * A Rel → '(SELECT … FINAL WHERE …) AS <As>' over pInput.Relations[As] (its captured filter), with
 * the Rel's Project as the projection (the identity first).
 *
 * @param {Record<string, any>} pRel
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const compileRelation = (pRel, pInput) =>
{
	return guarded(
		() =>
		{
			if (!pRel || (typeof(pRel.As) !== 'string'))
			{
				refuse('ShapeUnsupported:Relation');
			}
			let tmpSession = newSession(pInput);
			let tmpAlias = aliasOf(pRel.As);
			let tmpSQL = relationSQL(tmpSession, tmpAlias, Array.isArray(pRel.Project) ? pRel.Project : []);
			return { SQL: `(${tmpSQL}) AS ${tmpAlias}`, Params: tmpSession.Params, Types: tmpSession.Types };
		});
};

/**
 * A FoldPred → a boolean expression in scope pInput.Scope (default [ 'p' ]).
 *
 * @param {Record<string, any>} pPred
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const compileFoldPred = (pPred, pInput) =>
{
	return guarded(
		() =>
		{
			let tmpSession = newSession(pInput);
			let tmpNeeds = newNeeds();
			collectPred(tmpNeeds, pPred);
			tmpSession.Needs = tmpNeeds;
			let tmpScope = (pInput && Array.isArray(pInput.Scope)) ? pInput.Scope : [ 'p' ];
			let tmpSQL = pPred ? predSQL(tmpSession, pPred, tmpScope) : '1';
			return { SQL: tmpSQL, Params: tmpSession.Params, Types: tmpSession.Types };
		});
};

/**
 * A per-row key expression of a dimension over a column SQL (pInput.ColumnInfo: { Base | Mirror,
 * Entity, Column } of that column; pInput.Prefix: the f* bind prefix, default 'f').
 *
 * @param {Record<string, any>} pDimension
 * @param {string} pColumnSQL
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const dimensionExpression = (pDimension, pColumnSQL, pInput) =>
{
	return guarded(
		() =>
		{
			let tmpSession = newSession(pInput);
			let tmpInfo = Object.assign({}, (pInput && pInput.ColumnInfo) || {});
			if (typeof(tmpInfo.Base) !== 'string')
			{
				tmpInfo.Base = libTypeMap.paramType(tmpInfo.Mirror);
			}
			if (!pDimension || (typeof(pColumnSQL) !== 'string'))
			{
				refuse('ShapeUnsupported:Dimension');
			}
			let tmpPrefix = (pInput && (typeof(pInput.Prefix) === 'string')) ? pInput.Prefix : 'f';
			if (!/^f[A-Za-z0-9]*$/.test(tmpPrefix))
			{
				refuse('ShapeUnsupported:Prefix');
			}
			let tmpSQL = keySQL(tmpSession, pDimension, pColumnSQL, tmpInfo, tmpPrefix);
			return { SQL: tmpSQL, Params: tmpSession.Params, Types: tmpSession.Types };
		});
};

/**
 * Compile one Agg (§63.5).  NumericHistogram is two-phase exactly as Live: without pInput.Geometry the
 * NumericBounds statement, with it the bucket statement.
 *
 * pInput: { Database, Specs, Relations: { As: { Entity, Filter, Capture } }, Variant: { PathPred },
 *           Fragments: { Entity: { <entry signature>: <operator> } }, Lossy, Filling, SourceDialect,
 *           SourceStringOrder, Limits, Geometry }
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const compileAgg = (pAgg, pInput) =>
{
	return guarded(() => { return aggStatements(pAgg, pInput); });
};

/**
 * The grain statement of a conditional disjunctive scan (§63.6) for CubeExecutor.marginalize.
 *
 * pCubePlan: the CubePlan (§25.2) resolved by the engine — { CubeId, Pivot, Dims, Measures, MaxGroups,
 *   Resolved: { CommonPathPred, Flags: [ { Column, ColumnPred } | { Column, Pred } ], Bounds: <CubeExecutor.boundsSpec> } };
 *   pInput.Relations.p is the Common relation's capture.
 *
 * @param {Record<string, any>} pCubePlan
 * @param {Array<Record<string, any>>} pMemberAggs
 * @param {Record<string, any>} pInput
 * @return {Record<string, any>}
 */
const compileCube = (pCubePlan, pMemberAggs, pInput) =>
{
	return guarded(
		() =>
		{
			if (!pCubePlan || !Array.isArray(pCubePlan.Dims) || !pCubePlan.Resolved)
			{
				refuse('ShapeUnsupported:Cube');
			}
			let tmpResolved = pCubePlan.Resolved;
			let tmpFlags = Array.isArray(tmpResolved.Flags) ? tmpResolved.Flags : [];
			let tmpBounds = Array.isArray(tmpResolved.Bounds) ? tmpResolved.Bounds : [];
			let tmpMeasures = Array.isArray(pCubePlan.Measures) ? pCubePlan.Measures : [];
			let tmpNeeds = newNeeds();
			collectPred(tmpNeeds, tmpResolved.CommonPathPred || null);
			tmpFlags.forEach((pFlag) => { if (pFlag.Pred) { collectPred(tmpNeeds, pFlag.Pred); } else { collectColumnPred(tmpNeeds, 'p', pFlag.ColumnPred); } });
			pCubePlan.Dims.forEach((pDim) => { collectDimension(tmpNeeds, pDim.Dim); });
			tmpMeasures.forEach((pMeasure) => { need(tmpNeeds, 'p', pMeasure.Field); });
			let tmpSession = newSession(pInput);
			tmpSession.Needs = tmpNeeds;
			let tmpBase = entityBase(tmpSession, { Preds: [ tmpResolved.CommonPathPred || null ], Dims: pCubePlan.Dims.map((pDim) => { return pDim.Dim; }), Flags: tmpFlags });
			let tmpRow = [];
			let tmpGroup = [];
			let tmpGrouped = [];
			for (let i = 0; i < pCubePlan.Dims.length; i++)
			{
				let tmpColumn = pCubePlan.Dims[i].Column;
				if (!/^d[0-9]+$/.test(String(tmpColumn)))
				{
					refuse('ShapeUnsupported:Cube');
				}
				let tmpDimension = tmpBase.Dims[i];
				let tmpExpression = keySQL(tmpSession, tmpDimension, qualify('p', tmpDimension.Field), baseColumn(tmpBase, tmpDimension.Field), `fd${i}`);
				tmpRow.push(`${tmpExpression} AS ${quote(tmpColumn)}`);
				tmpGroup.push(quote(tmpColumn));
				tmpGrouped.push(quote(tmpColumn));
			}
			for (let i = 0; i < tmpFlags.length; i++)
			{
				tmpRow.push(`${qualify('p', tmpFlags[i].Column)} AS ${quote(tmpFlags[i].Column)}`);
				tmpGroup.push(quote(tmpFlags[i].Column));
				tmpGrouped.push(quote(tmpFlags[i].Column));
			}
			for (let i = 0; i < tmpBounds.length; i++)
			{
				let tmpBound = tmpBounds[i];
				let tmpIndex = pCubePlan.Dims.findIndex((pDim) => { return pDim.Column === tmpBound.Dim; });
				if (tmpIndex < 0)
				{
					refuse('ShapeUnsupported:Cube');
				}
				let tmpDimension = tmpBase.Dims[tmpIndex];
				let tmpInfo = baseColumn(tmpBase, tmpDimension.Field);
				let tmpValue = quote(tmpBound.Column);
				tmpRow.push(`${qualify('p', tmpDimension.Field)} AS ${tmpValue}`);
				if (tmpBound.Kind === 'Date')
				{
					if (tmpInfo.Base !== TYPE_DATETIME)
					{
						refuse('ShapeUnsupported:Cube');
					}
					tmpGroup.push(`formatDateTime(min(${tmpValue}), ${VALUE_FORMAT}) AS ${quote(tmpBound.Lo)}`, `formatDateTime(max(${tmpValue}), ${VALUE_FORMAT}) AS ${quote(tmpBound.Hi)}`);
				}
				else
				{
					requireNumeric(tmpInfo);
					tmpGroup.push(`min(${tmpValue}) AS ${quote(tmpBound.Lo)}`, `max(${tmpValue}) AS ${quote(tmpBound.Hi)}`, `count(${tmpValue}) AS ${quote(tmpBound.NonNull)}`);
				}
			}
			for (let i = 0; i < tmpMeasures.length; i++)
			{
				let tmpMeasure = tmpMeasures[i];
				if ((typeof(tmpMeasure.Column) !== 'string') || !/^m[0-9]+$/.test(tmpMeasure.Column) || (typeof(tmpMeasure.Field) !== 'string'))
				{
					refuse('ShapeUnsupported:Cube');
				}
				let tmpInfo = baseColumn(tmpBase, tmpMeasure.Field);
				let tmpValue = quote(tmpMeasure.Column);
				tmpRow.push(`${qualify('p', tmpMeasure.Field)} AS ${tmpValue}`);
				tmpGroup.push(`count(${tmpValue}) AS ${quote(`${tmpMeasure.Column}nn`)}`);
				if (tmpMeasure.Kind === 'Stats')
				{
					if (tmpInfo.Base === TYPE_DATETIME)
					{
						tmpGroup.push(`formatDateTime(min(${tmpValue}), ${VALUE_FORMAT}) AS ${quote(`${tmpMeasure.Column}lo`)}`, `formatDateTime(max(${tmpValue}), ${VALUE_FORMAT}) AS ${quote(`${tmpMeasure.Column}hi`)}`);
					}
					else
					{
						requireNumeric(tmpInfo);
						let tmpFactorValue = Math.pow(10, (typeof(tmpMeasure.Scale) === 'number') ? tmpMeasure.Scale : 0);
						let tmpSum = ((tmpInfo.Base !== TYPE_FLOAT64) && (tmpFactorValue === 1))
							? `sum(${tmpValue})`
							: `sum(toInt64(${unitsSQL(tmpValue, bind(tmpSession, `f${tmpMeasure.Column}Factor`, tmpFactorValue, TYPE_INT64))}))`;
						tmpGroup.push(`min(${tmpValue}) AS ${quote(`${tmpMeasure.Column}lo`)}`, `max(${tmpValue}) AS ${quote(`${tmpMeasure.Column}hi`)}`, `${tmpSum} AS ${quote(`${tmpMeasure.Column}su`)}`);
					}
				}
			}
			tmpRow.push('0 AS `z`');
			tmpGrouped.push('`z`');
			let tmpMaxGroups = positive(pCubePlan.MaxGroups, positive((pInput && pInput.Limits) ? pInput.Limits.CubeMaxGroups : null, 100000));
			let tmpMaxBind = bind(tmpSession, 'fMaxGroups', tmpMaxGroups + 1, 'UInt32');
			let tmpSQL = `SELECT ${tmpGroup.join(', ')}, count() AS \`N\` FROM (SELECT ${tmpRow.join(', ')} FROM (${tmpBase.SQL}) AS p) GROUP BY ${tmpGrouped.join(', ')} LIMIT ${tmpMaxBind}`;
			return { Statement: statement(tmpSession, 'Cube', tmpSQL, tmpMaxGroups + 1), Fold: 'CubeGrain' };
		});
};

/**
 * Every relation an Agg reads (for the engine's captures and fragment probes): the pivot alias 'p'
 * (Rel null for an entity pivot: the engine builds it from the Variant), every hop / lookup / chain /
 * child / tuple side with the columns read on it, and the column leaves rendered as fragments.
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>|null} pVariant - { PathPred }
 * @return {{ Relations: Array<{ Alias: string, Entity: string|null, Rel: Record<string, any>|null, Columns: Array<string> }>, Leaves: Record<string, Array<Record<string, any>>> } | { Refused: string }}
 */
const collectRelations = (pAgg, pVariant) =>
{
	return guarded(
		() =>
		{
			let tmpNeeds = collectAgg(pAgg, pVariant);
			let tmpRelations = [];
			if (!isTuple(pAgg))
			{
				tmpRelations.push({ Alias: 'p', Entity: pAgg.Pivot, Rel: null, Columns: tmpNeeds.Columns.has('p') ? Array.from(tmpNeeds.Columns.get('p')).sort() : [] });
			}
			tmpNeeds.Rels.forEach(
				(pRel, pAlias) =>
				{
					tmpRelations.push({ Alias: pAlias, Entity: pRel.Entity, Rel: pRel, Columns: tmpNeeds.Columns.has(pAlias) ? Array.from(tmpNeeds.Columns.get(pAlias)).sort() : [] });
				});
			let tmpLeaves = {};
			tmpNeeds.Leaves.forEach((pLeaves, pAlias) => { tmpLeaves[pAlias] = pLeaves.slice(); });
			return { Relations: tmpRelations, Leaves: tmpLeaves };
		});
};

/**
 * The cube's relations (its Common pivot 'p' and every hop of its flags / dimensions / common path
 * predicate) and fragment leaves, for the engine's captures and probes.
 *
 * @param {Record<string, any>} pCubePlan - with Resolved (compileCube)
 * @return {Record<string, any>}
 */
const collectCubeRelations = (pCubePlan) =>
{
	return guarded(
		() =>
		{
			let tmpResolved = pCubePlan.Resolved || {};
			let tmpNeeds = newNeeds();
			collectPred(tmpNeeds, tmpResolved.CommonPathPred || null);
			(Array.isArray(tmpResolved.Flags) ? tmpResolved.Flags : []).forEach((pFlag) => { if (pFlag.Pred) { collectPred(tmpNeeds, pFlag.Pred); } else { collectColumnPred(tmpNeeds, 'p', pFlag.ColumnPred); } });
			(Array.isArray(pCubePlan.Dims) ? pCubePlan.Dims : []).forEach((pDim) => { collectDimension(tmpNeeds, pDim.Dim); });
			(Array.isArray(pCubePlan.Measures) ? pCubePlan.Measures : []).forEach((pMeasure) => { need(tmpNeeds, 'p', pMeasure.Field); });
			let tmpRelations = [ { Alias: 'p', Entity: pCubePlan.Pivot, Rel: null, Columns: tmpNeeds.Columns.has('p') ? Array.from(tmpNeeds.Columns.get('p')).sort() : [] } ];
			tmpNeeds.Rels.forEach(
				(pRel, pAlias) =>
				{
					tmpRelations.push({ Alias: pAlias, Entity: pRel.Entity, Rel: pRel, Columns: tmpNeeds.Columns.has(pAlias) ? Array.from(tmpNeeds.Columns.get(pAlias)).sort() : [] });
				});
			let tmpLeaves = {};
			tmpNeeds.Leaves.forEach((pLeaves, pAlias) => { tmpLeaves[pAlias] = pLeaves.slice(); });
			return { Relations: tmpRelations, Leaves: tmpLeaves };
		});
};

module.exports = (
	{
		COMPILER_VERSION: COMPILER_VERSION,
		OPERATOR_MAP: OPERATOR_MAP,
		READ_SETTINGS: READ_SETTINGS,
		REASON_CLASSES: REASON_CLASSES,
		MAX_PARAM_TEXT: MAX_PARAM_TEXT,
		DATE_BUCKETS: DATE_BUCKETS,
		paramName: paramName,
		compileFilter: compileFilter,
		compileRelation: compileRelation,
		compileFoldPred: compileFoldPred,
		dimensionExpression: dimensionExpression,
		compileAgg: compileAgg,
		compileCube: compileCube,
		collectRelations: collectRelations,
		collectCubeRelations: collectCubeRelations,
		entrySignature: entrySignature,
		columnPredEntries: columnPredEntries
	});
