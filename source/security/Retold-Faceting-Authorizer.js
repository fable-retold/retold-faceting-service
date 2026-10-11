/**
 * Retold Faceting - Authorizer
 *
 * Gates every referenced entity before field validation, planning or SQL (06 §5): Host.isFacetable
 * plus read permission.  Plain RDS (Authorization.Strategy 'Auto' → 'None'): facetable means readable.
 * Root entity failures are 404 FACET_UNKNOWN_ENTITY (indistinguishable from nonexistent).
 *
 * canRead is also what Describe filters by (entities and FK Targets), so Describe never lists an
 * entity the principal could not query.  On a scope-policy host, and on a host that authenticates
 * (Host.authenticationRequired()), an Anonymous principal can read only the entities in
 * Catalog.AllowAnonymous (06 §5.1 rule 5).  On a scope-policy host an entity whose own scope
 * requirements the principal cannot meet (an unset owner / Required value, or one the host could not
 * compute) is not readable: the PrincipalResolver answered 401 for such a root already, so this
 * denies it as a hop, scope, join or label target (per-entity, never a whole-request 401).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

class RetoldFacetingAuthorizer extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingAuthorizer';
	}

	/**
	 * Check read access to every entity.
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2 (uses Host, Principal)
	 * @param {Array<string>} pEntities - [ root, … ]
	 * @param {(pError?: Error, pResult?: { Allowed: Array<string>, Denied: Array<string> }) => void} fCallback
	 */
	check(pContext, pEntities, fCallback)
	{
		let tmpHost = pContext ? pContext.Host : null;
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		if (!tmpHost || !tmpCatalog)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The authorizer is not wired.'));
		}
		let tmpEntities = Array.isArray(pEntities) ? pEntities : [];
		let tmpResult = { Allowed: [], Denied: [] };
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			let tmpAllowed = this.canFacet(pContext, tmpEntity);
			if (tmpAllowed)
			{
				tmpResult.Allowed.push(tmpEntity);
			}
			else
			{
				tmpResult.Denied.push(tmpEntity);
			}
		}
		if ((tmpEntities.length > 0) && (tmpResult.Denied.indexOf(tmpEntities[0]) >= 0))
		{
			// The root: indistinguishable from an entity that does not exist (06 §5).
			return fCallback(libFacetErrors.create('FACET_UNKNOWN_ENTITY'));
		}
		return fCallback(null, tmpResult);
	}

	/**
	 * The one synchronous per-entity gate every M2 caller uses for hops, tuple sides, named-scope
	 * entities, join-clause targets and label targets (internal-contracts §19.6): facetable on the
	 * host for this principal, in the catalog, and readable.  check() applies the same test.
	 *
	 * @param {Record<string, any>} pContext - uses Host, Principal, Options
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	canFacet(pContext, pEntity)
	{
		let tmpHost = pContext ? pContext.Host : null;
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		if (!tmpHost || !tmpCatalog || (typeof(pEntity) !== 'string'))
		{
			return false;
		}
		return tmpHost.isFacetable(pEntity, pContext.Principal)
			&& !!tmpCatalog.getFacetable(pEntity)
			&& this.canRead(pContext, pEntity);
	}

	/**
	 * Read permission beyond isFacetable.  Plain RDS has no entitlements (Host.getAuthorizer() is
	 * null, Strategy 'None'): facetable means readable.  A host authorizer is a later milestone
	 * (RAFS entitlements); it is consulted when present and fails closed when it throws.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	canRead(pContext, pEntity)
	{
		let tmpPolicy = (typeof(pContext.Host.getScopePolicy) === 'function') ? pContext.Host.getScopePolicy() : null;
		let tmpPolicyHost = !!tmpPolicy && (tmpPolicy.Kind === 'Policy');
		let tmpAuthenticating = (typeof(pContext.Host.authenticationRequired) === 'function') && (pContext.Host.authenticationRequired() === true);
		let tmpOptions = pContext.Options || this.options;
		if ((tmpPolicyHost || tmpAuthenticating) && (!pContext.Principal || (pContext.Principal.Kind === 'Anonymous')))
		{
			let tmpAllowAnonymous = (tmpOptions.Catalog && Array.isArray(tmpOptions.Catalog.AllowAnonymous)) ? tmpOptions.Catalog.AllowAnonymous : [];
			if (tmpAllowAnonymous.indexOf(pEntity) < 0)
			{
				return false;
			}
		}
		if (tmpPolicyHost && !this.meetsScopeRequirements(tmpPolicy, pEntity, pContext.Principal, tmpOptions))
		{
			return false;
		}
		let tmpAuthorizer = (typeof(pContext.Host.getAuthorizer) === 'function') ? pContext.Host.getAuthorizer() : null;
		if (!tmpAuthorizer || (typeof(tmpAuthorizer.canRead) !== 'function'))
		{
			return true;
		}
		try
		{
			return (tmpAuthorizer.canRead(pEntity, pContext.Principal) === true);
		}
		catch (pAuthorizerError)
		{
			this.fable.log.error(`RetoldFaceting Authorizer: the host authorizer failed for ${pEntity}: ${pAuthorizerError.message}`);
			return false;
		}
	}

	/**
	 * Does the principal carry a set value for every scope column the entity requires (its tenancy,
	 * PersonalScopes and Required columns), none of them one the host could not compute?
	 *
	 * @param {Record<string, any>} pPolicy - a Kind 'Policy' scope policy
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPrincipal
	 * @param {Record<string, any>} pOptions
	 * @return {boolean}
	 */
	meetsScopeRequirements(pPolicy, pEntity, pPrincipal, pOptions)
	{
		if (typeof(pPolicy.requiredFor) !== 'function')
		{
			return true;
		}
		let tmpRequired = pPolicy.requiredFor(pEntity, pPrincipal || null);
		if (tmpRequired.length < 1)
		{
			return true;
		}
		let tmpUnsetValues = Array.isArray(pPolicy.UnsetValues) ? pPolicy.UnsetValues
			: (pOptions && pOptions.Scope && Array.isArray(pOptions.Scope.UnsetValues)) ? pOptions.Scope.UnsetValues
			: [];
		let tmpUnresolved = (pPrincipal && Array.isArray(pPrincipal.UnresolvedScopeColumns)) ? pPrincipal.UnresolvedScopeColumns : [];
		return tmpRequired.every((pEntry) => { return (tmpUnresolved.indexOf(pEntry.Column) < 0) && !libRetoldFacetingUtil.isUnsetScopeValue(pEntry.Value, tmpUnsetValues); });
	}
}

module.exports = RetoldFacetingAuthorizer;
module.exports.serviceType = 'RetoldFacetingAuthorizer';
