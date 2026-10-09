/**
 * Retold Faceting - Scope Capture
 *
 * Runs an entity's own Reads-QueryConfiguration behavior on the ROUTE-BOUND controller against a
 * fresh query (client predicates already fenced), snapshots the filter before/after, and reports
 * what the host added (Appended), rewrote (Transformed) or did that cannot be wrapped (Opaque),
 * then asserts the declared policy with ScopeGuard (06 §3.2, D-06).
 *
 * Memoized per request by (Entity, ScopeMode, the exact pre-behavior filter): a second query with
 * the same pre-behavior filter gets the captured post-behavior (and post-guard) filter replayed
 * instead of running the behaviors again, so behaviors that do I/O run once per Variant.
 *
 * A refusal (FACET_SCOPE_POLICY_VIOLATION) carries the violated rules in its Detail for the server
 * log and in-process callers only: like every 5xx, its client form is the generic message.
 *
 * Scope modes (M2):
 *   - 'Inherit'    the entity's own scope, exactly as its list (every hop of a path by default);
 *   - 'TenantOnly' the behaviors run, then ONLY the exact personal-scope entry of the policy
 *                  (PersonalScopes[Entity].Column = the principal's own value, depth 0, '=', AND) is
 *                  removed (relaxPersonalScope, a pure static the Reference engine shares); any other
 *                  mention of that column refuses the relaxation, which makes the capture Opaque and
 *                  never stageable (06 §4.4, internal-contracts §26.2).
 * An Opaque capture of an entity listed in Scope.TrustedOpaque is returned (not refused) so the
 * ScopedRelationBuilder can run it Staged (internal-contracts §26.3); every other Opaque capture is
 * refused by the guard.
 *
 * Contract: internal-contracts §8.1, §26.2.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Operators a capture may contain without being Opaque (06 §3.2).
const PORTABLE_OPERATORS = Object.freeze([ '=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', 'IN', 'NOT IN', 'IS', 'IS NULL', 'IS NOT NULL', '(', ')' ]);

// The scope modes a capture understands (internal-contracts §26.1).
const SCOPE_MODES = Object.freeze([ 'Inherit', 'TenantOnly' ]);

// Opaque reasons that mean the behavior REPLACED the query (its filter no longer describes it).
const REPLACING_REASONS = Object.freeze([ 'QueryOverride', 'QueryBranches' ]);

// Read-side behaviors the list paths run besides Reads-QueryConfiguration (06 §3.5,
// meadow-endpoints Meadow-Endpoint-Reads / ReadLiteList / ReadDistinctList / ReadSelectList / Read).
// Row filtering or redaction there is invisible to a capture of the QueryConfiguration, so an entity
// that has one is Opaque for facets unless the host vouches for it (Scope.TrustPostOperation) or the
// relation reads only Scope.PostOperationSafeColumns[E].
const READ_SIDE_BEHAVIORS = Object.freeze([ 'Read-PreOperation', 'Reads-PostOperation', 'ReadsLite-PostOperation', 'ReadDistinct-PostOperation', 'ReadSelectList-PostOperation' ]);

// The Opaque reason of an untrusted read-side behavior (never stageable: a staged key query does not
// run the PostOperation either).
const POST_OPERATION_REASON = 'PostOperation';

const hasOwn = libRetoldFacetingUtil.hasOwn;
const stripColumn = libRetoldFacetingUtil.stripColumn;
// Snapshots, memo keys and fingerprints use the contract's canonical JSON (one implementation).
const canonicalJSON = libFacetClauses.canonicalJSON;

/**
 * Copy one filter entry (arrays copied, so later mutation of the query never alters a snapshot).
 *
 * @param {Record<string, any>} pEntry
 * @return {Record<string, any>}
 */
const copyEntry = (pEntry) =>
{
	let tmpCopy = {};
	let tmpKeys = Object.keys(pEntry || {});
	for (let i = 0; i < tmpKeys.length; i++)
	{
		let tmpValue = pEntry[tmpKeys[i]];
		tmpCopy[tmpKeys[i]] = Array.isArray(tmpValue) ? tmpValue.slice() : tmpValue;
	}
	return tmpCopy;
};

/**
 * @param {any} pFilter
 * @return {Array<Record<string, any>>}
 */
const copyFilter = (pFilter) =>
{
	return Array.isArray(pFilter) ? pFilter.map(copyEntry) : [];
};

/**
 * Is a filter value a scalar or an array of scalars?
 *
 * @param {any} pValue
 * @return {boolean}
 */
const isScalarValue = (pValue) =>
{
	let fScalar = (pScalar) =>
	{
		return (pScalar === null) || (typeof(pScalar) === 'string') || (typeof(pScalar) === 'boolean') || ((typeof(pScalar) === 'number') && Number.isFinite(pScalar));
	};
	if (Array.isArray(pValue))
	{
		return pValue.every(fScalar);
	}
	return fScalar(pValue);
};

