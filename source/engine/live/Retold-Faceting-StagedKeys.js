/**
 * Retold Faceting - Staged Keys (Live)
 *
 * The Staged form of a hop (03 §3.3): run the hop's own complete, scoped query once, capped at
 * Limits.MaxStagedKeys + 1, collect the distinct correlation keys, and bind the WHOLE key set as ONE
 * scalar parameter per dialect form so the outer statement scans once — never a JS array, never one
 * statement per chunk:
 *
 *   SQLite      "p"."c" IN (SELECT "v"."value" FROM json_each(:<a>_Keys) AS "v")      composite: json_each + json_extract
 *   PostgreSQL  "p"."c" = ANY(CAST(:<a>_K0 AS bigint[]))                                composite: unnest(CAST(:<a>_K0 …), CAST(:<a>_K1 …))
 *   MySQL 8     JSON_TABLE(:<a>_Keys, '$[*]' COLUMNS (…))                              (dry-built only in M2)
 *   MSSQL 2016+ OPENJSON(@<a>_Keys) WITH (…)                                           (dry-built only in M2)
 *
 * An anti-join (NotExists) renders NOT EXISTS over the key set, so a NULL outer column means "no
 * visible match" exactly like the fused NOT EXISTS (never NOT IN).
 *
 * Which hops run Staged (internal-contracts §26.3): a Rel with Stage 'Allowed' (a leaf existence
 * hop, integer inner On columns) whose capture is Opaque and whose entity is in
 * Scope.TrustedOpaque ('Auto'), or every such Rel (PlanForm.Staged 'Always', the O5 tests).  The
 * key query is the hop's own scoped relation — the SAME Scoped Relation the fused form embeds
 * (fence, Where, soft delete, behaviors, ScopeGuard) — wrapped in SELECT DISTINCT; a trusted Opaque
 * capture whose behavior replaced the query runs as the behavior built it, after asserting its
 * rendered SQL names every required policy column and its binds hold the principal's values.
 *
 * Over Limits.MaxStagedKeys → 422 FACET_PATH_TOO_BROAD.  Keys are integers only; any other value is
 * FACET_INTERNAL (never silently dropped).
 *
 * Contract: internal-contracts §26.3.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetUtil = require('../../contract/Facet-Contract-Util.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');
const libScopeGuard = require('../../security/Retold-Faceting-ScopeGuard.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;

/**
 * Compare two key tuples (numbers, element by element).
 *
 * @param {Array<number>} pA
 * @param {Array<number>} pB
 * @return {number}
 */
const compareTuples = (pA, pB) =>
{
	for (let i = 0; i < pA.length; i++)
	{
		if (pA[i] !== pB[i])
		{
			return (pA[i] < pB[i]) ? -1 : 1;
		}
	}
	return 0;
};

/**
 * A driver value as a safe integer, or null when it is not one.
 *
 * @param {any} pValue
 * @return {number|null}
 */
const integerKey = (pValue) =>
{
	if (typeof(pValue) === 'bigint')
	{
		return Number.isSafeInteger(Number(pValue)) ? Number(pValue) : null;
	}
	let tmpNumber = (typeof(pValue) === 'number') ? pValue : ((typeof(pValue) === 'string') ? libFacetUtil.toFiniteNumber(pValue.trim()) : null);
	return ((tmpNumber !== null) && Number.isSafeInteger(tmpNumber)) ? tmpNumber : null;
};

