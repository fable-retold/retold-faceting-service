/**
 * Retold Faceting - Principal Resolver
 *
 * Resolves the Principal for a request through the host (06 §2), then fails closed before any entity
 * check, catalog lookup or SQL (06 §5.2 / §11):
 *
 *   - no scope policy and a host that does not authenticate: every principal passes (plain RDS:
 *     facets equal anonymous lists);
 *   - a policy, or a host that authenticates (Host.authenticationRequired(), e.g. a RAFS app with
 *     orator-authentication and no tenancy), and an Anonymous principal: 401 FACET_UNAUTHENTICATED
 *     unless the root entity is in Catalog.AllowAnonymous (a server-side allowlist; Describe without an
 *     entity passes only when that allowlist is non-empty, and then describes only its entities);
 *   - a policy and any other principal: 401 when the tenancy column (Policy.Column, every route) or
 *     one of the ROOT entity's own required columns (its PersonalScopes column, its Required columns)
 *     holds an unset value (Scope.UnsetValues, plus 0 / '' / null / false after normalization).  Another
 *     entity's owner / Required column never fails a request that does not reference it; a referenced
 *     non-root entity whose requirements are unset is denied by the Authorizer (403 hop, unlabeled
 *     label target), so the per-entity rule holds on every reference.  An unknown root has no
 *     requirements beyond the tenancy column, and is then 404 like a hidden one;
 *   - a principal whose host could not compute one of the root's required columns
 *     (Principal.UnresolvedScopeColumns: an app getValue threw) is 500 FACET_INTERNAL.
 *
 * The 401 carries no Detail; the unset column names go to the server log only.
 *
 * Contract: internal-contracts §12.2.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

class RetoldFacetingPrincipalResolver extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingPrincipalResolver';
	}

	/**
	 * Resolve pContext.Request through pContext.Host (pContext.Principal is not set yet).
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 (uses Host, Request, Options, Entity)
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	resolve(pContext, fCallback)
	{
		let tmpHost = pContext ? pContext.Host : null;
		if (!tmpHost || (typeof(tmpHost.resolvePrincipal) !== 'function'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service has no host.'));
		}
		tmpHost.resolvePrincipal(pContext.Request,
			(pError, pPrincipal) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pPrincipal || (typeof(pPrincipal) !== 'object'))
				{
					return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The host resolved no principal.'));
				}
				let tmpUnresolved = this.unresolvedColumns(pContext, pPrincipal);
				if (tmpUnresolved.length > 0)
				{
					this.fable.log.error(`RetoldFaceting request ${pContext.RequestID || '?'}: the host could not compute the scope value(s) [${tmpUnresolved.join(', ')}] the root entity needs.`);
					return fCallback(libFacetErrors.create('FACET_INTERNAL'));
				}
				let tmpRefusal = this.refusal(pContext, pPrincipal);
				if (tmpRefusal)
				{
					// Column names and reasons are logged, never sent (06 §2.2, §11).
					this.fable.log.info(`RetoldFaceting request ${pContext.RequestID || '?'} unauthenticated: ${tmpRefusal}`);
					return fCallback(libFacetErrors.create('FACET_UNAUTHENTICATED'));
				}
				return fCallback(null, pPrincipal);
			});
	}

	/**
	 * Every column the scope policy can require of a principal (the union over all entities).
	 *
	 * @param {Record<string, any>} pPolicy - Host.getScopePolicy()
	 * @return {Array<string>}
	 */
	policyColumns(pPolicy)
	{
		let tmpColumns = [];
		let fAdd = (pColumn) =>
		{
			if ((typeof(pColumn) === 'string') && (pColumn.length > 0) && (tmpColumns.indexOf(pColumn) < 0))
			{
				tmpColumns.push(pColumn);
			}
		};
		fAdd(pPolicy.Column);
		let tmpPersonal = libRetoldFacetingUtil.isPlainObject(pPolicy.PersonalScopes) ? pPolicy.PersonalScopes : {};
		Object.keys(tmpPersonal).forEach((pEntity) => { fAdd(tmpPersonal[pEntity] ? tmpPersonal[pEntity].Column : null); });
		let tmpRequired = libRetoldFacetingUtil.isPlainObject(pPolicy.Required) ? pPolicy.Required : {};
		Object.keys(tmpRequired).forEach(
			(pEntity) =>
			{
				(Array.isArray(tmpRequired[pEntity]) ? tmpRequired[pEntity] : []).forEach((pEntry) => { fAdd(pEntry ? pEntry.Column : null); });
			});
		return tmpColumns;
	}

	/**
	 * The columns a request on pEntity needs from a principal: the tenancy column (every route), then
	 * the entity's own required columns (PersonalScopes, Required) when the route names one.
	 *
	 * @param {Record<string, any>} pPolicy - Host.getScopePolicy()
	 * @param {string|null} pEntity
	 * @return {Array<string>}
	 */
	requiredColumns(pPolicy, pEntity)
	{
		let tmpColumns = [];
		let fAdd = (pColumn) =>
		{
			if ((typeof(pColumn) === 'string') && (pColumn.length > 0) && (tmpColumns.indexOf(pColumn) < 0))
			{
				tmpColumns.push(pColumn);
			}
		};
		fAdd(pPolicy.Column);
		if ((typeof(pEntity) === 'string') && (pEntity.length > 0) && (typeof(pPolicy.requiredFor) === 'function'))
		{
			pPolicy.requiredFor(pEntity, null).forEach((pEntry) => { fAdd(pEntry ? pEntry.Column : null); });
		}
		return tmpColumns;
	}

	/**
	 * The root entity's required columns the host could not compute for this principal
	 * (Principal.UnresolvedScopeColumns, non-enumerable; an app getValue threw).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPrincipal
	 * @return {Array<string>}
	 */
	unresolvedColumns(pContext, pPrincipal)
	{
		let tmpUnresolved = Array.isArray(pPrincipal.UnresolvedScopeColumns) ? pPrincipal.UnresolvedScopeColumns : [];
		if (tmpUnresolved.length < 1)
		{
			return [];
		}
		let tmpPolicy = (typeof(pContext.Host.getScopePolicy) === 'function') ? pContext.Host.getScopePolicy() : null;
		if (!tmpPolicy || (tmpPolicy.Kind !== 'Policy'))
		{
			return [];
		}
		let tmpEntity = ((typeof(pContext.Entity) === 'string') && (pContext.Entity.length > 0)) ? pContext.Entity : null;
		return this.requiredColumns(tmpPolicy, tmpEntity).filter((pColumn) => { return tmpUnresolved.indexOf(pColumn) >= 0; });
	}

	/**
	 * Does the host authenticate its users (Host.authenticationRequired())?  Anonymous principals are
	 * then refused even without a scope policy.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {boolean}
	 */
	authenticatingHost(pContext)
	{
		let tmpHost = pContext ? pContext.Host : null;
		return !!tmpHost && (typeof(tmpHost.authenticationRequired) === 'function') && (tmpHost.authenticationRequired() === true);
	}

	/**
	 * Why this principal is refused (a log string), or null when it may proceed.  Never depends on
	 * whether the route entity exists or is facetable.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPrincipal
	 * @return {string|null}
	 */
	refusal(pContext, pPrincipal)
	{
		let tmpPolicy = (typeof(pContext.Host.getScopePolicy) === 'function') ? pContext.Host.getScopePolicy() : null;
		let tmpPolicyHost = !!tmpPolicy && (tmpPolicy.Kind === 'Policy');
		let tmpAuthenticating = this.authenticatingHost(pContext);
		if (!tmpPolicyHost && !tmpAuthenticating)
		{
			return null;
		}
		let tmpOptions = pContext.Options || this.options;
		let tmpEntity = ((typeof(pContext.Entity) === 'string') && (pContext.Entity.length > 0)) ? pContext.Entity : null;
		if (pPrincipal.Kind === 'Anonymous')
		{
			let tmpAllowAnonymous = (tmpOptions.Catalog && Array.isArray(tmpOptions.Catalog.AllowAnonymous)) ? tmpOptions.Catalog.AllowAnonymous : [];
			let tmpAllowed = tmpEntity ? (tmpAllowAnonymous.indexOf(tmpEntity) >= 0) : (tmpAllowAnonymous.length > 0);
			if (!tmpAllowed)
			{
				return tmpPolicyHost ? 'anonymous principal on a scope-policy host' : 'anonymous principal on an authenticating host';
			}
			if (!tmpPolicyHost)
			{
				return null;
			}
			// An allowlisted entity is server-declared, so its own requirements may be consulted.
			let tmpUnset = this.unsetColumns(tmpEntity ? tmpPolicy.requiredFor(tmpEntity, pPrincipal) : [], tmpPolicy, tmpOptions);
			return (tmpUnset.length > 0) ? `unset scope value(s) [${tmpUnset.join(', ')}]` : null;
		}
		if (!tmpPolicyHost)
		{
			return null;
		}
		let tmpScopeValues = libRetoldFacetingUtil.isPlainObject(pPrincipal.ScopeValues) ? pPrincipal.ScopeValues : {};
		let tmpRequired = this.requiredColumns(tmpPolicy, tmpEntity).map(
			(pColumn) =>
			{
				return { Column: pColumn, Value: libRetoldFacetingUtil.hasOwn(tmpScopeValues, pColumn) ? tmpScopeValues[pColumn] : null };
			});
		let tmpUnset = this.unsetColumns(tmpRequired, tmpPolicy, tmpOptions);
		return (tmpUnset.length > 0) ? `unset scope value(s) [${tmpUnset.join(', ')}]` : null;
	}

	/**
	 * The columns of pRequired whose value is unset.
	 *
	 * @param {Array<{ Column: string, Value: any }>} pRequired
	 * @param {Record<string, any>} pPolicy
	 * @param {Record<string, any>} pOptions
	 * @return {Array<string>}
	 */
	unsetColumns(pRequired, pPolicy, pOptions)
	{
		let tmpUnsetValues = Array.isArray(pPolicy.UnsetValues) ? pPolicy.UnsetValues
			: (pOptions.Scope && Array.isArray(pOptions.Scope.UnsetValues)) ? pOptions.Scope.UnsetValues
			: [];
		return (Array.isArray(pRequired) ? pRequired : [])
			.filter((pEntry) => { return libRetoldFacetingUtil.isUnsetScopeValue(pEntry.Value, tmpUnsetValues); })
			.map((pEntry) => { return pEntry.Column; });
	}
}

module.exports = RetoldFacetingPrincipalResolver;
module.exports.serviceType = 'RetoldFacetingPrincipalResolver';
