/**
 * Retold Faceting - Engine Base
 *
 * The one engine seam (03 §4, D-02).  Every engine (Live, Reference; later Pushdown, FanOut and
 * the store engines) implements capable / freshness / execute over FoldIR Aggs and returns
 * RawFacetResults; envelope arithmetic is never an engine's job (internal-contracts §9).
 *
 * Shared statics (one implementation of the key normalization every Live path uses — per-Variant
 * statements and the cube marginalization alike): rawKey, toDateString, dimensionKey.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetEnvelope = require('../contract/Facet-Contract-Envelope.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');

// Pivot axis kinds every engine folds (internal-contracts §5.2; M2 axes may carry Via, §24.3).
const PIVOT_AXIS_KINDS = Object.freeze([ 'Column', 'DateBucket', 'Range' ]);

/**
 * A raw key value as the driver returned it (Buffers from binary collations become strings,
 * bigints numbers).
 *
 * @param {any} pValue
 * @return {any}
 */
const rawKey = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return null;
	}
	if ((typeof(Buffer) !== 'undefined') && Buffer.isBuffer(pValue))
	{
		return pValue.toString('utf8');
	}
	if (typeof(pValue) === 'bigint')
	{
		return Number(pValue);
	}
	return pValue;
};

/**
 * A date key / bound as a string (or null); driver Date objects read in UTC.
 *
 * @param {any} pValue
 * @return {string|null}
 */
const toDateString = (pValue) =>
{
	let tmpValue = rawKey(pValue);
	if (tmpValue === null)
	{
		return null;
	}
	if (tmpValue instanceof Date)
	{
		return tmpValue.toISOString().slice(0, 19).replace('T', ' ');
	}
	return String(tmpValue);
};

/**
 * A single-dimension key exactly as that dimension's fold computes it from a statement row (§5.3):
 * DateBucket → the bucket start string; Range → the declared range Key (index -1 = NULL → null,
 * any other non-range index → NO_RANGE_KEY); NumericBucket → the bucket index (null outside);
 * ChildAgg / ExistsFlag → the band / flag number; everything else → normalizeKey by DataType.
 *
 * @param {Record<string, any>} pDimension
 * @param {any} pValue
 * @return {any}
 */
const dimensionKey = (pDimension, pValue) =>
{
	switch (pDimension.Kind)
	{
		case 'DateBucket':
			return toDateString(pValue);
		case 'Range':
			{
				let tmpIndex = libFacetUtil.toFiniteNumber(rawKey(pValue));
				if ((tmpIndex === null) || (tmpIndex === -1))
				{
					return null;
				}
				return ((tmpIndex >= 0) && (tmpIndex < pDimension.Ranges.length)) ? pDimension.Ranges[tmpIndex].Key : libFacetBuckets.NO_RANGE_KEY;
			}
		case 'NumericBucket':
		case 'ChildAgg':
		case 'ExistsFlag':
			return libFacetUtil.toFiniteNumber(rawKey(pValue));
		default:
			return libFacetEnvelope.normalizeKey(rawKey(pValue), pDimension.DataType);
	}
};

class RetoldFacetingEngineBase extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingEngineBase';
	}

	/**
	 * 'Live' | 'Reference' | 'Pushdown' | 'FanOut' | 'ClickHouse' | 'Solr' | 'OpenSearch'
	 *
	 * @return {string}
	 */
	get EngineName()
	{
		return 'Base';
	}

	/**
	 * Pure, fast, no I/O: can this engine answer this Agg for this request?
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pContext
	 * @return {{ Capable: boolean, Reason?: string }}
	 */
	capable(pAgg, pContext)
	{
		return { Capable: false, Reason: 'Abstract' };
	}

	/**
	 * The freshness this engine can promise now for this DepSet (04 §8.2).
	 *
	 * @param {Record<string, Array<string>>} pDepSet
	 * @return {{ Exact: boolean, AsOf: string, LagMS: number }}
	 */
	freshness(pDepSet)
	{
		return { Exact: true, AsOf: new Date().toISOString(), LagMS: 0 };
	}

	/**
	 * Execute every Agg of one request (all Variants).
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2
	 * @param {Array<Record<string, any>>} pAggs - internal-contracts §5.1
	 * @param {(pError?: Error, pExecution?: { Engine: string, AsOf: string, Exact: boolean, Results: Record<string, any>, Errors: Record<string, any>, Captures: Record<string, any>, Statements: number }) => void} fCallback
	 */
	execute(pContext, pAggs, fCallback)
	{
		return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingEngineBase.execute is abstract.'));
	}

	/**
	 * An empty Execution for this engine (helper for implementations).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {{ Engine: string, AsOf: string, Exact: boolean, Results: Record<string, any>, Errors: Record<string, any>, Captures: Record<string, any>, Statements: number }}
	 */
	newExecution(pContext)
	{
		return (
			{
				Engine: this.EngineName,
				AsOf: (pContext && pContext.Now) ? pContext.Now : new Date().toISOString(),
				Exact: true,
				Results: {},
				Errors: {},
				Captures: {},
				Statements: 0
			});
	}

	/**
	 * Fold one captured relation's scope into Execution.Captures[Entity] (internal-contracts §26.6):
	 * the sorted, de-duplicated fingerprints of EVERY captured relation of that entity (pivot, hops,
	 * children, tuple sides; a TenantOnly capture fingerprints differently) and whether any was
	 * Repaired.
	 *
	 * @param {Record<string, any>} pExecution
	 * @param {string} pEntity
	 * @param {Record<string, any>} pCapture
	 */
	recordEntityCapture(pExecution, pEntity, pCapture)
	{
		let tmpCapture = pCapture || {};
		let tmpEntry = pExecution.Captures[pEntity] || { Fingerprint: null, Fingerprints: [], Repaired: false };
		if (tmpCapture.Fingerprint && (tmpEntry.Fingerprints.indexOf(tmpCapture.Fingerprint) < 0))
		{
			tmpEntry.Fingerprints.push(tmpCapture.Fingerprint);
			tmpEntry.Fingerprints.sort();
		}
		tmpEntry.Fingerprint = tmpEntry.Fingerprints.join(',');
		tmpEntry.Repaired = tmpEntry.Repaired || !!(tmpCapture.Guard && tmpCapture.Guard.Repaired);
		pExecution.Captures[pEntity] = tmpEntry;
	}
}

module.exports = RetoldFacetingEngineBase;
module.exports.serviceType = 'RetoldFacetingEngineBase';
module.exports.PIVOT_AXIS_KINDS = PIVOT_AXIS_KINDS;
module.exports.rawKey = rawKey;
module.exports.toDateString = toDateString;
module.exports.dimensionKey = dimensionKey;