/**
 * Paren depth of every entry ('(' / ')' sit at the depth outside their group).
 *
 * @param {Array<Record<string, any>>} pFilter
 * @return {Array<number>}
 */
const entryDepths = (pFilter) =>
{
	let tmpDepth = 0;
	let tmpDepths = [];
	for (let i = 0; i < pFilter.length; i++)
	{
		if (pFilter[i].Operator === ')')
		{
			tmpDepth = Math.max(tmpDepth - 1, 0);
			tmpDepths.push(tmpDepth);
		}
		else if (pFilter[i].Operator === '(')
		{
			tmpDepths.push(tmpDepth);
			tmpDepth++;
		}
		else
		{
			tmpDepths.push(tmpDepth);
		}
	}
	return tmpDepths;
};

/**
 * The TenantOnly relaxation (internal-contracts §26.2, 06 §4.4): remove the ONE exact personal-scope
 * entry of the policy from a post-behavior filter, and nothing else.  Pure; shared by the Live
 * capture and the Reference engine so both relax identically.
 *
 * The personal column is pPolicy.PersonalScopes[pEntity].Column.  Exactly one filter entry may name
 * it (after stripColumn): at depth 0, Operator '=', Connector 'AND' (its own, and no OR-connected
 * term follows it at depth 0), Value equal (after normalizeScopeValue) to the principal's
 * ScopeValues[Column].  Refusals:
 *   'NoPersonalScope'  the policy declares no personal scope for the entity;
 *   'NotFound'         no entry names the column;
 *   'ColumnElsewhere'  more than one entry names it, or the one entry sits inside a group (a client
 *                      fence included), under OR, or with IN / NOT IN;
 *   'NotExact'         the one depth-0 entry uses another operator, or another value.
 *
 * @param {Array<Record<string, any>>} pFilter - FoxHound filter entries (not mutated)
 * @param {Record<string, any>} pPolicy - Host.getScopePolicy()
 * A mention qualified by another table ('Other.OwnerIDUser', a joined table's column) is never this
 * entity's personal scope: it refuses the relaxation ('ColumnElsewhere').
 *
 * @param {Record<string, any>} pPrincipal
 * @param {string} pEntity
 * @param {string} [pTable] - the entity's table name (FoxHound scope); default pEntity
 * @return {{ Filter: Array<Record<string, any>>, Removed: Array<Record<string, any>>, Refused: string|null, Column: string|null }}
 */
const relaxPersonalScope = (pFilter, pPolicy, pPrincipal, pEntity, pTable) =>
{
	let tmpFilter = copyFilter(pFilter);
	let tmpPersonal = (pPolicy && pPolicy.PersonalScopes && hasOwn(pPolicy.PersonalScopes, pEntity)) ? pPolicy.PersonalScopes[pEntity] : null;
	let tmpColumn = (tmpPersonal && (typeof(tmpPersonal.Column) === 'string') && (tmpPersonal.Column.length > 0)) ? tmpPersonal.Column : null;
	if (!tmpColumn)
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'NoPersonalScope', Column: null };
	}
	let tmpDepths = entryDepths(tmpFilter);
	let tmpMentions = [];
	for (let i = 0; i < tmpFilter.length; i++)
	{
		let tmpOperator = tmpFilter[i].Operator;
		if ((tmpOperator === '(') || (tmpOperator === ')'))
		{
			continue;
		}
		if (stripColumn(tmpFilter[i].Column) === tmpColumn)
		{
			tmpMentions.push(i);
		}
	}
	if (tmpMentions.length < 1)
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'NotFound', Column: tmpColumn };
	}
	if (tmpMentions.length > 1)
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'ColumnElsewhere', Column: tmpColumn };
	}
	let tmpIndex = tmpMentions[0];
	let tmpEntry = tmpFilter[tmpIndex];
	let tmpQualifier = libRetoldFacetingUtil.columnQualifier(tmpEntry.Column);
	let tmpTable = ((typeof(pTable) === 'string') && (pTable.length > 0)) ? pTable.replace(/["`[\]\s]/g, '') : pEntity;
	if ((tmpQualifier !== null) && (tmpQualifier !== tmpTable))
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'ColumnElsewhere', Column: tmpColumn };
	}
	let tmpOperator = String(tmpEntry.Operator).toUpperCase();
	if ((tmpDepths[tmpIndex] !== 0) || (tmpOperator === 'IN') || (tmpOperator === 'NOT IN'))
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'ColumnElsewhere', Column: tmpColumn };
	}
	// Under OR: its own emitted connector (FoxHound emits none for the first entry), or the next
	// depth-0 term's.
	let tmpOwnConnector = String(tmpEntry.Connector).toUpperCase();
	if ((tmpIndex > 0) && (tmpOwnConnector !== 'AND'))
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'ColumnElsewhere', Column: tmpColumn };
	}
	for (let i = tmpIndex + 1; i < tmpFilter.length; i++)
	{
		if ((tmpDepths[i] !== 0) || (tmpFilter[i].Operator === ')'))
		{
			continue;
		}
		if (String(tmpFilter[i].Connector).toUpperCase() !== 'AND')
		{
			return { Filter: tmpFilter, Removed: [], Refused: 'ColumnElsewhere', Column: tmpColumn };
		}
		break;
	}
	if (tmpOperator !== '=')
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'NotExact', Column: tmpColumn };
	}
	let tmpScopeValues = (pPrincipal && pPrincipal.ScopeValues) ? pPrincipal.ScopeValues : {};
	let tmpPrincipalValue = hasOwn(tmpScopeValues, tmpColumn) ? libRetoldFacetingUtil.normalizeScopeValue(tmpScopeValues[tmpColumn]) : null;
	let tmpEntryValue = libRetoldFacetingUtil.normalizeScopeValue(tmpEntry.Value);
	if ((tmpPrincipalValue === null) || (tmpEntryValue !== tmpPrincipalValue))
	{
		return { Filter: tmpFilter, Removed: [], Refused: 'NotExact', Column: tmpColumn };
	}
	let tmpRemoved = tmpFilter.splice(tmpIndex, 1);
	return { Filter: tmpFilter, Removed: tmpRemoved, Refused: null, Column: tmpColumn };
};

