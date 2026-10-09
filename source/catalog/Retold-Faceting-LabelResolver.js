/**
 * Retold Faceting - Label Resolver
 *
 * FK labels (02 §4.4, 06 §5): for every Terms facet on a foreign key, one scoped, guarded read of
 * the target entity AS THE PRINCIPAL for the bucket keys.  The read follows the same rules as every
 * Scoped Relation (03 §3.8, D-37):
 *
 *   - a fresh query on the target's EXECUTION DAL (the route-bound controller's, so the list's);
 *   - the key IN-list rendered by FilterAST.applyToQuery and fenced in '(' ')';
 *   - an EXPLICIT depth-0 soft delete (Deleted = 0) when the target has a delete column — never
 *     FoxHound's implicit one, which switches off as soon as any entry (a host behavior's
 *     included) names the delete column;
 *   - the target's own Reads-QueryConfiguration on its route-bound controller (ScopeCapture) and
 *     the ScopeGuard; an opaque capture labels nothing;
 *   - a projection of exactly the key and label columns.
 *
 * A key the principal cannot see (another tenant's parent, a soft-deleted or missing row) keeps
 * Label = String(Key) with LabelResolved: false; a target that is not facetable or readable, or a
 * read that fails, labels nothing — never an error, never an unscoped read.  Engine-independent:
 * Live and Reference envelopes get the same labels.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

class RetoldFacetingLabelResolver extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingLabelResolver';
	}

	/**
	 * Label every FacetResult in pWork.  The work is grouped by label target (Entity, KeyColumn,
	 * LabelColumn): the keys of every facet labelling the same target are read once (an IN list
	 * chunked at Limits.MaxInList), and the labels are applied to every facet of the group.  Groups
	 * run sequentially (captures are memoized per request and never raced).  Every label read counts
	 * in pContext.Counters.Statements and pContext.Counters.Labels.
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2
	 * @param {Array<{ Agg: Record<string, any>, Result: Record<string, any> }>} pWork
	 * @param {() => void} fDone
	 */
	resolve(pContext, pWork, fDone)
	{
		let tmpGroups = [];
		let tmpByTarget = new Map();
		(Array.isArray(pWork) ? pWork : []).forEach(
			(pItem) =>
			{
				let tmpLookup = pItem.Agg.LabelLookup || {};
				let tmpGroupKey = `${tmpLookup.Entity}|${tmpLookup.KeyColumn}|${tmpLookup.LabelColumn}`;
				let tmpGroup = tmpByTarget.get(tmpGroupKey);
				if (!tmpGroup)
				{
					tmpGroup = { Lookup: tmpLookup, Keys: [], Seen: new Set(), Items: [] };
					tmpByTarget.set(tmpGroupKey, tmpGroup);
					tmpGroups.push(tmpGroup);
				}
				tmpGroup.Items.push(pItem);
				pItem.Result.Buckets.forEach(
					(pBucket) =>
					{
						if (!libRetoldFacetingUtil.isPresent(pBucket.Key))
						{
							return;
						}
						let tmpSignature = `${typeof(pBucket.Key)}:${String(pBucket.Key)}`;
						if (!tmpGroup.Seen.has(tmpSignature))
						{
							tmpGroup.Seen.add(tmpSignature);
							tmpGroup.Keys.push(pBucket.Key);
						}
					});
			});
		this.fable.Utility.eachLimit(tmpGroups, 1,
			(pGroup, fNext) =>
			{
				this.readLabels(pContext, pGroup.Lookup, pGroup.Keys,
					(pLabels) =>
					{
						pGroup.Items.forEach((pItem) => { this.applyLabels(pItem.Result, pLabels); });
						return fNext();
					});
			},
			() =>
			{
				return fDone();
			});
	}

	/**
	 * Read the labels of FK keys from the target entity (scoped, guarded), one IN-list chunk of at
	 * most Limits.MaxInList keys at a time.  Calls back with a Map String(Key) → label, or null when
	 * nothing could be read.  Never errors.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {{ Entity: string, KeyColumn: string, LabelColumn: string }} pLookup
	 * @param {Array<any>} pKeys
	 * @param {(pLabels: Map<string, string>|null) => void} fCallback
	 */
	readLabels(pContext, pLookup, pKeys, fCallback)
	{
		let tmpBindableKeys = pKeys.filter((pKey) => { return (typeof(pKey) === 'string') || ((typeof(pKey) === 'number') && Number.isFinite(pKey)); });
		let tmpOptions = (pContext && pContext.Options) ? pContext.Options : this.options;
		let tmpChunkSize = (tmpOptions.Limits && (tmpOptions.Limits.MaxInList >= 1)) ? Math.floor(tmpOptions.Limits.MaxInList) : 1000;
		let tmpChunks = [];
		for (let i = 0; i < tmpBindableKeys.length; i += tmpChunkSize)
		{
			tmpChunks.push(tmpBindableKeys.slice(i, i + tmpChunkSize));
		}
		if (tmpChunks.length < 1)
		{
			return fCallback(null);
		}
		let tmpLabels = new Map();
		let fChunk = (pIndex) =>
		{
			if (pIndex >= tmpChunks.length)
			{
				return fCallback(tmpLabels);
			}
			this.readLabelChunk(pContext, pLookup, tmpChunks[pIndex],
				(pChunkLabels) =>
				{
					if (!pChunkLabels)
					{
						// One failed chunk labels nothing (never a partially resolved facet).
						return fCallback(null);
					}
					pChunkLabels.forEach((pLabel, pKey) => { tmpLabels.set(pKey, pLabel); });
					return fChunk(pIndex + 1);
				});
		};
		return fChunk(0);
	}

	/**
	 * One scoped, guarded label read for a chunk of keys.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {{ Entity: string, KeyColumn: string, LabelColumn: string }} pLookup
	 * @param {Array<any>} pKeys - bindable keys (≤ MaxInList)
	 * @param {(pLabels: Map<string, string>|null) => void} fCallback
	 */
	readLabelChunk(pContext, pLookup, pKeys, fCallback)
	{
		let tmpCalledBack = false;
		let fDone = (pLabels) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			return fCallback(pLabels);
		};
		let tmpHost = pContext.Host;
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpTarget = pLookup ? pLookup.Entity : null;
		if (!tmpTarget || !pLookup.LabelColumn || (pKeys.length < 1) || !tmpHost || !tmpCatalog
			|| !tmpHost.isFacetable(tmpTarget, pContext.Principal)
			|| !tmpCatalog.getFacetable(tmpTarget)
			|| !this.fable.RetoldFacetingAuthorizer.canRead(pContext, tmpTarget)
			|| !tmpCatalog.column(tmpTarget, pLookup.KeyColumn)
			|| !tmpCatalog.column(tmpTarget, pLookup.LabelColumn))
		{
			return fDone(null);
		}
		let tmpDAL = tmpHost.getExecutionDAL(tmpTarget);
		let tmpProfile = tmpHost.getDialectProfile(tmpTarget);
		if (!tmpDAL || !tmpProfile || !tmpProfile.Name)
		{
			return fDone(null);
		}
		let tmpQuery;
		try
		{
			tmpQuery = tmpDAL.query;
			tmpQuery.setDataElements([ pLookup.KeyColumn, pLookup.LabelColumn ]);
			tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
			this.fable.RetoldFacetingFilterAST.applyToQuery(
				[ { Id: 'c1', Pred: { Field: pLookup.KeyColumn, Op: 'IN', Value: pKeys } } ],
				tmpQuery, { Dialect: tmpProfile.Name, ParameterPrefix: 'l' });
			tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			if (tmpHost.hasDeleteColumn(tmpTarget))
			{
				tmpQuery.addFilter(tmpHost.getDeleteColumn(tmpTarget), 0, '=', 'AND', 'FacetSoftDelete');
			}
		}
		catch (pQueryError)
		{
			this.fable.log.error(`RetoldFaceting: the label query for ${tmpTarget} could not be built: ${pQueryError.message}`);
			return fDone(null);
		}
		this.fable.RetoldFacetingScopeCapture.capture(pContext, tmpTarget, tmpQuery, 'Inherit', { Columns: [ pLookup.KeyColumn, pLookup.LabelColumn ] },
			(pCaptureError, pCapture) =>
			{
				if (pCaptureError || !pCapture || pCapture.Opaque)
				{
					if (!pCaptureError || (pCaptureError.Code !== 'FACET_UNAUTHENTICATED'))
					{
						this.fable.log.warn(`RetoldFaceting: labels for ${tmpTarget} are unresolved (${pCaptureError ? pCaptureError.Code : 'Opaque'}).`);
					}
					return fDone(null);
				}
				if (pContext.Counters)
				{
					pContext.Counters.Statements = (pContext.Counters.Statements || 0) + 1;
					pContext.Counters.Labels = (pContext.Counters.Labels || 0) + 1;
				}
				try
				{
					tmpDAL.doReads(tmpQuery,
						(pReadError, pReadQuery, pRecords) =>
						{
							if (pReadError || !Array.isArray(pRecords))
							{
								this.fable.log.warn(`RetoldFaceting: the label read for ${tmpTarget} failed.`);
								return fDone(null);
							}
							let tmpLabels = new Map();
							for (let i = 0; i < pRecords.length; i++)
							{
								let tmpRecord = pRecords[i];
								let tmpKey = tmpRecord ? tmpRecord[pLookup.KeyColumn] : null;
								let tmpLabel = tmpRecord ? tmpRecord[pLookup.LabelColumn] : null;
								if (libRetoldFacetingUtil.isPresent(tmpKey) && libRetoldFacetingUtil.isPresent(tmpLabel) && (String(tmpLabel).length > 0))
								{
									tmpLabels.set(String(tmpKey), String(tmpLabel));
								}
							}
							return fDone(tmpLabels);
						});
				}
				catch (pReadThrow)
				{
					if (tmpCalledBack)
					{
						throw pReadThrow;
					}
					this.fable.log.warn(`RetoldFaceting: the label read for ${tmpTarget} threw: ${pReadThrow.message}`);
					return fDone(null);
				}
			});
	}

	/**
	 * Put labels on a Terms FacetResult's buckets (and its Chart).
	 *
	 * @param {Record<string, any>} pResult - FacetResult
	 * @param {Map<string, string>|null} pLabels
	 */
	applyLabels(pResult, pLabels)
	{
		pResult.Buckets = pResult.Buckets.map(
			(pBucket) =>
			{
				let tmpLabel = (pLabels && pLabels.has(String(pBucket.Key))) ? pLabels.get(String(pBucket.Key)) : null;
				let tmpBucket = { Key: pBucket.Key, Label: (tmpLabel !== null) ? tmpLabel : String(pBucket.Key), LabelResolved: (tmpLabel !== null) };
				Object.keys(pBucket).forEach(
					(pField) =>
					{
						if (!libRetoldFacetingUtil.hasOwn(tmpBucket, pField))
						{
							tmpBucket[pField] = pBucket[pField];
						}
					});
				return tmpBucket;
			});
		if (pResult.Chart && Array.isArray(pResult.Chart.Labels))
		{
			pResult.Chart.Labels = pResult.Buckets.map((pBucket) => { return pBucket.Label; });
		}
	}
}

module.exports = RetoldFacetingLabelResolver;
module.exports.serviceType = 'RetoldFacetingLabelResolver';
