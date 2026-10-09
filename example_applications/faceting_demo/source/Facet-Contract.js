/**
 * Facet-Contract -- the ONE place the demo client reaches into retold-faceting-service.
 *
 * The contract modules (source/contract/*) are pure (zero requires outside their siblings, enforced by the
 * module's smoke test) so browser code may deep-require them (design 10 §3.1).  Every client file requires
 * them through this shim, so lifting the client into pict-section-facet changes exactly these four lines to
 * `require('retold-faceting-service/source/contract/Facet-Contract-*.js')`.
 *
 * Path: faceting_demo/source -> ../../../ = the retold-faceting-service package root.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
module.exports = (
	{
		Buckets: require('../../../source/contract/Facet-Contract-Buckets.js'),
		Clauses: require('../../../source/contract/Facet-Contract-Clauses.js'),
		Errors: require('../../../source/contract/Facet-Contract-Errors.js'),
		Request: require('../../../source/contract/Facet-Contract-Request.js')
	});