class RetoldFacetingScopeCapture extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingScopeCapture';
	}

	/**
	 * Snapshot the query parts a behavior could change.
	 *
	 * @param {any} pQuery
	 * @return {{ Filter: Array<Record<string, any>>, Join: string, QueryOverride: any, QueryBranches: string }}
	 */
	snapshot(pQuery)
	{
		let tmpParameters = (pQuery && pQuery.parameters) ? pQuery.parameters : {};
		return (
			{
				Filter: copyFilter(tmpParameters.filter),
				Join: canonicalJSON(Array.isArray(tmpParameters.join) ? tmpParameters.join : []),
				QueryOverride: tmpParameters.queryOverride || false,
				QueryBranches: canonicalJSON(tmpParameters.queryBranches || null)
			});
	}

	/**
	 * Diff a pre-behavior snapshot against the query after the behaviors ran.
	 *
	 * @param {Record<string, any>} pBefore - snapshot()
	 * @param {any} pQuery
	 * @return {{ PostBehaviorFilter: Array<Record<string, any>>, Appended: Array<Record<string, any>>, Transformed: Array<Record<string, any>>, Opaque: boolean, OpaqueReasons: Array<string>, Portable: boolean }}
	 */
	analyze(pBefore, pQuery)
	{
		let tmpAfter = this.snapshot(pQuery);
		let tmpFilter = tmpAfter.Filter;
		let tmpReasons = [];
		let fReason = (pReason) =>
		{
			if (tmpReasons.indexOf(pReason) < 0)
			{
				tmpReasons.push(pReason);
			}
		};

		if (tmpAfter.Join !== pBefore.Join)
		{
			fReason('JoinAdded');
		}
		if (tmpAfter.QueryOverride !== pBefore.QueryOverride)
		{
			fReason('QueryOverride');
		}
		if (tmpAfter.QueryBranches !== pBefore.QueryBranches)
		{
			fReason('QueryBranches');
		}

		let tmpTransformed = [];
		if (tmpFilter.length < pBefore.Filter.length)
		{
			fReason('FilterRewritten');
		}
		for (let i = 0; (i < pBefore.Filter.length) && (i < tmpFilter.length); i++)
		{
			let tmpWas = pBefore.Filter[i];
			let tmpIs = tmpFilter[i];
			let tmpSameButOperator = (canonicalJSON(tmpWas.Column) === canonicalJSON(tmpIs.Column))
				&& (canonicalJSON(tmpWas.Value) === canonicalJSON(tmpIs.Value))
				&& (tmpWas.Connector === tmpIs.Connector)
				&& (tmpWas.Parameter === tmpIs.Parameter);
			if (!tmpSameButOperator)
			{
				fReason('FilterRewritten');
			}
			else if (tmpWas.Operator !== tmpIs.Operator)
			{
				tmpTransformed.push({ Index: i, Before: { Operator: tmpWas.Operator }, After: { Operator: tmpIs.Operator } });
			}
		}

		let tmpDepths = entryDepths(tmpFilter);
		let tmpAppended = [];
		for (let i = pBefore.Filter.length; i < tmpFilter.length; i++)
		{
			tmpAppended.push(
				{
					Column: tmpFilter[i].Column,
					Operator: tmpFilter[i].Operator,
					Value: Array.isArray(tmpFilter[i].Value) ? tmpFilter[i].Value.slice() : tmpFilter[i].Value,
					Connector: tmpFilter[i].Connector,
					Parameter: tmpFilter[i].Parameter,
					Depth: tmpDepths[i]
				});
		}

		let tmpSchema = (pQuery && pQuery.query && Array.isArray(pQuery.query.schema)) ? pQuery.query.schema : [];
		let tmpTable = (pQuery && pQuery.parameters && (typeof(pQuery.parameters.scope) === 'string')) ? pQuery.parameters.scope.replace(/["`[\]\s]/g, '') : null;
		let tmpColumns = {};
		for (let i = 0; i < tmpSchema.length; i++)
		{
			tmpColumns[tmpSchema[i].Column] = true;
		}
		for (let i = 0; i < tmpFilter.length; i++)
		{
			let tmpOperator = (typeof(tmpFilter[i].Operator) === 'string') ? tmpFilter[i].Operator.toUpperCase() : String(tmpFilter[i].Operator);
			if (PORTABLE_OPERATORS.indexOf(tmpOperator) < 0)
			{
				fReason(`UnknownOperator:${tmpOperator}`);
			}
			if ((tmpOperator === '(') || (tmpOperator === ')'))
			{
				continue;
			}
			let tmpColumn = stripColumn(tmpFilter[i].Column);
			// A qualifier must name this entity's own table (another table means a join we cannot see).
			let tmpQualifier = libRetoldFacetingUtil.columnQualifier(tmpFilter[i].Column);
			if (!hasOwn(tmpColumns, tmpColumn) || ((tmpQualifier !== null) && (tmpQualifier !== tmpTable)))
			{
				fReason(`UnknownColumn:${(tmpQualifier !== null) ? `${tmpQualifier}.` : ''}${tmpColumn}`);
			}
			if (!isScalarValue(tmpFilter[i].Value))
			{
				fReason(`NonScalarValue:${tmpColumn}`);
			}
		}

		return (
			{
				PostBehaviorFilter: tmpFilter,
				Appended: tmpAppended,
				Transformed: tmpTransformed,
				Opaque: (tmpReasons.length > 0),
				OpaqueReasons: tmpReasons,
				Portable: (tmpReasons.length < 1)
			});
	}

	/**
	 * 'sf:' + first 12 hex of sha256(Entity | canonical(Appended) | canonical(Transformed) | Behavior | ScopeMode).
	 *
	 * @param {Record<string, any>} pCapture
	 * @param {string} pScopeMode
	 * @return {string}
	 */
	fingerprint(pCapture, pScopeMode)
	{
		let tmpParts = [ pCapture.Entity, canonicalJSON(pCapture.Appended), canonicalJSON(pCapture.Transformed), pCapture.Behavior, pScopeMode ];
		if (pScopeMode === 'TenantOnly')
		{
			// A relaxed capture fingerprints differently from the Inherit one (what was removed).
			tmpParts.push(canonicalJSON((pCapture.Removed || []).map((pEntry) => { return { Column: stripColumn(pEntry.Column), Operator: pEntry.Operator }; })));
		}
		let tmpMaterial = tmpParts.join('|');
		return `sf:${libCrypto.createHash('sha256').update(tmpMaterial).digest('hex').slice(0, 12)}`;
	}

	/**
	 * The read-side Pre/PostOperation behaviors installed on a route-bound controller (06 §3.5):
	 * BehaviorInjection.getBehaviors() when meadow-endpoints offers it (ME-1), else the keys of
	 * _BehaviorFunctions.
	 *
	 * @param {any} pController
	 * @return {Array<string>}
	 */
	readSideBehaviors(pController)
	{
		let tmpInjection = (pController && pController.BehaviorInjection) ? pController.BehaviorInjection : null;
		if (!tmpInjection)
		{
			return [];
		}
		let tmpNames = [];
		if (typeof(tmpInjection.getBehaviors) === 'function')
		{
			try
			{
				let tmpBehaviors = tmpInjection.getBehaviors();
				tmpNames = Array.isArray(tmpBehaviors) ? tmpBehaviors.map((pEntry) => { return (typeof(pEntry) === 'string') ? pEntry : ((pEntry && (typeof(pEntry.Hash) === 'string')) ? pEntry.Hash : null); })
					: ((tmpBehaviors && (typeof(tmpBehaviors) === 'object')) ? Object.keys(tmpBehaviors) : []);
			}
			catch (pBehaviorsError)
			{
				tmpNames = [];
			}
		}
		else if (tmpInjection._BehaviorFunctions && (typeof(tmpInjection._BehaviorFunctions) === 'object'))
		{
			tmpNames = Object.keys(tmpInjection._BehaviorFunctions).filter((pName) => { return (typeof(tmpInjection._BehaviorFunctions[pName]) === 'function'); });
		}
		return READ_SIDE_BEHAVIORS.filter((pName) => { return tmpNames.indexOf(pName) >= 0; });
	}

	/**
	 * The read-side behavior audit of one relation (06 §3.5): Opaque when the entity's route-bound
	 * controller has a read-side Pre/PostOperation behavior, unless the entity is listed in
	 * Scope.TrustPostOperation (the host asserts it only decorates), or every column the relation
	 * reads (pColumns: its projection, plus every column its pre-behavior filter names) is listed in
	 * Scope.PostOperationSafeColumns[Entity] (the host asserts the behavior never drops a row and never
	 * changes those columns).  Without pColumns the safe-column rule cannot apply (fail closed).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {any} pController
	 * @param {Array<string>|null} pColumns
	 * @return {{ Behaviors: Array<string>, Opaque: boolean, Trusted: boolean, SafeColumns: Array<string>|null }}
	 */
	postOperationAudit(pContext, pEntity, pController, pColumns)
	{
		let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
		let tmpScope = tmpOptions.Scope || {};
		let tmpBehaviors = this.readSideBehaviors(pController);
		let tmpTrusted = Array.isArray(tmpScope.TrustPostOperation) && (tmpScope.TrustPostOperation.indexOf(pEntity) >= 0);
		let tmpSafeMap = (tmpScope.PostOperationSafeColumns && (typeof(tmpScope.PostOperationSafeColumns) === 'object')) ? tmpScope.PostOperationSafeColumns : {};
		let tmpSafe = (hasOwn(tmpSafeMap, pEntity) && Array.isArray(tmpSafeMap[pEntity])) ? tmpSafeMap[pEntity].filter((pColumn) => { return (typeof(pColumn) === 'string'); }) : null;
		if ((tmpBehaviors.length < 1) || tmpTrusted)
		{
			return { Behaviors: tmpBehaviors, Opaque: false, Trusted: tmpTrusted, SafeColumns: tmpSafe };
		}
		let tmpColumnsSafe = !!tmpSafe && Array.isArray(pColumns) && (pColumns.length > 0)
			&& pColumns.every((pColumn) => { return tmpSafe.indexOf(pColumn) >= 0; });
		return { Behaviors: tmpBehaviors, Opaque: !tmpColumnsSafe, Trusted: false, SafeColumns: tmpSafe };
	}

	/**
	 * The columns a captured query reads besides its projection: every column its pre-behavior filter
	 * names (client fence, definition Where, the explicit soft delete excepted).
	 *
	 * @param {Array<Record<string, any>>} pFilter - pre-behavior snapshot
	 * @param {Array<string>|null} pProjection
	 * @return {Array<string>|null} null when the projection is unknown
	 */
	readColumns(pFilter, pProjection)
	{
		if (!Array.isArray(pProjection))
		{
			return null;
		}
		let tmpColumns = pProjection.slice();
		for (let i = 0; i < pFilter.length; i++)
		{
			let tmpEntry = pFilter[i];
			if (!tmpEntry || (tmpEntry.Operator === '(') || (tmpEntry.Operator === ')') || (tmpEntry.Parameter === 'FacetSoftDelete'))
			{
				continue;
			}
			let tmpColumn = stripColumn(tmpEntry.Column);
			if ((typeof(tmpColumn) === 'string') && (tmpColumn.length > 0) && (tmpColumns.indexOf(tmpColumn) < 0))
			{
				tmpColumns.push(tmpColumn);
			}
		}
		return tmpColumns;
	}

	/**
	 * Is pEntity listed in Scope.TrustedOpaque (its Opaque captures may run Staged, §26.3)?
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	isTrustedOpaque(pContext, pEntity)
	{
		let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
		let tmpTrusted = (tmpOptions.Scope && Array.isArray(tmpOptions.Scope.TrustedOpaque)) ? tmpOptions.Scope.TrustedOpaque : [];
		return (tmpTrusted.indexOf(pEntity) >= 0);
	}

	/**
	 * Capture the scope the host applies to pQuery for this request (and guard it).
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 (uses Host, Request, Principal, Memo, Counters)
	 * @param {string} pEntity
	 * @param {any} pQuery - FoxHound query with the client fence and explicit soft-delete already applied
	 * @param {string} pScopeMode - 'Inherit' | 'TenantOnly'
	 * @param {{ Columns?: Array<string>, Fresh?: boolean }|Function} [pCaptureOptions] - Columns: the relation's projection (the PostOperation safe-column rule, 06 §3.5); Fresh: never replay a memoized capture (the returned capture's RequestState is this query's)
	 * @param {(pError?: Error, pCapture?: Record<string, any>) => void} fCallback
	 */
	capture(pContext, pEntity, pQuery, pScopeMode, pCaptureOptions, fCallback)
	{
		if (typeof(pCaptureOptions) === 'function')
		{
			fCallback = pCaptureOptions;
			pCaptureOptions = null;
		}
		let tmpCaptureOptions = (pCaptureOptions && (typeof(pCaptureOptions) === 'object')) ? pCaptureOptions : {};
		let tmpContext = pContext || {};
		let tmpOptions = tmpContext.Options || this.options;
		let tmpScope = tmpOptions.Scope || {};
		let tmpScopeMode = pScopeMode || 'Inherit';
		if (SCOPE_MODES.indexOf(tmpScopeMode) < 0)
		{
			return fCallback(libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This scope mode is not supported.', { Feature: `ScopeMode:${tmpScopeMode}`, Milestone: 2 }));
		}
		if (!pQuery || !pQuery.parameters)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A scope capture needs a query.'));
		}

		if (!tmpContext.Memo)
		{
			tmpContext.Memo = { Relations: {}, Captures: {}, VariantRows: {} };
		}
		if (!tmpContext.Memo.Captures)
		{
			tmpContext.Memo.Captures = {};
		}
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}

		let tmpBefore = this.snapshot(pQuery);
		let tmpHost = tmpContext.Host;
		let tmpController = (tmpHost && (typeof(tmpHost.getRouteBoundController) === 'function')) ? tmpHost.getRouteBoundController(pEntity) : null;
		// The read-side behavior audit (06 §3.5) depends on the columns this relation reads: it is part
		// of the memo key (an entity without such behaviors always audits clean).
		let tmpPostOperation = this.postOperationAudit(tmpContext, pEntity, tmpController,
			this.readColumns(tmpBefore.Filter, Array.isArray(tmpCaptureOptions.Columns) ? tmpCaptureOptions.Columns : null));
		let tmpMemoKey = `${pEntity}|${tmpScopeMode}|${tmpPostOperation.Opaque ? 'po' : ''}|${canonicalJSON(tmpBefore)}`;
		// Fresh: the caller needs the request state this very query's behavior ran with (Records
		// hydration hands it to Reads-PostOperation), so a memoized capture is not replayed.
		if ((tmpCaptureOptions.Fresh !== true) && hasOwn(tmpContext.Memo.Captures, tmpMemoKey))
		{
			let tmpMemo = tmpContext.Memo.Captures[tmpMemoKey];
			// Replay the captured post-behavior (and post-guard) filter onto this fresh query.
			pQuery.parameters.filter = copyFilter(tmpMemo.FinalFilter);
			if (tmpMemo.FinalParts)
			{
				// An Opaque capture's behavior also changed what the filter does not describe (a join, a
				// replaced query): replay those too, so a staged run reads the behavior's own query.
				pQuery.parameters.join = JSON.parse(JSON.stringify(tmpMemo.FinalParts.Join));
				pQuery.parameters.queryOverride = tmpMemo.FinalParts.QueryOverride;
				if (tmpMemo.FinalParts.QueryBranches !== null)
				{
					pQuery.parameters.queryBranches = JSON.parse(JSON.stringify(tmpMemo.FinalParts.QueryBranches));
				}
			}
			return fCallback(null, tmpMemo.Capture);
		}

		if (!tmpController || !tmpController.BehaviorInjection || (typeof(tmpController.initializeRequestState) !== 'function'))
		{
			// Controller-less entities ('Declared' scope) are a later milestone: fail closed.
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The entity has no route-bound controller to capture its scope from.'));
		}
		let tmpScopeGuard = this.fable.RetoldFacetingScopeGuard;
		if (!tmpScopeGuard || (typeof(tmpScopeGuard.assert) !== 'function'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The scope guard is not registered.'));
		}

		let tmpMaxRuns = (tmpOptions.Limits && (typeof(tmpOptions.Limits.MaxBehaviorRunsPerRequest) === 'number')) ? tmpOptions.Limits.MaxBehaviorRunsPerRequest : 32;
		if ((tmpContext.Counters.BehaviorRuns + 1) > tmpMaxRuns)
		{
			return fCallback(libFacetErrors.create('FACET_TOO_LARGE', 'The request needs too many scope captures.', { Limit: 'MaxBehaviorRunsPerRequest' }));
		}
		tmpContext.Counters.BehaviorRuns++;

		let tmpBehavior = (tmpScope.BehaviorOverrides && (typeof(tmpScope.BehaviorOverrides[pEntity]) === 'string'))
			? tmpScope.BehaviorOverrides[pEntity]
			: ((typeof(tmpScope.Behavior) === 'string') ? tmpScope.Behavior : 'Reads-QueryConfiguration');
		let tmpBehaviorFunctions = tmpController.BehaviorInjection._BehaviorFunctions;
		let tmpBehaviorRan = !!tmpBehaviorFunctions && Object.prototype.hasOwnProperty.call(tmpBehaviorFunctions, tmpBehavior);

		let tmpRequest = tmpContext.Request || { params: {}, headers: {}, query: {} };
		let tmpState;
		try
		{
			tmpState = tmpController.initializeRequestState(tmpRequest, 'Reads');
		}
		catch (pStateError)
		{
			this.fable.log.error(`RetoldFaceting ScopeCapture could not initialize the request state for ${pEntity}: ${pStateError.message}`);
			return fCallback(libFacetErrors.create('FACET_INTERNAL'));
		}
		tmpState.Query = pQuery;

		let fContinue = (pBehaviorError) =>
		{
			if (pBehaviorError)
			{
				// One mapping for every engine (the Reference uses the same function).
				let tmpMapped = libFacetErrors.fromBehaviorError(pBehaviorError);
				if (tmpMapped.Code === 'FACET_INTERNAL')
				{
					this.fable.log.error(`RetoldFaceting ScopeCapture: the ${tmpBehavior} behavior of ${pEntity} failed.`);
				}
				return fCallback(tmpMapped);
			}
			return this._finishCapture(tmpContext, pEntity, pQuery, tmpScopeMode, tmpBehavior, tmpBehaviorRan, tmpBefore, tmpMemoKey, tmpScopeGuard, tmpPostOperation, tmpState, fCallback);
		};

		// A synchronous behavior's continuation runs AFTER runBehavior returns, so nothing downstream
		// ever executes inside BehaviorInjection's own try/catch (which would re-enter the callback).
		let tmpCalledBack = false;
		let tmpSynchronous = true;
		let tmpPending = null;
		let fBehaviorDone = (pBehaviorError) =>
		{
			if (tmpCalledBack)
			{
				this.fable.log.error(`RetoldFaceting ScopeCapture: the ${tmpBehavior} behavior of ${pEntity} called back more than once.`);
				return;
			}
			tmpCalledBack = true;
			if (tmpSynchronous)
			{
				tmpPending = { Error: pBehaviorError || null };
				return;
			}
			return fContinue(pBehaviorError);
		};

		try
		{
			tmpController.BehaviorInjection.runBehavior(tmpBehavior, tmpController, tmpRequest, tmpState, fBehaviorDone);
		}
		catch (pRunError)
		{
			fBehaviorDone(pRunError);
		}
		tmpSynchronous = false;
		if (tmpPending)
		{
			return fContinue(tmpPending.Error);
		}
	}

	/**
	 * Diff, guard, fingerprint and memoize a capture whose behaviors ran.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {any} pQuery
	 * @param {string} pScopeMode
	 * @param {string} pBehavior
	 * @param {boolean} pBehaviorRan
	 * @param {Record<string, any>} pBefore
	 * @param {string} pMemoKey
	 * @param {any} pScopeGuard
	 * @param {Record<string, any>} pPostOperation - postOperationAudit()
	 * @param {Record<string, any>} pState - the request state the QueryConfiguration behavior ran with
	 * @param {(pError?: Error, pCapture?: Record<string, any>) => void} fCallback
	 */
	_finishCapture(pContext, pEntity, pQuery, pScopeMode, pBehavior, pBehaviorRan, pBefore, pMemoKey, pScopeGuard, pPostOperation, pState, fCallback)
	{
		let tmpAnalysis = this.analyze(pBefore, pQuery);
		if (Array.isArray(pContext.ScopeLog))
		{
			// M4 (internal-contracts §42.8): what this execution's behavior appended, before any
			// TenantOnly relaxation, for CacheKey.scopeDrift (a cacheable request arms the log after its
			// probes; probes run with ScopeLog null).
			pContext.ScopeLog.push({ Entity: pEntity, ScopeMode: pScopeMode, Appended: tmpAnalysis.Appended.slice() });
		}
		if (pPostOperation && pPostOperation.Opaque)
		{
			// A row filter / redaction in a read-side behavior is invisible here (06 §3.5): Opaque, and
			// never stageable (a staged key query does not run it either).
			tmpAnalysis.OpaqueReasons = tmpAnalysis.OpaqueReasons.concat([ POST_OPERATION_REASON ]);
			tmpAnalysis.Opaque = true;
			tmpAnalysis.Portable = false;
		}
		let tmpCapture = (
			{
				Entity: pEntity,
				Source: 'Behaviors',
				Behavior: pBehavior,
				BehaviorRan: pBehaviorRan,
				ScopeMode: pScopeMode,
				PostBehaviorFilter: tmpAnalysis.PostBehaviorFilter,
				Appended: tmpAnalysis.Appended,
				Transformed: tmpAnalysis.Transformed,
				Opaque: tmpAnalysis.Opaque,
				OpaqueReasons: tmpAnalysis.OpaqueReasons,
				Portable: tmpAnalysis.Portable,
				// TenantOnly: what the relaxation removed (and why it refused, when it did).
				Relaxed: false,
				Removed: [],
				RelaxRefused: null,
				// An Opaque capture of a TrustedOpaque entity may run Staged (never one whose
				// TenantOnly relaxation was refused), and one whose behavior REPLACED the query
				// defers its policy assertion to the staged run's rendered SQL (§26.3).
				Trusted: false,
				Replaced: tmpAnalysis.OpaqueReasons.some((pReason) => { return REPLACING_REASONS.indexOf(pReason) >= 0; }),
				Guard: null,
				Fingerprint: null,
				// The read-side behaviors present (06 §3.5) and whether the audit made the capture Opaque.
				PostOperation: (pPostOperation && pPostOperation.Behaviors.length > 0) ? { Behaviors: pPostOperation.Behaviors.slice(), Opaque: pPostOperation.Opaque, Trusted: pPostOperation.Trusted } : null
			});
		// The request state the QueryConfiguration ran with (Records hydration hands it to
		// Reads-PostOperation, exactly as the list waterfall shares one state).  Not enumerable: it is
		// never hashed or serialized.
		Object.defineProperty(tmpCapture, 'RequestState', { value: pState || null, enumerable: false, writable: true });

		if (pScopeMode === 'TenantOnly')
		{
			let tmpPolicy = pScopeGuard.policyFor(pContext);
			let tmpRelaxed = relaxPersonalScope(pQuery.parameters.filter, tmpPolicy, pContext.Principal, pEntity, (typeof(pQuery.parameters.scope) === 'string') ? pQuery.parameters.scope : pEntity);
			if (tmpRelaxed.Refused)
			{
				// Never a silently wider scope: refused relaxations are Opaque, never staged.
				tmpCapture.RelaxRefused = tmpRelaxed.Refused;
				tmpCapture.Opaque = true;
				tmpCapture.Portable = false;
				tmpCapture.OpaqueReasons = tmpCapture.OpaqueReasons.concat([ `TenantOnlyRefused:${tmpRelaxed.Refused}` ]);
			}
			else
			{
				pQuery.parameters.filter = tmpRelaxed.Filter;
				tmpCapture.Relaxed = true;
				tmpCapture.Removed = tmpRelaxed.Removed.map(copyEntry);
				tmpCapture.PostBehaviorFilter = copyFilter(tmpRelaxed.Filter);
				let tmpRemovedColumn = tmpRelaxed.Column;
				tmpCapture.Appended = tmpCapture.Appended.filter((pEntry) => { return stripColumn(pEntry.Column) !== tmpRemovedColumn; });
			}
		}
		tmpCapture.Trusted = tmpCapture.Opaque && (tmpCapture.RelaxRefused === null)
			&& (tmpCapture.OpaqueReasons.indexOf(POST_OPERATION_REASON) < 0) && this.isTrustedOpaque(pContext, pEntity);

		let tmpGuard;
		try
		{
			tmpGuard = pScopeGuard.assert(pContext, pEntity, pQuery, tmpCapture);
		}
		catch (pGuardError)
		{
			this.fable.log.error(`RetoldFaceting ScopeGuard failed on ${pEntity}: ${pGuardError.message}`);
			return fCallback(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pEntity, Violations: [ { Rule: 'GuardError' } ] }));
		}
		tmpCapture.Guard = tmpGuard;
		if (!tmpGuard || !tmpGuard.Satisfied)
		{
			let tmpViolations = (tmpGuard && Array.isArray(tmpGuard.Violations)) ? tmpGuard.Violations.map(
				(pViolation) =>
				{
					return (typeof(pViolation.Column) === 'string') ? { Rule: pViolation.Rule, Column: pViolation.Column } : { Rule: pViolation.Rule };
				}) : [];
			this.fable.log.error(`RetoldFaceting ScopeGuard (${tmpGuard ? tmpGuard.Mode : 'unknown'}) refused ${pEntity}: ${tmpViolations.map((pViolation) => { return pViolation.Column ? `${pViolation.Rule}(${pViolation.Column})` : pViolation.Rule; }).join(', ')}`);
			return fCallback(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pEntity, Violations: tmpViolations }));
		}
		tmpCapture.Fingerprint = this.fingerprint(tmpCapture, pScopeMode);

		let tmpFinalParts = null;
		if (tmpCapture.Opaque)
		{
			let tmpParameters = pQuery.parameters;
			tmpFinalParts = (
				{
					Join: Array.isArray(tmpParameters.join) ? tmpParameters.join : [],
					QueryOverride: tmpParameters.queryOverride || false,
					QueryBranches: (typeof(tmpParameters.queryBranches) === 'undefined') ? null : tmpParameters.queryBranches
				});
			tmpFinalParts = JSON.parse(JSON.stringify(tmpFinalParts));
		}
		pContext.Memo.Captures[pMemoKey] = { Capture: tmpCapture, FinalFilter: copyFilter(pQuery.parameters.filter), FinalParts: tmpFinalParts };
		return fCallback(null, tmpCapture);
	}

	/**
	 * Boot-time probe with synthetic principals (06 §4.2) — a later milestone.
	 *
	 * @param {string} pEntity
	 * @param {(pError?: Error, pResult?: Record<string, any>) => void} fCallback
	 */
	probe(pEntity, fCallback)
	{
		return fCallback(null, { Entity: pEntity, Probed: false });
	}
}

// The TenantOnly relaxation is a pure static (internal-contracts §26.2): the Reference engine
// calls RetoldFacetingScopeCapture.relaxPersonalScope(…) without a service instance.
RetoldFacetingScopeCapture.relaxPersonalScope = relaxPersonalScope;

module.exports = RetoldFacetingScopeCapture;
module.exports.serviceType = 'RetoldFacetingScopeCapture';
module.exports.PORTABLE_OPERATORS = PORTABLE_OPERATORS;
module.exports.SCOPE_MODES = SCOPE_MODES;
module.exports.REPLACING_REASONS = REPLACING_REASONS;
module.exports.READ_SIDE_BEHAVIORS = READ_SIDE_BEHAVIORS;
module.exports.POST_OPERATION_REASON = POST_OPERATION_REASON;
module.exports.relaxPersonalScope = relaxPersonalScope;
module.exports.entryDepths = entryDepths;
module.exports.canonicalJSON = canonicalJSON;
module.exports.stripColumn = stripColumn;
