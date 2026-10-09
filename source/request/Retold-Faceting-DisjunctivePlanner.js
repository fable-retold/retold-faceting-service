/**
 * Retold Faceting - Disjunctive Planner
 *
 * Disjunctive faceting over top-level conjuncts (01 §8.3, D-05): each facet excludes the
 * conjuncts it owns; facets whose kept-conjunct sets are identical share a Variant.  'v0' is
 * always the full filter (Total, and every Exclude:'None' facet).
 *
 * Ownership (internal-contracts §6.2), in matching order — a conjunct is owned by facet f when:
 *   1. its Origin.Hash or Id is listed in f's explicit Exclude array; or
 *   2. its Origin.FilterKey equals f's FilterKey; or
 *   3. its Fields ⊆ OwnedFields(f).
 * Under 'Self' (or an explicit array) owned conjuncts are excluded, except NeverExclude ones
 * (RawFilter), which are kept.  A conjunct whose Fields intersect OwnedFields without being owned
 * (mixed), or an owned NeverExclude conjunct, is kept and listed in KeptMixed → Mode 'Partial'.
 * Owned is computed under every policy (the post-processor derives Selected from it).
 *
 * Synchronous; pure over its inputs.
 *
 * M2 (internal-contracts §24.6): facets group by (kept conjunct set, WhereHash of their definition
 * Where); every Variant also lists its Column-shape conjuncts (ColumnConjuncts → the pivot client
 * fence) and its Path-shape conjuncts (PathConjuncts → the Planner lowers them into PathPred).
 *
 * Contract: internal-contracts §6, §24.6.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');

class RetoldFacetingDisjunctivePlanner extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingDisjunctivePlanner';
	}

	/**
	 * The effective Exclude policy of a facet spec.
	 *
	 * @param {Record<string, any>} pSpec
	 * @return {string|Array<string>} 'Self' | 'None' | [ Hash or Id … ]
	 */
	_policy(pSpec)
	{
		if (Array.isArray(pSpec.Exclude))
		{
			return pSpec.Exclude;
		}
		if ((pSpec.Exclude === 'Self') || (pSpec.Exclude === 'None'))
		{
			return pSpec.Exclude;
		}
		if ((pSpec.Exclude === null) || (typeof(pSpec.Exclude) === 'undefined'))
		{
			// Unresolved: the per-fold default when the caller passed a Fold, else conjunctive.
			return (typeof(pSpec.Fold) === 'string') ? libFacetRequest.defaultExcludeFor(pSpec.Fold) : 'None';
		}
		throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This exclusion policy is not supported.', { Feature: 'Exclude', Milestone: 1, Key: pSpec.Key });
	}

	/**
	 * Ownership and exclusion for one facet spec.
	 *
	 * @param {Array<Record<string, any>>} pConjuncts
	 * @param {Record<string, any>} pSpec
	 * @return {{ Policy: any, Owned: Array<Record<string, any>>, Excluded: Array<Record<string, any>>, KeptMixed: Array<Record<string, any>> }}
	 */
	_exclusion(pConjuncts, pSpec)
	{
		let tmpPolicy = this._policy(pSpec);
		// Sets, never plain objects: Hashes and Ids are client strings.
		let tmpOwnedFields = new Set(Array.isArray(pSpec.OwnedFields) ? pSpec.OwnedFields : []);
		let tmpExplicit = new Set(Array.isArray(tmpPolicy) ? tmpPolicy : []);
		let tmpFilterKey = ((typeof(pSpec.FilterKey) === 'string') && (pSpec.FilterKey.length > 0)) ? pSpec.FilterKey : null;

		let tmpResult = { Policy: tmpPolicy, Owned: [], Excluded: [], KeptMixed: [] };
		for (let i = 0; i < pConjuncts.length; i++)
		{
			let tmpConjunct = pConjuncts[i];
			let tmpFields = Array.isArray(tmpConjunct.Fields) ? tmpConjunct.Fields : [];
			let tmpInside = 0;
			for (let j = 0; j < tmpFields.length; j++)
			{
				if (tmpOwnedFields.has(tmpFields[j]))
				{
					tmpInside++;
				}
			}
			let tmpOrigin = tmpConjunct.Origin || {};
			let tmpOwned = ((typeof(tmpOrigin.Hash) === 'string') && tmpExplicit.has(tmpOrigin.Hash))
				|| tmpExplicit.has(tmpConjunct.Id)
				|| ((tmpFilterKey !== null) && (tmpOrigin.FilterKey === tmpFilterKey))
				|| ((tmpFields.length > 0) && (tmpInside === tmpFields.length));

			if (tmpOwned)
			{
				tmpResult.Owned.push(tmpConjunct);
			}
			if (tmpPolicy === 'None')
			{
				continue;
			}
			if (tmpOwned && !tmpConjunct.NeverExclude)
			{
				tmpResult.Excluded.push(tmpConjunct);
			}
			else if ((tmpOwned && tmpConjunct.NeverExclude) || (!tmpOwned && (tmpInside > 0)))
			{
				tmpResult.KeptMixed.push(tmpConjunct);
			}
		}
		return tmpResult;
	}

	/**
	 * Is a conjunct Path-shaped (an existence node anywhere in its Pred)?
	 *
	 * @param {Record<string, any>} pConjunct
	 * @return {boolean}
	 */
	_isPath(pConjunct)
	{
		let tmpAST = this.fable.RetoldFacetingFilterAST;
		if (tmpAST && (typeof(tmpAST.isPathConjunct) === 'function'))
		{
			return tmpAST.isPathConjunct(pConjunct);
		}
		return (pConjunct.Shape === 'Path');
	}

	/**
	 * The Variant key: kept conjunct Ids, plus '|' + WhereHash when the facets share a definition
	 * Where (internal-contracts §24.6; a Variant without a W_def keeps its M1 Hash).
	 *
	 * @param {Array<string>} pIds
	 * @param {string} pWhereHash
	 * @return {string}
	 */
	variantHash(pIds, pWhereHash)
	{
		let tmpHash = pIds.join(',');
		return ((typeof(pWhereHash) === 'string') && (pWhereHash.length > 0)) ? `${tmpHash}|${pWhereHash}` : tmpHash;
	}

	/**
	 * A Variant over the kept conjuncts (and a definition Where shared by its facets).
	 *
	 * @param {string} pVariantId
	 * @param {Record<string, any>} pFilterAST
	 * @param {Array<Record<string, any>>} pKept
	 * @param {string} [pWhereHash] - '' for no W_def
	 * @param {Record<string, any>|null} [pWhere] - the W_def FoldPred
	 * @return {Record<string, any>}
	 */
	_variant(pVariantId, pFilterAST, pKept, pWhereHash, pWhere)
	{
		let tmpKeptIds = new Set();
		let tmpIncludesDeleted = false;
		for (let i = 0; i < pKept.length; i++)
		{
			tmpKeptIds.add(pKept[i].Id);
			if (pKept[i].NamesDeleted)
			{
				tmpIncludesDeleted = true;
			}
		}
		let tmpAll = Array.isArray(pFilterAST.Conjuncts) ? pFilterAST.Conjuncts : [];
		let tmpExcludedIds = [];
		for (let i = 0; i < tmpAll.length; i++)
		{
			if (!tmpKeptIds.has(tmpAll[i].Id))
			{
				tmpExcludedIds.push(tmpAll[i].Id);
			}
		}
		let tmpIds = pKept.map((pConjunct) => { return pConjunct.Id; });
		let tmpWhereHash = ((typeof(pWhereHash) === 'string') && (pWhereHash.length > 0)) ? pWhereHash : '';
		return (
			{
				VariantId: pVariantId,
				Hash: this.variantHash(tmpIds, tmpWhereHash),
				Entity: pFilterAST.Entity,
				ConjunctIds: tmpIds,
				Conjuncts: pKept,
				ExcludedIds: tmpExcludedIds,
				IncludesDeleted: tmpIncludesDeleted,
				Facets: [],
				// M2 (internal-contracts §24.6): Column conjuncts go into the pivot's client fence; the
				// Path conjuncts are lowered by the Planner into PathPred (scope 'p').
				ColumnConjuncts: pKept.filter((pConjunct) => { return !this._isPath(pConjunct); }),
				PathConjuncts: pKept.filter((pConjunct) => { return this._isPath(pConjunct); }),
				PathPred: null,
				Where: tmpWhereHash ? (pWhere || null) : null,
				WhereHash: tmpWhereHash,
				Relations: []
			});
	}

	/**
	 * Compute Variants and per-facet exclusion info.
	 *
	 * A spec may carry Fold (used only to resolve a null Exclude to the per-fold default), and (M2)
	 * WhereHash + Where: the facet's definition Where (W_def, never excluded).  Facets group by
	 * (kept conjunct set, WhereHash); 'v0' is always the full filter with no W_def.
	 * '#Total' is listed in v0.Facets only when a spec with that Key is passed.
	 *
	 * @param {Record<string, any>} pFilterAST - internal-contracts §4.3
	 * @param {Array<{ Key: string, OwnedFields: Array<string>, FilterKey: string|null, Exclude: string|Array<string>, Fold?: string, WhereHash?: string, Where?: Record<string, any>|null }>} pFacetSpecs
	 * @return {{ Variants: Record<string, Record<string, any>>, Facets: Record<string, { VariantId: string, Mode: string, Excluded: Array<string>, ExcludedHashes: Array<string>, KeptMixed: Array<string>, Owned: Array<string> }> }}
	 */
	variants(pFilterAST, pFacetSpecs)
	{
		if ((typeof(pFilterAST) !== 'object') || (pFilterAST === null))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'DisjunctivePlanner.variants needs a FilterAST.');
		}
		let tmpConjuncts = Array.isArray(pFilterAST.Conjuncts) ? pFilterAST.Conjuncts : [];
		let tmpSpecs = Array.isArray(pFacetSpecs) ? pFacetSpecs : [];

		let tmpV0 = this._variant('v0', pFilterAST, tmpConjuncts.slice(), '', null);
		let tmpVariants = { v0: tmpV0 };
		let tmpByHash = new Map();
		tmpByHash.set(tmpV0.Hash, tmpV0);
		let tmpNext = 1;
		let tmpFacets = {};

		for (let i = 0; i < tmpSpecs.length; i++)
		{
			let tmpSpec = tmpSpecs[i];
			if ((typeof(tmpSpec) !== 'object') || (tmpSpec === null) || (typeof(tmpSpec.Key) !== 'string') || (tmpSpec.Key === '__proto__'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'DisjunctivePlanner.variants: malformed facet spec.');
			}
			let tmpExclusion = this._exclusion(tmpConjuncts, tmpSpec);
			let tmpWhereHash = ((typeof(tmpSpec.WhereHash) === 'string') && (tmpSpec.WhereHash.length > 0)) ? tmpSpec.WhereHash : '';

			let tmpVariant = tmpV0;
			let tmpExcludes = (tmpExclusion.Policy !== 'None') && (tmpExclusion.Excluded.length > 0);
			if (tmpExcludes || (tmpWhereHash.length > 0))
			{
				let tmpExcludedSet = new Set(tmpExcludes ? tmpExclusion.Excluded.map((pConjunct) => { return pConjunct.Id; }) : []);
				let tmpKept = tmpConjuncts.filter((pConjunct) => { return !tmpExcludedSet.has(pConjunct.Id); });
				let tmpHash = this.variantHash(tmpKept.map((pConjunct) => { return pConjunct.Id; }), tmpWhereHash);
				if (tmpByHash.has(tmpHash))
				{
					tmpVariant = tmpByHash.get(tmpHash);
				}
				else
				{
					tmpVariant = this._variant('v' + tmpNext, pFilterAST, tmpKept, tmpWhereHash, tmpSpec.Where || null);
					tmpNext++;
					tmpVariants[tmpVariant.VariantId] = tmpVariant;
					tmpByHash.set(tmpHash, tmpVariant);
				}
			}
			if (tmpVariant.Facets.indexOf(tmpSpec.Key) < 0)
			{
				tmpVariant.Facets.push(tmpSpec.Key);
			}

			let tmpMode = (tmpExclusion.Policy === 'None') ? 'NotApplicable'
				: (tmpExclusion.KeptMixed.length > 0) ? 'Partial'
				: 'Exact';
			tmpFacets[tmpSpec.Key] = (
				{
					VariantId: tmpVariant.VariantId,
					Mode: tmpMode,
					Excluded: tmpExclusion.Excluded.map((pConjunct) => { return pConjunct.Id; }),
					// Clause Hash, else the conjunct Id (the envelope's FacetResult.Excluded form).
					ExcludedHashes: tmpExclusion.Excluded.map((pConjunct) => { return ((pConjunct.Origin && (typeof(pConjunct.Origin.Hash) === 'string')) ? pConjunct.Origin.Hash : pConjunct.Id); }),
					KeptMixed: tmpExclusion.KeptMixed.map((pConjunct) => { return pConjunct.Id; }),
					Owned: tmpExclusion.Owned.map((pConjunct) => { return pConjunct.Id; })
				});
		}

		return { Variants: tmpVariants, Facets: tmpFacets };
	}
}

module.exports = RetoldFacetingDisjunctivePlanner;
module.exports.serviceType = 'RetoldFacetingDisjunctivePlanner';
