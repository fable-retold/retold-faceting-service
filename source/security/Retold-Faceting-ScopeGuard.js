/**
 * Retold Faceting - Scope Guard
 *
 * The independent assertion that the declared tenancy policy is actually present in a captured
 * scope (06 §3.3, D-06): a depth-0 '=' AND entry per required column with the principal's own,
 * set value, no depth-0 OR, a balanced fence.  Strict refuses; Repair fixes only an absent
 * predicate; Off checks nothing (only without a policy).  Fails closed.
 *
 * Scope values are compared after normalization (Retold-Faceting-Util.normalizeScopeValue), and a
 * required value that normalizes to an unset value ('0', ' 0', false, '') never satisfies the guard.
 *
 * M2: a 'TenantOnly' capture is asserted against the required set MINUS the entity's personal-scope
 * column, and no entry may name that column any more (PersonalColumnPresent).  An Opaque capture is
 * refused (OpaqueUntrusted) unless ScopeCapture marked it Trusted (Scope.TrustedOpaque); a trusted
 * capture whose behavior replaced the query defers its column checks to the staged run (Deferred).
 *
 * Contract: internal-contracts §8.2, §26.2, §26.3.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

const GUARD_MODES = Object.freeze([ 'Strict', 'Repair', 'Off' ]);

const stripColumn = libRetoldFacetingUtil.stripColumn;

/**
 * Paren depth of every filter entry ('(' and ')' sit at the depth OUTSIDE their group) and whether
 * the parens balance (never below zero, zero at the end).
 *
 * @param {Array<Record<string, any>>} pFilter
 * @return {{ Depths: Array<number>, Balanced: boolean }}
 */
const filterDepths = (pFilter) =>
{
	let tmpDepth = 0;
	let tmpBalanced = true;
	let tmpDepths = [];
	for (let i = 0; i < pFilter.length; i++)
	{
		let tmpOperator = pFilter[i] ? pFilter[i].Operator : null;
		if (tmpOperator === ')')
		{
			tmpDepth--;
			if (tmpDepth < 0)
			{
				tmpBalanced = false;
				tmpDepth = 0;
			}
			tmpDepths.push(tmpDepth);
		}
		else if (tmpOperator === '(')
		{
			tmpDepths.push(tmpDepth);
			tmpDepth++;
		}
		else
		{
			tmpDepths.push(tmpDepth);
		}
	}
	if (tmpDepth !== 0)
	{
		tmpBalanced = false;
	}
	return { Depths: tmpDepths, Balanced: tmpBalanced };
};

/**
 * Is the client fence intact?  Every 'FacetFenceOpen' entry must sit at the base depth and be closed
 * by the 'FacetFenceClose' entry that returns to it.  The base depth is 0, or the number of host wrap
 * layers ScopeCapture peeled (internal-contracts §75.4: a host that grouped the whole prior filter puts
 * the client fence one level down per layer).
 *
 * @param {Array<Record<string, any>>} pFilter
 * @param {Array<number>} pDepths
 * @param {number} [pBaseDepth] - default 0
 * @return {boolean}
 */
const fenceIntact = (pFilter, pDepths, pBaseDepth) =>
{
	let tmpBase = ((typeof(pBaseDepth) === 'number') && Number.isInteger(pBaseDepth) && (pBaseDepth > 0)) ? pBaseDepth : 0;
	for (let i = 0; i < pFilter.length; i++)
	{
		if (!pFilter[i] || (pFilter[i].Parameter !== 'FacetFenceOpen'))
		{
			continue;
		}
		if ((pFilter[i].Operator !== '(') || (pDepths[i] !== tmpBase))
		{
			return false;
		}
		let tmpClosed = false;
		for (let j = i + 1; j < pFilter.length; j++)
		{
			if ((pFilter[j].Operator === ')') && (pDepths[j] === tmpBase))
			{
				if (pFilter[j].Parameter !== 'FacetFenceClose')
				{
					return false;
				}
				tmpClosed = true;
				break;
			}
		}
		if (!tmpClosed)
		{
			return false;
		}
	}
	return true;
};