class RetoldFacetingStagedKeys extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingStagedKeys';
	}

	/**
	 * Materialize the key set of a staged Rel (memoized per request in pContext.Memo.Staged by the
	 * relation key and key columns; the alias only names the binds of the returned view).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel - FoldIR Rel (internal-contracts §24.1); its Project holds the key columns
	 * @param {Array<string>} pKeyColumns - the Rel's inner correlation columns, in On order
	 * @param {(pError?: Error, pStaged?: Record<string, any>) => void} fCallback - StagedRelation (internal-contracts §26.3)
	 */
	stage(pContext, pRel, pKeyColumns, fCallback)
	{
		let tmpContext = pContext || {};
		if (!Array.isArray(pKeyColumns) || (pKeyColumns.length < 1))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A staged hop needs its key columns.'));
		}
		let tmpBuilder = this.fable.RetoldFacetingScopedRelationBuilder;
		if (!tmpBuilder)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The live engine services are not registered.'));
		}
		if (!tmpContext.Memo)
		{
			tmpContext.Memo = { Relations: {}, Captures: {}, VariantRows: {} };
		}
		if (!tmpContext.Memo.Staged)
		{
			tmpContext.Memo.Staged = {};
		}
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}
		let tmpMemoKey = `${tmpBuilder.relationKey(pRel)}|${pKeyColumns.join(',')}`;
		if (hasOwn(tmpContext.Memo.Staged, tmpMemoKey))
		{
			return fCallback(null, this.view(tmpContext.Memo.Staged[tmpMemoKey], pRel.As));
		}
		for (let i = 0; i < pKeyColumns.length; i++)
		{
			if (!Array.isArray(pRel.Project) || (pRel.Project.indexOf(pKeyColumns[i]) < 0))
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A staged key column is not projected.'));
			}
		}

		tmpBuilder.buildRelation(tmpContext, pRel,
			(pError, pRelation) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let fCollected = (pCollectError, pRows) =>
				{
					if (pCollectError)
					{
						return fCallback(pCollectError);
					}
					let tmpStaged;
					try
					{
						tmpStaged = this._keySet(tmpContext, pRel, pRelation, pKeyColumns, pRows);
					}
					catch (pKeyError)
					{
						return fCallback(libFacetErrors.isFacetError(pKeyError) ? pKeyError : libFacetErrors.create('FACET_INTERNAL'));
					}
					tmpContext.Memo.Staged[tmpMemoKey] = tmpStaged;
					tmpContext.Counters.StagedKeys = (tmpContext.Counters.StagedKeys || 0) + tmpStaged.Count;
					tmpContext.Counters.StagedRelations = (tmpContext.Counters.StagedRelations || 0) + 1;
					return fCallback(null, this.view(tmpStaged, pRel.As));
				};
				if (pRelation.NeedsStage)
				{
					return this._readCaptured(tmpContext, pRel, pRelation, pKeyColumns, fCollected);
				}
				return this._readRelation(tmpContext, pRel, pRelation, pKeyColumns, fCollected);
			});
	}

	/**
	 * The maximum number of keys a staged set may hold.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {number}
	 */
	maxKeys(pContext)
	{
		let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
		let tmpMax = (tmpOptions.Limits && (typeof(tmpOptions.Limits.MaxStagedKeys) === 'number')) ? tmpOptions.Limits.MaxStagedKeys : 50000;
		return Math.max(1, Math.floor(tmpMax));
	}

	/**
	 * A per-alias view of a staged key set (the bind names depend on the alias).
	 *
	 * @param {Record<string, any>} pStaged
	 * @param {string} pAlias
	 * @return {Record<string, any>}
	 */
	view(pStaged, pAlias)
	{
		let tmpModule = this.fable.RetoldFacetingShellTemplates.dialect(pStaged.Dialect);
		let tmpNames = tmpModule.Expressions.stagedBindNames(pAlias, pStaged.Columns.length);
		let tmpValues = tmpModule.Expressions.stagedBindValues(pStaged.Keys, pStaged.Columns.length);
		let tmpParams = {};
		let tmpParamTypes = {};
		for (let i = 0; i < tmpNames.length; i++)
		{
			tmpParams[tmpNames[i]] = tmpValues[i];
			if (pStaged.Dialect === 'MSSQL')
			{
				tmpParamTypes[tmpNames[i]] = 'NVarChar';
			}
		}
		return Object.assign({}, pStaged, { Alias: pAlias, BindDialect: pStaged.Dialect, BindNames: tmpNames, Params: tmpParams, ParamTypes: tmpParamTypes });
	}

	/**
	 * Run SELECT DISTINCT <keys> over the hop's built Scoped Relation (one past the cap).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>} pRelation - a built (harvested) relation
	 * @param {Array<string>} pKeyColumns
	 * @param {(pError?: Error, pRows?: Array<Array<any>>) => void} fCallback
	 */
	_readRelation(pContext, pRel, pRelation, pKeyColumns, fCallback)
	{
		let tmpShells = this.fable.RetoldFacetingShellTemplates;
		let tmpDAL = pContext.Host.getExecutionDAL(pRel.Entity);
		let tmpQuery;
		try
		{
			let tmpShell = tmpShells.render(pRelation.Dialect, { Kind: 'Count', Key: `#Staged:${pRel.As}`, Dimensions: [] }, { Shell: 'StagedKeys', SR0: pRelation.SQL, KeyColumns: pKeyColumns, Cap: this.maxKeys(pContext) });
			tmpQuery = tmpDAL.query;
			tmpQuery.setDisableDeleteTracking(true);
			Object.assign(tmpQuery.query.parameters, pRelation.Params);
			this.fable.RetoldFacetingDialects.mergeParameterTypes(tmpQuery, pRelation.ParamTypes || {});
			tmpShells.applyToQuery(tmpQuery, tmpShell);
		}
		catch (pComposeError)
		{
			this.fable.log.error(`RetoldFaceting could not compose the staged key query for ${pRel.Entity}: ${pComposeError.message}`);
			return fCallback(libFacetErrors.isFacetError(pComposeError) ? pComposeError : libFacetErrors.create('FACET_INTERNAL'));
		}
		return this._read(pContext, tmpDAL, tmpQuery, pRel.Entity,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, pRows.map((pRow) => { return pKeyColumns.map((pColumn, pIndex) => { return pRow[`K${pIndex}`]; }); }));
			});
	}

	/**
	 * A trusted Opaque capture: run the behavior-built query.  When the behavior replaced the query
	 * (queryOverride / queryBranches), first assert its rendered SQL names every required policy
	 * column and its binds hold the principal's values (else 500); otherwise the captured filter was
	 * already guarded and the query reads the key columns as a DISTINCT Lite projection.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>} pRelation - NeedsStage relation (Query, Capture)
	 * @param {Array<string>} pKeyColumns
	 * @param {(pError?: Error, pRows?: Array<Array<any>>) => void} fCallback
	 */
	_readCaptured(pContext, pRel, pRelation, pKeyColumns, fCallback)
	{
		let tmpQuery = pRelation.Query;
		let tmpDAL = pContext.Host.getExecutionDAL(pRel.Entity);
		let tmpCapture = pRelation.Capture || {};
		try
		{
			if (!tmpCapture.Replaced)
			{
				tmpQuery.setDataElements(pKeyColumns.slice());
				tmpQuery.setDistinct(true);
			}
			tmpQuery.setBegin(0);
			tmpQuery.setCap(this.maxKeys(pContext) + 1);
			tmpQuery.setDialect(pRelation.Dialect).buildReadQuery();
			if (tmpCapture.Replaced)
			{
				this.assertRenderedPolicy(pContext, pRel.Entity, tmpQuery);
			}
		}
		catch (pBuildError)
		{
			if (!libFacetErrors.isFacetError(pBuildError))
			{
				this.fable.log.error(`RetoldFaceting could not build the opaque staged query for ${pRel.Entity}: ${pBuildError.message}`);
			}
			return fCallback(libFacetErrors.isFacetError(pBuildError) ? pBuildError : libFacetErrors.create('FACET_INTERNAL'));
		}
		return this._read(pContext, tmpDAL, tmpQuery, pRel.Entity,
			(pError, pRows) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				for (let i = 0; i < pRows.length; i++)
				{
					for (let j = 0; j < pKeyColumns.length; j++)
					{
						if (!hasOwn(pRows[i], pKeyColumns[j]))
						{
							this.fable.log.error(`RetoldFaceting: the opaque staged query for ${pRel.Entity} did not return the key column ${pKeyColumns[j]}.`);
							return fCallback(libFacetErrors.create('FACET_INTERNAL'));
						}
					}
				}
				return fCallback(null, pRows.map((pRow) => { return pKeyColumns.map((pColumn) => { return pRow[pColumn]; }); }));
			});
	}

	/**
	 * The rendered-SQL assertion of a behavior-replaced (trusted Opaque) query (§26.3).  The filter
	 * itself was already asserted by ScopeGuard (every required policy column at depth 0, '=' AND,
	 * the principal's value, no depth-0 OR); this checks that the behavior's template really renders
	 * that filter, and nothing that could widen it:
	 *   - the replacement is a queryOverride template (a queryBranches replacement cannot be checked);
	 *   - the template renders '<%= Where %>' exactly once, holds no UNION anywhere and no OR after
	 *     the Where (an OR there would bind looser than the scope);
	 *   - for every required policy column, the guarded filter entry's OWN bind
	 *     ('<Parameter>_w<index>') holds the principal's value and appears in the SQL as
	 *     '<column> = <bind>' (optionally qualified by the entity's own table) — never "the column
	 *     name appears somewhere and some bind has the value".
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {any} pQuery - built
	 */
	assertRenderedPolicy(pContext, pEntity, pQuery)
	{
		let tmpPolicy = this.fable.RetoldFacetingScopeGuard.policyFor(pContext);
		let tmpRequired = (typeof(tmpPolicy.requiredFor) === 'function') ? tmpPolicy.requiredFor(pEntity, pContext.Principal) : [];
		let tmpSQL = String(pQuery.query.body || '');
		let tmpBinds = pQuery.query.parameters || {};
		let tmpFilter = Array.isArray(pQuery.parameters.filter) ? pQuery.parameters.filter : [];
		let tmpTemplate = pQuery.parameters.queryOverride;
		let tmpTable = (typeof(pQuery.parameters.scope) === 'string') ? pQuery.parameters.scope.replace(/["`[\]\s]/g, '') : pEntity;
		let tmpViolations = [];

		if ((typeof(tmpTemplate) !== 'string') || (tmpTemplate.length < 1))
		{
			tmpViolations.push({ Rule: 'TemplateNotVerifiable' });
		}
		else
		{
			let tmpWhereTokens = tmpTemplate.match(/<%=\s*Where\s*%>/g) || [];
			if (tmpWhereTokens.length !== 1)
			{
				tmpViolations.push({ Rule: 'WhereNotRenderedOnce' });
			}
			else
			{
				let tmpAfter = tmpTemplate.slice(tmpTemplate.search(/<%=\s*Where\s*%>/) + tmpWhereTokens[0].length);
				if (/\bOR\b/i.test(tmpAfter))
				{
					tmpViolations.push({ Rule: 'TemplateWidens' });
				}
			}
			if (/\bUNION\b/i.test(tmpTemplate))
			{
				tmpViolations.push({ Rule: 'TemplateWidens' });
			}
		}

		let tmpDepths = libScopeGuard.filterDepths(tmpFilter).Depths;
		let fEscape = (pText) => { return String(pText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
		for (let i = 0; i < tmpRequired.length; i++)
		{
			let tmpColumn = tmpRequired[i].Column;
			let tmpValue = libRetoldFacetingUtil.normalizeScopeValue(tmpRequired[i].Value);
			let tmpRendered = false;
			for (let j = 0; (j < tmpFilter.length) && !tmpRendered && (tmpValue !== null); j++)
			{
				let tmpEntry = tmpFilter[j];
				if ((tmpDepths[j] !== 0) || (tmpEntry.Operator !== '=') || (String(tmpEntry.Connector).toUpperCase() !== 'AND')
					|| (libRetoldFacetingUtil.stripColumn(tmpEntry.Column) !== tmpColumn)
					|| ((libRetoldFacetingUtil.columnQualifier(tmpEntry.Column) !== null) && (libRetoldFacetingUtil.columnQualifier(tmpEntry.Column) !== tmpTable))
					|| (libRetoldFacetingUtil.normalizeScopeValue(tmpEntry.Value) !== tmpValue))
				{
					continue;
				}
				let tmpBind = `${tmpEntry.Parameter}_w${j}`;
				if (!hasOwn(tmpBinds, tmpBind) || (libRetoldFacetingUtil.normalizeScopeValue(tmpBinds[tmpBind]) !== tmpValue))
				{
					continue;
				}
				let tmpQuoted = (pName) => { return `[\`"\\[]?${fEscape(pName)}[\`"\\]]?`; };
				let tmpPattern = new RegExp(`(^|[^A-Za-z0-9_.\`"\\]])(${tmpQuoted(tmpTable)}\\.)?${tmpQuoted(tmpColumn)}\\s*=\\s*[:@]${fEscape(tmpBind)}(?![A-Za-z0-9_])`);
				tmpRendered = tmpPattern.test(tmpSQL);
			}
			if (!tmpRendered)
			{
				tmpViolations.push({ Rule: 'PolicyNotRendered', Column: tmpColumn });
			}
		}
		if (tmpViolations.length > 0)
		{
			this.fable.log.error(`RetoldFaceting refused the opaque staged query of ${pEntity}: ${tmpViolations.map((pViolation) => { return pViolation.Column ? `${pViolation.Rule}(${pViolation.Column})` : pViolation.Rule; }).join(', ')}`);
			throw libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pEntity, Reason: 'OpaqueUntrusted', Violations: tmpViolations });
		}
	}

	/**
	 * Execute one read through the entity DAL's provider (raw rows, copied to plain objects).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {any} pDAL
	 * @param {any} pQuery
	 * @param {string} pEntity
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	_read(pContext, pDAL, pQuery, pEntity, fCallback)
	{
		if ((typeof(pContext.Deadline) === 'number') && (Date.now() > pContext.Deadline))
		{
			return fCallback(libFacetErrors.create('FACET_TIMEOUT'));
		}
		pContext.Counters.Statements = (pContext.Counters.Statements || 0) + 1;
		let tmpCalledBack = false;
		let tmpSynchronous = true;
		let tmpPending = null;
		let fFinish = (pError) =>
		{
			if (pError)
			{
				this.fable.log.error(`RetoldFaceting staged key query failed for ${pEntity}: ${pError.message}`);
				return fCallback(libFacetErrors.create('FACET_INTERNAL'));
			}
			let tmpResult = pQuery.parameters.result || {};
			let tmpRows = Array.isArray(tmpResult.value) ? tmpResult.value : [];
			return fCallback(null, tmpRows.map((pRow) => { return Object.assign({}, pRow); }));
		};
		let fReadDone = () =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			let tmpResult = pQuery.parameters.result || {};
			let tmpError = tmpResult.error ? tmpResult.error : null;
			if (tmpSynchronous)
			{
				tmpPending = { Error: tmpError };
				return;
			}
			return fFinish(tmpError);
		};
		try
		{
			pDAL.provider.Read(pQuery, fReadDone);
		}
		catch (pReadError)
		{
			if (!tmpCalledBack)
			{
				tmpCalledBack = true;
				tmpPending = { Error: pReadError };
			}
		}
		tmpSynchronous = false;
		if (tmpPending)
		{
			return fFinish(tmpPending.Error);
		}
	}

	/**
	 * Validate, de-duplicate and sort the collected key tuples (integers only; over the cap → 422).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pRel
	 * @param {Record<string, any>} pRelation
	 * @param {Array<string>} pKeyColumns
	 * @param {Array<Array<any>>} pRows
	 * @return {Record<string, any>} StagedRelation (alias-independent)
	 */
	_keySet(pContext, pRel, pRelation, pKeyColumns, pRows)
	{
		let tmpMax = this.maxKeys(pContext);
		let tmpSeen = new Set();
		let tmpKeys = [];
		for (let i = 0; i < pRows.length; i++)
		{
			let tmpTuple = [];
			let tmpHasNull = false;
			for (let j = 0; j < pKeyColumns.length; j++)
			{
				let tmpRaw = pRows[i][j];
				if ((tmpRaw === null) || (typeof(tmpRaw) === 'undefined'))
				{
					// A NULL key can never equal an outer column (SQL equality): it matches nothing.
					tmpHasNull = true;
					break;
				}
				let tmpKey = integerKey(tmpRaw);
				if (tmpKey === null)
				{
					this.fable.log.error(`RetoldFaceting: a staged key of ${pRel.Entity}.${pKeyColumns[j]} is not an integer.`);
					throw libFacetErrors.create('FACET_INTERNAL', 'A staged key is not an integer.');
				}
				tmpTuple.push(tmpKey);
			}
			if (tmpHasNull)
			{
				continue;
			}
			let tmpSignature = tmpTuple.join(',');
			if (tmpSeen.has(tmpSignature))
			{
				continue;
			}
			tmpSeen.add(tmpSignature);
			tmpKeys.push(tmpTuple);
			if (tmpKeys.length > tmpMax)
			{
				throw libFacetErrors.create('FACET_PATH_TOO_BROAD', 'The staged key set is too large.', { Limit: 'MaxStagedKeys', Max: tmpMax, Suggest: { Engine: 'ClickHouse' } });
			}
		}
		if (pRows.length > tmpMax)
		{
			// The capped read came back full: more distinct keys may exist than were read.
			throw libFacetErrors.create('FACET_PATH_TOO_BROAD', 'The staged key set is too large.', { Limit: 'MaxStagedKeys', Max: tmpMax, Suggest: { Engine: 'ClickHouse' } });
		}
		tmpKeys.sort(compareTuples);
		return (
			{
				Alias: pRel.As,
				Entity: pRel.Entity,
				Staged: true,
				Dialect: pRelation.Dialect,
				Columns: pKeyColumns.slice(),
				Keys: tmpKeys,
				Count: tmpKeys.length,
				Capture: pRelation.Capture,
				Params: {},
				ParamTypes: {}
			});
	}

	/**
	 * The dialect's one-scalar membership fragment for a staged key set.
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, any>} pStaged - StagedRelation view (from stage() / view())
	 * @param {Array<string>} pOuterColumnsSQL - alias-qualified, quoted outer columns in key order
	 * @param {boolean} pNegated - NOT (anti-join)
	 * @return {{ SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any> }}
	 */
	membership(pDialectName, pStaged, pOuterColumnsSQL, pNegated)
	{
		let tmpModule = this.fable.RetoldFacetingShellTemplates.dialect(pDialectName);
		if (!tmpModule || !pStaged || !Array.isArray(pStaged.Columns) || !Array.isArray(pOuterColumnsSQL) || (pOuterColumnsSQL.length !== pStaged.Columns.length))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed staged membership.');
		}
		// The bind form is the statement dialect's (a key set read on one dialect may be rendered for
		// another only in dry-builds; in a request every relation shares one dialect).
		let tmpView = (Array.isArray(pStaged.BindNames) && (pStaged.BindDialect === pDialectName)) ? pStaged : this.view(Object.assign({}, pStaged, { Dialect: pDialectName }), pStaged.Alias);
		return (
			{
				SQL: tmpModule.Expressions.stagedMembership(pOuterColumnsSQL, tmpView.BindNames, !!pNegated),
				Params: Object.assign({}, tmpView.Params),
				ParamTypes: Object.assign({}, tmpView.ParamTypes)
			});
	}
}

module.exports = RetoldFacetingStagedKeys;
module.exports.serviceType = 'RetoldFacetingStagedKeys';
module.exports.integerKey = integerKey;
module.exports.compareTuples = compareTuples;
