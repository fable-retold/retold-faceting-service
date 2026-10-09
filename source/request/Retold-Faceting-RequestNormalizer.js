/**
 * Retold Faceting - Request Normalizer
 *
 * Shape-checks a facet request body and produces the NormalizedRequest (internal-contracts §3,
 * §28.2): L1 limits (06 §8), Facets[] defaults and clamps, the M2 filter inputs (Scopes, Params,
 * NamedScope clauses), the Records page and the Keys cap, and refusal of request features of later
 * milestones.  Never looks at the catalog (FacetID and scope existence are the Planner's and the
 * FilterAST's); it does check FacetID SYNTAX (FacetRequest.parseFacetID).
 *
 * The rules themselves live in the PURE contract module (Facet-Contract-Request.normalizeRequest)
 * so that pict-section-facet can run exactly the same validation before it sends a request; this
 * service is the server entry point: it hands the function the resolved RetoldFaceting options
 * (Limits, Time.StorageTimeZone) and adds the server-only guards below.
 *
 * The key rules (no control characters, no Object.prototype names such as '__proto__' or
 * 'hasOwnProperty', no '#' prefix) are part of the contract function, so the client refuses the
 * same keys before sending.
 *
 * Synchronous; throws FacetErrors.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');

class RetoldFacetingRequestNormalizer extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingRequestNormalizer';
	}

	/**
	 * Normalize a facet request body (internal-contracts §3, §28.2).
	 *
	 * @param {string} pEntity - the route :Entity
	 * @param {any} pBody - the parsed JSON body
	 * @param {string} [pMode] - 'Query' (default) | 'Records' | 'Count' | 'Keys'
	 * @return {Record<string, any>} NormalizedRequest (internal-contracts §3, §28.2)
	 */
	normalize(pEntity, pBody, pMode)
	{
		// The legacy payload stays off (normalizeLegacy is the seam): AcceptLegacy is never set here.
		return libFacetRequest.normalizeRequest(pEntity, pBody,
			{
				Limits: this.options.Limits,
				Time: this.options.Time,
				Mode: (typeof(pMode) === 'string') ? pMode : 'Query',
				Freshness: this.freshnessSettings()
			});
	}

	/**
	 * The Freshness settings of the contract normalizer (internal-contracts §44.2): the configured
	 * default mode and lag, and the cache's MaxAgeMS as the largest lag a request may ask for.
	 *
	 * @return {{ DefaultMode: string, MaxLagMS: number, MaxAgeMS: number }}
	 */
	freshnessSettings()
	{
		let tmpFreshness = this.options.Freshness || {};
		let tmpCache = this.options.Cache || {};
		return libFacetRequest.resolveFreshnessSettings({ DefaultMode: tmpFreshness.DefaultMode, MaxLagMS: tmpFreshness.MaxLagMS, MaxAgeMS: tmpCache.MaxAgeMS });
	}

	/**
	 * The legacy RecordSetSearchFacetPayload alias (02 §3.2) — a later milestone.
	 *
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @return {null} null: not accepted in M1
	 */
	normalizeLegacy(pEntity, pBody)
	{
		return null;
	}
}

module.exports = RetoldFacetingRequestNormalizer;
module.exports.serviceType = 'RetoldFacetingRequestNormalizer';