/**
 * Scope value equality after normalization (session numbers vs. behavior strings, ' 7' vs 7).
 *
 * @param {any} pA
 * @param {any} pB
 * @return {boolean}
 */
const sameScopeValue = (pA, pB) =>
{
	let tmpA = libRetoldFacetingUtil.normalizeScopeValue(pA);
	let tmpB = libRetoldFacetingUtil.normalizeScopeValue(pB);
	return (tmpA !== null) && (tmpA === tmpB);
};

class RetoldFacetingScopeGuard extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingScopeGuard';
	}

	/**
	 * The policy for this request (Host.getScopePolicy(), §8.3), or a 'None' policy.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	policyFor(pContext)
	{
		let tmpHost = (pContext && pContext.Host) ? pContext.Host : null;
		let tmpPolicy = (tmpHost && (typeof(tmpHost.getScopePolicy) === 'function')) ? tmpHost.getScopePolicy() : null;
		if ((typeof(tmpPolicy) !== 'object') || (tmpPolicy === null))
		{
			return { Kind: 'None', Required: {}, UnsetValues: [ 0, '', null ], Guard: 'Off', requiredFor: () => { return []; }, isScoped: () => { return false; } };
		}
		return tmpPolicy;
	}

	/**
	 * The effective guard mode: 'Off' without a policy; a policy never runs 'Off' (fails closed to Strict).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPolicy
	 * @return {string}
	 */
	modeFor(pContext, pPolicy)
	{
		let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
		let tmpConfigured = (typeof(pPolicy.Guard) === 'string') ? pPolicy.Guard
			: ((tmpOptions.Scope && (typeof(tmpOptions.Scope.Guard) === 'string')) ? tmpOptions.Scope.Guard : 'Strict');
		if (pPolicy.Kind === 'None')
		{
			return 'Off';
		}
		if ((GUARD_MODES.indexOf(tmpConfigured) < 0) || (tmpConfigured === 'Off'))
		{
			return 'Strict';
		}
		return tmpConfigured;
	}

	/**
	 * Assert (and, in Repair mode, repair) the policy on a query whose behaviors already ran.
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 (uses Host, Principal, Options)
	 * @param {string} pEntity
	 * @param {any} pQuery - the FoxHound query (mutated only by a Repair)
	 * @param {Record<string, any>} pCapture - the capture so far (Opaque flag)
	 * @return {{ Mode: string, Required: Array<{ Column: string, Value: any }>, Satisfied: boolean, Repaired: boolean, Violations: Array<{ Rule: string, Column?: string }> }}
	 */
	assert(pContext, pEntity, pQuery, pCapture)
	{
		let tmpPolicy = this.policyFor(pContext);
		let tmpMode = this.modeFor(pContext, tmpPolicy);
		let tmpResult = { Mode: tmpMode, Required: [], Satisfied: true, Repaired: false, Violations: [] };
		if (tmpMode === 'Off')
		{
			return tmpResult;
		}

		let tmpPrincipal = (pContext && pContext.Principal) ? pContext.Principal : null;
		let tmpRequired = (typeof(tmpPolicy.requiredFor) === 'function') ? tmpPolicy.requiredFor(pEntity, tmpPrincipal) : [];
		tmpResult.Required = Array.isArray(tmpRequired) ? tmpRequired.map((pEntry) => { return { Column: pEntry.Column, Value: pEntry.Value }; }) : [];
		let tmpUnsetValues = Array.isArray(tmpPolicy.UnsetValues) ? tmpPolicy.UnsetValues : [ 0, '', null ];

		let tmpFilter = (pQuery && pQuery.parameters && Array.isArray(pQuery.parameters.filter)) ? pQuery.parameters.filter : [];
		let tmpShape = filterDepths(tmpFilter);

		// TenantOnly (internal-contracts §26.2): the personal column is no longer required, and no entry
		// may name it any more (the relaxation removed exactly one; anything left is a leak).
		if (pCapture && (pCapture.ScopeMode === 'TenantOnly'))
		{
			let tmpPersonal = (tmpPolicy.PersonalScopes && Object.prototype.hasOwnProperty.call(tmpPolicy.PersonalScopes, pEntity)) ? tmpPolicy.PersonalScopes[pEntity] : null;
			let tmpPersonalColumn = (tmpPersonal && (typeof(tmpPersonal.Column) === 'string')) ? tmpPersonal.Column : null;
			tmpResult.Relaxed = (tmpPersonalColumn !== null);
			if (tmpPersonalColumn !== null)
			{
				tmpResult.Required = tmpResult.Required.filter((pEntry) => { return pEntry.Column !== tmpPersonalColumn; });
				for (let i = 0; i < tmpFilter.length; i++)
				{
					if ((tmpFilter[i].Operator !== '(') && (tmpFilter[i].Operator !== ')') && (stripColumn(tmpFilter[i].Column) === tmpPersonalColumn))
					{
						tmpResult.Violations.push({ Rule: 'PersonalColumnPresent', Column: tmpPersonalColumn });
						break;
					}
				}
			}
			if (tmpResult.Required.length < 1)
			{
				// Fail closed (06 §4.4): a relaxation that leaves no required column (an entity whose only
				// policy column is its personal scope) would read every tenant's rows.
				tmpResult.Violations.push({ Rule: 'TenantOnlyUnscoped' });
			}
		}

		// An Opaque capture is refused unless its entity is trusted (Scope.TrustedOpaque, set on the
		// capture by ScopeCapture): a trusted one may run Staged.  A trusted capture whose behavior
		// REPLACED the query is still asserted on its filter here (the filter is what its template's
		// one '<%= Where %>' renders); the staged run then also asserts the rendered SQL binds every
		// policy entry exactly (internal-contracts §26.3).
		let tmpTrustedOpaque = !!(pCapture && pCapture.Opaque && (pCapture.Trusted === true));
		if (pCapture && pCapture.Opaque && !tmpTrustedOpaque)
		{
			tmpResult.Violations.push({ Rule: 'OpaqueUntrusted' });
		}
		if (tmpTrustedOpaque && (pCapture.Replaced === true))
		{
			// (Only present when true, so M1 guard results keep their exact shape.)
			tmpResult.Deferred = true;
		}
		let tmpHostWraps = (pCapture && (typeof(pCapture.HostWraps) === 'number')) ? pCapture.HostWraps : 0;
		if (!tmpShape.Balanced || !fenceIntact(tmpFilter, tmpShape.Depths, tmpHostWraps))
		{
			tmpResult.Violations.push({ Rule: 'UnbalancedFence' });
		}

		// A policy entry must name this entity's own table when it is qualified at all ('Other.IDCustomer'
		// on a joined capture is another table's column, never this entity's scope).
		let tmpTable = (pQuery && pQuery.parameters && (typeof(pQuery.parameters.scope) === 'string')) ? pQuery.parameters.scope.replace(/["`[\]\s]/g, '') : pEntity;
		let fOwnColumn = (pEntry, pColumn) =>
		{
			if (stripColumn(pEntry.Column) !== pColumn)
			{
				return false;
			}
			let tmpQualifier = libRetoldFacetingUtil.columnQualifier(pEntry.Column);
			return (tmpQualifier === null) || (tmpQualifier === tmpTable);
		};

		let tmpTenantOnly = !!(pCapture && (pCapture.ScopeMode === 'TenantOnly'));
		if ((tmpResult.Required.length > 0) || tmpTenantOnly)
		{
			// (3) no EMITTED depth-0 connector other than AND (FoxHound drops the first entry's connector
			// and never emits one before ')'; anything else is spliced into the SQL verbatim).
			for (let i = 1; i < tmpFilter.length; i++)
			{
				if ((tmpShape.Depths[i] !== 0) || (tmpFilter[i].Operator === ')'))
				{
					continue;
				}
				if (String(tmpFilter[i].Connector).toUpperCase() !== 'AND')
				{
					tmpResult.Violations.push({ Rule: 'DepthZeroOr' });
					break;
				}
			}

			// (1) + (2) per required column
			for (let i = 0; i < tmpResult.Required.length; i++)
			{
				let tmpColumn = tmpResult.Required[i].Column;
				let tmpValue = tmpResult.Required[i].Value;
				if (libRetoldFacetingUtil.isUnsetScopeValue(tmpValue, tmpUnsetValues))
				{
					tmpResult.Violations.push({ Rule: 'UnsetValue', Column: tmpColumn });
					continue;
				}
				let tmpCandidates = [];
				for (let j = 0; j < tmpFilter.length; j++)
				{
					if ((tmpShape.Depths[j] === 0)
						&& (tmpFilter[j].Operator === '=')
						&& (String(tmpFilter[j].Connector).toUpperCase() === 'AND')
						&& fOwnColumn(tmpFilter[j], tmpColumn))
					{
						tmpCandidates.push(tmpFilter[j]);
					}
				}
				if (tmpCandidates.length < 1)
				{
					tmpResult.Violations.push({ Rule: 'MissingPredicate', Column: tmpColumn });
				}
				else if (!tmpCandidates.some((pEntry) => { return sameScopeValue(pEntry.Value, tmpValue); }))
				{
					tmpResult.Violations.push({ Rule: 'WrongValue', Column: tmpColumn });
				}
			}
		}

		if (tmpResult.Violations.length < 1)
		{
			return tmpResult;
		}

		let tmpOnlyMissing = tmpResult.Violations.every((pViolation) => { return pViolation.Rule === 'MissingPredicate'; });
		if ((tmpMode === 'Repair') && tmpOnlyMissing && pQuery && (typeof(pQuery.addFilter) === 'function'))
		{
			this.repair(pQuery, tmpResult);
			this.fable.log.error(`RetoldFaceting ScopeGuard REPAIRED the scope of ${pEntity}: the host behaviors did not apply [${tmpResult.Violations.map((pViolation) => { return pViolation.Column; }).join(', ')}].`);
			tmpResult.Repaired = true;
			tmpResult.Satisfied = true;
			return tmpResult;
		}

		tmpResult.Satisfied = false;
		return tmpResult;
	}

	/**
	 * Repair: wrap the whole post-behavior filter in a new depth-0 group, then append each missing
	 * policy predicate at depth 0 (06 §3.3).  Only ever called when every violation is MissingPredicate.
	 *
	 * @param {any} pQuery
	 * @param {Record<string, any>} pGuardResult
	 */
	repair(pQuery, pGuardResult)
	{
		let tmpFilter = Array.isArray(pQuery.parameters.filter) ? pQuery.parameters.filter : [];
		if (tmpFilter.length > 0)
		{
			pQuery.parameters.filter = [ { Column: '', Operator: '(', Value: '', Connector: 'AND', Parameter: 'FacetRepairOpen' } ]
				.concat(tmpFilter, [ { Column: '', Operator: ')', Value: '', Connector: 'AND', Parameter: 'FacetRepairClose' } ]);
		}
		for (let i = 0; i < pGuardResult.Violations.length; i++)
		{
			let tmpColumn = pGuardResult.Violations[i].Column;
			let tmpRequired = pGuardResult.Required.find((pEntry) => { return pEntry.Column === tmpColumn; });
			pQuery.addFilter(tmpColumn, tmpRequired.Value, '=', 'AND', `FacetPolicy${tmpColumn}`);
		}
	}
}

module.exports = RetoldFacetingScopeGuard;
module.exports.serviceType = 'RetoldFacetingScopeGuard';
module.exports.GUARD_MODES = GUARD_MODES;
module.exports.stripColumn = stripColumn;
module.exports.filterDepths = filterDepths;
module.exports.fenceIntact = fenceIntact;
