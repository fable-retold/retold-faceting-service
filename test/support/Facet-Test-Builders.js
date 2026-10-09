/**
 * Facet-Test-Builders — the hand-built fixtures every unit test shares (one copy each):
 *
 *   newFable(pProduct)                         a quiet fable
 *   conjunct(pId, pPred, pOverrides)          a FilterAST conjunct (internal-contracts §4.2)
 *   variant(pVariantId, pEntity, pConjuncts)  a Variant (internal-contracts §6.3)
 *   bookstoreModel(pFixture)                  the fixture bookstore model (Bookstore-Seed.model)
 *   prng / SENSITIVE_PATTERN                  re-exported from their owners
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFable = require('fable');

const libBookstoreSeed = require('../fixtures/Bookstore-Seed.js');
const libRetoldFacetingCatalog = require('../../source/catalog/Retold-Faceting-Catalog.js');

/**
 * A fable that logs only fatal messages.
 *
 * @param {string} [pProduct]
 * @return {any}
 */
const newFable = (pProduct) =>
{
	return new libFable({ Product: pProduct || 'RetoldFacetingTest', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
};

/**
 * Every Field a Pred references (sorted, unique).
 *
 * @param {Record<string, any>} pPred
 * @return {Array<string>}
 */
const fieldsOf = (pPred) =>
{
	let tmpFields = [];
	let fWalk = (pNode) =>
	{
		if (Array.isArray(pNode.And) || Array.isArray(pNode.Or))
		{
			(pNode.And || pNode.Or).forEach(fWalk);
			return;
		}
		if (tmpFields.indexOf(pNode.Field) < 0)
		{
			tmpFields.push(pNode.Field);
		}
	};
	fWalk(pPred);
	return tmpFields.sort();
};

/**
 * A conjunct built by hand (so engine tests do not depend on the request pipeline): Origin Kind
 * 'String', NamesDeleted when a field is 'Deleted'.  pOverrides replaces any member.
 *
 * @param {string} pId - unique per request
 * @param {Record<string, any>} pPred
 * @param {Record<string, any>} [pOverrides]
 * @return {Record<string, any>}
 */
const conjunct = (pId, pPred, pOverrides) =>
{
	let tmpFields = fieldsOf(pPred);
	return Object.assign(
		{
			Id: pId,
			Origin: { Kind: 'String', Hash: null, FilterKey: null, ClauseType: null, Index: 0 },
			Fields: tmpFields,
			NeverExclude: false,
			Fence: true,
			NamesDeleted: (tmpFields.indexOf('Deleted') >= 0),
			Pred: pPred
		}, pOverrides || {});
};

/**
 * A Variant over hand-built conjuncts.
 *
 * @param {string} pVariantId
 * @param {string} pEntity
 * @param {Array<Record<string, any>>} pConjuncts
 * @return {Record<string, any>}
 */
const variant = (pVariantId, pEntity, pConjuncts) =>
{
	let tmpIds = pConjuncts.map((pConjunct) => { return pConjunct.Id; });
	return (
		{
			VariantId: pVariantId,
			Hash: tmpIds.join(','),
			Entity: pEntity,
			ConjunctIds: tmpIds,
			Conjuncts: pConjuncts,
			ExcludedIds: [],
			IncludesDeleted: pConjuncts.some((pConjunct) => { return pConjunct.NamesDeleted; }),
			Facets: []
		});
};

module.exports = (
	{
		newFable: newFable,
		fieldsOf: fieldsOf,
		conjunct: conjunct,
		variant: variant,
		bookstoreModel: libBookstoreSeed.model,
		prng: libBookstoreSeed.prng,
		SENSITIVE_PATTERN: libRetoldFacetingCatalog.SENSITIVE_PATTERN
	});
