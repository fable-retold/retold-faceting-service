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
 * Host fences (internal-contracts §75.4, Part V): a host behavior that wraps the whole prior filter in a
 * bare group before appending its scope (RAFS's tenancy fence) is peeled before the diff (HostWraps), and
 * operators the host's fence refuses (Host.fenceProfile().Swap, RAFS: 'IS' + null on SQLite) are swapped
 * for the behavior run only and restored before the after-snapshot.  Anything else still fails closed.
 *
 * Contract: internal-contracts §8.1, §26.2, §75.4.
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

// The Parameter suffix of an entry the fence swap changed while a host behavior ran (§75.4).
const SWAP_MARKER = '~FacetSwap';

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
 * Is a filter entry a host's BARE paren (internal-contracts §75.4): Operator pOperator, Column '',
 * Parameter '', Connector 'AND' — what a host wrap layer (RAFS's tenancy fence) unshifts / pushes, and
 * never what faceting renders (its own parens carry a Facet* Parameter).
 *
 * @param {any} pEntry
 * @param {string} pOperator - '(' | ')'
 * @return {boolean}
 */
const isBareParen = (pEntry, pOperator) =>
{
	return !!pEntry && (typeof(pEntry) === 'object')
		&& (pEntry.Operator === pOperator)
		&& ((pEntry.Column === '') || (pEntry.Column === null) || (typeof(pEntry.Column) === 'undefined'))
		&& ((pEntry.Parameter === '') || (pEntry.Parameter === null) || (typeof(pEntry.Parameter) === 'undefined'))
		&& (String(pEntry.Connector).toUpperCase() === 'AND');
};

/**
 * Do the first pBefore.length entries of pFilter from pStart match pBefore on Column / Value /
 * Connector / Parameter (operators may differ: Transformed)?
 *
 * @param {Array<Record<string, any>>} pBefore
 * @param {Array<Record<string, any>>} pFilter
 * @param {number} pStart
 * @param {number} pEnd - exclusive
 * @return {boolean}
 */
const alignsWith = (pBefore, pFilter, pStart, pEnd) =>
{
	if ((pEnd - pStart) < pBefore.length)
	{
		return false;
	}
	for (let i = 0; i < pBefore.length; i++)
	{
		let tmpWas = pBefore[i];
		let tmpIs = pFilter[pStart + i];
		if ((canonicalJSON(tmpWas.Column) !== canonicalJSON(tmpIs.Column))
			|| (canonicalJSON(tmpWas.Value) !== canonicalJSON(tmpIs.Value))
			|| (tmpWas.Connector !== tmpIs.Connector)
			|| (tmpWas.Parameter !== tmpIs.Parameter))
		{
			return false;
		}
	}
	return true;
};

/**
 * Host-wrap peeling (internal-contracts §75.4, F1).  While the candidate range starts with a bare '('
 * whose matching close (by depth) is a bare ')', peel the pair: the entries after that close were
 * appended by that wrap layer (collected innermost first), the inside is the next candidate.  Accepted
 * only when the final inside aligns with pBefore; otherwise nothing is peeled (null: the M1
 * index-aligned rule applies and fails closed).
 *
 * @param {Array<Record<string, any>>} pBefore - the pre-behavior filter
 * @param {Array<Record<string, any>>} pAfter - the post-behavior filter
 * @return {{ HostWraps: number, Start: number, End: number, LayerRanges: Array<{ Start: number, End: number }> }|null}
 */
const peelHostWraps = (pBefore, pAfter) =>
{
	let tmpStart = 0;
	let tmpEnd = pAfter.length;
	let tmpLayers = [];
	while (((tmpEnd - tmpStart) >= 2) && isBareParen(pAfter[tmpStart], '('))
	{
		let tmpDepth = 0;
		let tmpClose = -1;
		for (let i = tmpStart; i < tmpEnd; i++)
		{
			if (pAfter[i] && (pAfter[i].Operator === '('))
			{
				tmpDepth++;
			}
			else if (pAfter[i] && (pAfter[i].Operator === ')'))
			{
				tmpDepth--;
				if (tmpDepth === 0)
				{
					tmpClose = i;
					break;
				}
			}
		}
		if ((tmpClose < 0) || !isBareParen(pAfter[tmpClose], ')'))
		{
			break;
		}
		tmpLayers.push({ Start: tmpClose + 1, End: tmpEnd });
		tmpStart = tmpStart + 1;
		tmpEnd = tmpClose;
	}
	if ((tmpLayers.length < 1) || !alignsWith(pBefore, pAfter, tmpStart, tmpEnd))
	{
		return null;
	}
	// Innermost first: the layer peeled last appended first.
	tmpLayers.reverse();
	return { HostWraps: tmpLayers.length, Start: tmpStart, End: tmpEnd, LayerRanges: tmpLayers };
};

/**
 * The fence swap (internal-contracts §75.4, F2): right before a host Reads behavior runs over a
 * faceting-rendered filter, every entry with an operator the host fence refuses (Host.fenceProfile()
 * .Swap, e.g. { IS: '=' }) and a null Value is swapped to the stand-in operator (value kept, Parameter
 * suffixed SWAP_MARKER); restoreFenceSwap puts the original back right after the behavior calls back.
 *
 * @param {any} pHost
 * @param {any} pQuery - FoxHound query
 * @return {{ Swapped: Array<{ Operator: string, Parameter: any, Stand: string }> }|null} null when nothing was swapped
 */
const applyFenceSwap = (pHost, pQuery) =>
{
	let tmpProfile = null;
	try
	{
		tmpProfile = (pHost && (typeof(pHost.fenceProfile) === 'function')) ? pHost.fenceProfile() : null;
	}
	catch (pProfileError)
	{
		tmpProfile = null;
	}
	let tmpSwap = (tmpProfile && tmpProfile.Swap && (typeof(tmpProfile.Swap) === 'object')) ? tmpProfile.Swap : null;
	let tmpFilter = (pQuery && pQuery.parameters && Array.isArray(pQuery.parameters.filter)) ? pQuery.parameters.filter : null;
	if (!tmpSwap || !tmpFilter)
	{
		return null;
	}
	let tmpSwapped = [];
	for (let i = 0; i < tmpFilter.length; i++)
	{
		let tmpEntry = tmpFilter[i];
		if (!tmpEntry || (tmpEntry.Value !== null) || (typeof(tmpEntry.Operator) !== 'string') || !hasOwn(tmpSwap, tmpEntry.Operator))
		{
			continue;
		}
		let tmpStand = tmpSwap[tmpEntry.Operator];
		tmpSwapped.push({ Operator: tmpEntry.Operator, Parameter: tmpEntry.Parameter, Stand: tmpStand });
		tmpEntry.Operator = tmpStand;
		tmpEntry.Parameter = `${(typeof(tmpEntry.Parameter) === 'string') ? tmpEntry.Parameter : ''}${SWAP_MARKER}`;
	}
	return (tmpSwapped.length > 0) ? { Swapped: tmpSwapped } : null;
};

/**
 * Undo applyFenceSwap on the post-behavior filter: the marked entries, in order, get their original
 * operator and Parameter back.  False (the capture is Opaque, FilterRewritten) when the behavior
 * dropped, duplicated or re-operated a marked entry.
 *
 * @param {Record<string, any>|null} pSwap - applyFenceSwap()
 * @param {any} pQuery
 * @return {boolean} intact
 */
const restoreFenceSwap = (pSwap, pQuery) =>
{
	if (!pSwap)
	{
		return true;
	}
	let tmpFilter = (pQuery && pQuery.parameters && Array.isArray(pQuery.parameters.filter)) ? pQuery.parameters.filter : [];
	let tmpMarked = tmpFilter.filter((pEntry) => { return !!pEntry && (typeof(pEntry.Parameter) === 'string') && pEntry.Parameter.endsWith(SWAP_MARKER); });
	let tmpIntact = (tmpMarked.length === pSwap.Swapped.length);
	for (let i = 0; i < tmpMarked.length; i++)
	{
		let tmpOriginal = (i < pSwap.Swapped.length) ? pSwap.Swapped[i] : null;
		if (!tmpOriginal || (tmpMarked[i].Operator !== tmpOriginal.Stand) || (tmpMarked[i].Value !== null)
			|| (tmpMarked[i].Parameter !== `${(typeof(tmpOriginal.Parameter) === 'string') ? tmpOriginal.Parameter : ''}${SWAP_MARKER}`))
		{
			tmpIntact = false;
		}
		// Restore regardless (a rewritten capture is refused anyway; never leave a marker in SQL).
		if (tmpOriginal)
		{
			tmpMarked[i].Operator = tmpOriginal.Operator;
			tmpMarked[i].Parameter = tmpOriginal.Parameter;
		}
	}
	return tmpIntact;
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
	 * Host wraps (internal-contracts §75.4, F1) are peeled before the index-aligned diff: a host layer
	 * that grouped the whole prior filter in bare parens and appended after them (RAFS's tenancy fence)
	 * is not a rewrite.  Indexes (Transformed) stay in the pre-behavior filter's index space; Depths
	 * are those of the FINAL filter (the wrap puts every faceting entry at depth >= 1, the host
	 * predicates at depth 0).
	 *
	 * @param {Record<string, any>} pBefore - snapshot()
	 * @param {any} pQuery
	 * @param {{ SwapIntact?: boolean }} [pOptions] - SwapIntact false: the fence swap found a marked entry rewritten (Opaque)
	 * @return {{ PostBehaviorFilter: Array<Record<string, any>>, Appended: Array<Record<string, any>>, Transformed: Array<Record<string, any>>, Opaque: boolean, OpaqueReasons: Array<string>, Portable: boolean, HostWraps: number }}
	 */
	analyze(pBefore, pQuery, pOptions)
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
		if (pOptions && (pOptions.SwapIntact === false))
		{
			fReason('FilterRewritten');
		}

		// F1: peel the host's bare wrap layers (null: none, or the inside does not align → M1 rule).
		let tmpPeel = peelHostWraps(pBefore.Filter, tmpFilter);
		let tmpInsideStart = tmpPeel ? tmpPeel.Start : 0;
		let tmpInsideEnd = tmpPeel ? tmpPeel.End : tmpFilter.length;

		let tmpTransformed = [];
		if ((tmpInsideEnd - tmpInsideStart) < pBefore.Filter.length)
		{
			fReason('FilterRewritten');
		}
		for (let i = 0; (i < pBefore.Filter.length) && ((tmpInsideStart + i) < tmpInsideEnd); i++)
		{
			let tmpWas = pBefore.Filter[i];
			let tmpIs = tmpFilter[tmpInsideStart + i];
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
		let fAppend = (pStart, pEnd) =>
		{
			for (let i = pStart; i < pEnd; i++)
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
		};
		// What a behavior inside the innermost wrap appended, then each wrap layer's own, innermost first.
		fAppend(tmpInsideStart + pBefore.Filter.length, tmpInsideEnd);
		if (tmpPeel)
		{
			tmpPeel.LayerRanges.forEach((pRange) => { fAppend(pRange.Start, pRange.End); });
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
				Portable: (tmpReasons.length < 1),
				HostWraps: tmpPeel ? tmpPeel.HostWraps : 0
			});
	}

	/**
	 * 'sf:' + first 12 hex of sha256(Entity | canonical(Appended) | canonical(Transformed) | Behavior | ScopeMode).
	 *
	 * @param {Record<string, any>} pCapture
	 * (+ 'hw<n>' when host wraps were peeled, §75.4)
	 *
	 * @param {string} pScopeMode
	 * @return {string}
	 */
	fingerprint(pCapture, pScopeMode)
	{
		let tmpParts = [ pCapture.Entity, canonicalJSON(pCapture.Appended), canonicalJSON(pCapture.Transformed), pCapture.Behavior, pScopeMode ];
		if ((typeof(pCapture.HostWraps) === 'number') && (pCapture.HostWraps > 0))
		{
			// §75.4: the peeled host wraps are part of the material (absent on hosts that never wrap, so
			// their fingerprints are unchanged).
			tmpParts.push(`hw${pCapture.HostWraps}`);
		}
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

		// F2 (§75.4): the host fence refuses operators faceting renders (RAFS: 'IS' + null on SQLite);
		// swap them for the behavior run only, and restore before the after-snapshot.
		let tmpSwap = applyFenceSwap(tmpHost, pQuery);

		let fContinue = (pBehaviorError) =>
		{
			let tmpSwapIntact = restoreFenceSwap(tmpSwap, pQuery);
			if (pBehaviorError)
			{
				// One mapping for every engine (the Reference uses the same function).
				// (A host 400 over a faceting-rendered filter — e.g. a fence refusal — is FACET_INTERNAL: a
				// faceting defect, never a client error, §75.4.)
				let tmpMapped = libFacetErrors.fromBehaviorError(pBehaviorError);
				if (tmpMapped.Code === 'FACET_INTERNAL')
				{
					let tmpStatus = (pBehaviorError && (typeof(pBehaviorError) === 'object')) ? (pBehaviorError.StatusCode || pBehaviorError.statusCode || '') : '';
					this.fable.log.error(`RetoldFaceting ScopeCapture: the ${tmpBehavior} behavior of ${pEntity} failed${tmpStatus ? ` (${tmpStatus})` : ''}.`);
				}
				return fCallback(tmpMapped);
			}
			return this._finishCapture(tmpContext, pEntity, pQuery, tmpScopeMode, tmpBehavior, tmpBehaviorRan, tmpBefore, tmpMemoKey, tmpScopeGuard, tmpPostOperation, tmpState, fCallback, { SwapIntact: tmpSwapIntact });
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
	 * @param {{ SwapIntact?: boolean }} [pAnalyzeOptions] - the fence swap's restore result (§75.4)
	 */
	_finishCapture(pContext, pEntity, pQuery, pScopeMode, pBehavior, pBehaviorRan, pBefore, pMemoKey, pScopeGuard, pPostOperation, pState, fCallback, pAnalyzeOptions)
	{
		let tmpAnalysis = this.analyze(pBefore, pQuery, pAnalyzeOptions);
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
				// §75.4: how many host wrap layers (bare outer groups) were peeled before the diff.
				HostWraps: tmpAnalysis.HostWraps,
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
// The fence swap (§75.4) is shared the same way: every path that runs a host Reads behavior over a
// faceting-rendered filter brackets the run with it (the Reference engine's list waterfall included).
RetoldFacetingScopeCapture.applyFenceSwap = applyFenceSwap;
RetoldFacetingScopeCapture.restoreFenceSwap = restoreFenceSwap;

module.exports = RetoldFacetingScopeCapture;
module.exports.serviceType = 'RetoldFacetingScopeCapture';
module.exports.PORTABLE_OPERATORS = PORTABLE_OPERATORS;
module.exports.SCOPE_MODES = SCOPE_MODES;
module.exports.REPLACING_REASONS = REPLACING_REASONS;
module.exports.READ_SIDE_BEHAVIORS = READ_SIDE_BEHAVIORS;
module.exports.POST_OPERATION_REASON = POST_OPERATION_REASON;
module.exports.relaxPersonalScope = relaxPersonalScope;
module.exports.SWAP_MARKER = SWAP_MARKER;
module.exports.peelHostWraps = peelHostWraps;
module.exports.applyFenceSwap = applyFenceSwap;
module.exports.restoreFenceSwap = restoreFenceSwap;
module.exports.entryDepths = entryDepths;
module.exports.canonicalJSON = canonicalJSON;
module.exports.stripColumn = stripColumn;
