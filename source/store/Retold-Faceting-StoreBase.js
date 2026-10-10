/**
 * Retold Faceting - Store Base
 *
 * The persistence store contract (design 04 §2), split for M5 (internal-contracts §54.1): a store owns
 * its lifecycle and the write side (keymap reads, the one-INSERT-per-flush batch, shadow tables, the
 * in-store entity state, reconcile checksums) and runs raw statements; the Router-facing engine
 * (capable / freshness / execute) is a separate service (RetoldFacetingEngineClickHouse).  The
 * design's query-side names stay here as thin delegates so a later store can choose either shape.
 *
 * Every async method calls back (pError, pResult) and never throws; an error carries
 * .StoreError = true, .Code (the store's error code when known), .Status, and a message without
 * bound values.  pTarget is 'Live' or 'Shadow:<BuildID>' (shadowTarget()).
 *
 * Abstract: not registered on fable (RetoldFacetingStoreClickHouse extends it).
 *
 * Contract: internal-contracts §54.3.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');

// The live target of a write (internal-contracts §54.3).
const TARGET_LIVE = 'Live';
const SHADOW_TARGET_PREFIX = 'Shadow:';
const BUILD_ID_PATTERN = /^[0-9a-f]{8}$/;

/**
 * The target name of a rebuild's shadow tables.
 *
 * @param {string} pBuildID - 8 lowercase hex
 * @return {string}
 */
const shadowTarget = (pBuildID) =>
{
	if ((typeof(pBuildID) !== 'string') || !BUILD_ID_PATTERN.test(pBuildID))
	{
		throw new Error('RetoldFacetingStoreBase: a BuildID is 8 lowercase hex characters.');
	}
	return `${SHADOW_TARGET_PREFIX}${pBuildID}`;
};

/**
 * Is this a shadow target?  Returns its BuildID, or null.
 *
 * @param {string} pTarget
 * @return {string|null}
 */
const isShadowTarget = (pTarget) =>
{
	if ((typeof(pTarget) !== 'string') || (pTarget.indexOf(SHADOW_TARGET_PREFIX) !== 0))
	{
		return null;
	}
	let tmpBuildID = pTarget.slice(SHADOW_TARGET_PREFIX.length);
	return BUILD_ID_PATTERN.test(tmpBuildID) ? tmpBuildID : null;
};

/**
 * The error an abstract method reports.
 *
 * @param {string} pMethod
 * @return {Error}
 */
const abstractError = (pMethod) =>
{
	let tmpError = new Error(`RetoldFacetingStoreBase.${pMethod} is abstract.`);
	tmpError.StoreError = true;
	tmpError.Status = 0;
	tmpError.Code = null;
	return tmpError;
};

class RetoldFacetingStoreBase extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingStoreBase';
	}

	/**
	 * The store's name ('ClickHouse', later 'Solr' / 'OpenSearch').
	 *
	 * @return {string}
	 */
	get StoreName()
	{
		return 'Base';
	}

	// ---- lifecycle --------------------------------------------------------------------------

	/**
	 * Resolve the store section (URLEnv / UserEnv / PasswordEnv, the database name); never throws.
	 *
	 * @param {Record<string, any>} pStoreOptions - the resolved Stores.<Name> object
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	configure(pStoreOptions)
	{
		return { Configured: false, Available: false, Reason: 'Abstract' };
	}

	/**
	 * @param {(pError?: Error, pResult?: { Up: boolean, Version: string|null }) => void} fCallback
	 */
	connect(fCallback)
	{
		return fCallback(abstractError('connect'));
	}

	/**
	 * @param {Record<string, any>} pSpecs - { Entity: MirrorSpec }
	 * @param {(pError?: Error, pResult?: { Entities: Record<string, any> }) => void} fCallback
	 */
	ensureSchema(pSpecs, fCallback)
	{
		return fCallback(abstractError('ensureSchema'));
	}

	/**
	 * The live mirror and keymap IF NOT EXISTS: for Facet-ClickHouse-Support.loadMirrors and tests only
	 * (the Materializer's live tables come only from a backfill's RENAME, §59.1).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {(pError?: Error) => void} fCallback
	 */
	createLive(pEntity, pSpec, fCallback)
	{
		return fCallback(abstractError('createLive'));
	}

	/**
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {Array<string>} pColumns
	 * @param {(pError?: Error) => void} fCallback
	 */
	addColumns(pEntity, pSpec, pColumns, fCallback)
	{
		return fCallback(abstractError('addColumns'));
	}

	/**
	 * @param {(pError?: Error, pHealth?: Record<string, any>) => void} fCallback
	 */
	health(fCallback)
	{
		return fCallback(abstractError('health'));
	}

	/**
	 * @param {(pError?: Error, pMaxVersion?: number) => void} fCallback
	 */
	maxVersion(fCallback)
	{
		return fCallback(abstractError('maxVersion'));
	}

	// ---- write side (the WriterLoop / FlushBuffer, the Rebuilder, the Reconciler) -------------

	/**
	 * @param {string} pEntity
	 * @param {Array<number>} pIDs
	 * @param {string} pTarget
	 * @param {(pError?: Error, pKeys?: Map<number, Array<Record<string, any>>>) => void} fCallback
	 */
	readKeys(pEntity, pIDs, pTarget, fCallback)
	{
		return fCallback(abstractError('readKeys'));
	}

	/**
	 * @param {string} pEntity
	 * @param {number|null} pAfterID - exclusive; null = from the start
	 * @param {number|null} pToID - inclusive; null = to the end
	 * @param {string} pTarget
	 * @param {(pError?: Error, pKeys?: Map<number, Array<Record<string, any>>>) => void} fCallback
	 */
	readKeyRange(pEntity, pAfterID, pToID, pTarget, fCallback)
	{
		return fCallback(abstractError('readKeyRange'));
	}

	/**
	 * The three-insert flush protocol for one target (internal-contracts §58.6).
	 *
	 * @param {string} pEntity
	 * @param {{ Rows: Array<Record<string, any>>, Tombstones: Array<Record<string, any>>, KeyIntents: Array<Record<string, any>>, KeyRetires: Array<Record<string, any>> }} pBatch
	 * @param {string} pToken - '<Entity>:<FlushID>:<Target>'
	 * @param {string} pTarget
	 * @param {(pError?: Error, pResult?: { Rows: number, Tombstones: number, Inserts: number }) => void} fCallback
	 */
	writeBatch(pEntity, pBatch, pToken, pTarget, fCallback)
	{
		return fCallback(abstractError('writeBatch'));
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {Record<string, any>} pSpec
	 * @param {(pError?: Error) => void} fCallback
	 */
	beginShadow(pEntity, pBuildID, pSpec, fCallback)
	{
		return fCallback(abstractError('beginShadow'));
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {boolean} pFirstEnable - RENAME (no live table yet) instead of EXCHANGE
	 * @param {(pError?: Error) => void} fCallback
	 */
	swapShadow(pEntity, pBuildID, pFirstEnable, fCallback)
	{
		return fCallback(abstractError('swapShadow'));
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {(pError?: Error) => void} fCallback
	 */
	dropShadow(pEntity, pBuildID, fCallback)
	{
		return fCallback(abstractError('dropShadow'));
	}

	/**
	 * @param {string} pEntity
	 * @param {(pError?: Error, pState?: Record<string, any>|null) => void} fCallback
	 */
	readState(pEntity, fCallback)
	{
		return fCallback(abstractError('readState'));
	}

	/**
	 * @param {string} pEntity
	 * @param {Record<string, any>} pState
	 * @param {(pError?: Error) => void} fCallback
	 */
	writeState(pEntity, pState, fCallback)
	{
		return fCallback(abstractError('writeState'));
	}

	/**
	 * @param {string} pEntity
	 * @param {number} pLeafRange
	 * @param {string} pTarget
	 * @param {(pError?: Error, pBuckets?: Record<string, { Count: number, IDSum: number }>) => void} fCallback
	 */
	bucketChecksums(pEntity, pLeafRange, pTarget, fCallback)
	{
		return fCallback(abstractError('bucketChecksums'));
	}

	/**
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {Array<string>|null} pColumns
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	readLeafRows(pEntity, pAfterID, pToID, pColumns, fCallback)
	{
		return fCallback(abstractError('readLeafRows'));
	}

	// ---- statements and the query side --------------------------------------------------------

	/**
	 * @param {string} pSQL
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, string>|null} pTypes
	 * @param {Record<string, any>|null} pSettings
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	queryRows(pSQL, pParams, pTypes, pSettings, fCallback)
	{
		return fCallback(abstractError('queryRows'));
	}

	/**
	 * @param {string} pSQL
	 * @param {Record<string, any>|null} pParams
	 * @param {Record<string, any>|null} pSettings
	 * @param {(pError?: Error) => void} fCallback
	 */
	command(pSQL, pParams, pSettings, fCallback)
	{
		return fCallback(abstractError('command'));
	}

	/**
	 * Tests and the wipe scenario only.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	dropDatabase(fCallback)
	{
		return fCallback(abstractError('dropDatabase'));
	}

	/**
	 * @return {{ Folds: Array<string>, Predicates: string, Paths: string, CountModes: Array<string>, TimeZones: Array<string> }}
	 */
	capabilities()
	{
		return { Folds: [], Predicates: 'None', Paths: 'None', CountModes: [], TimeZones: [] };
	}

	// ---- the design's query-side names (04 §2), as thin delegates to this store's engine --------
	//
	// M5 serves the query side from a separate engine service (RetoldFacetingEngine<StoreName>, §54.1);
	// these keep the design's store-as-engine shape available to a later store that prefers it.

	/**
	 * The engine service of this store, or null.
	 *
	 * @return {any|null}
	 */
	engine()
	{
		let tmpEngine = this.fable[`RetoldFacetingEngine${this.StoreName}`];
		return (tmpEngine && (typeof(tmpEngine.capable) === 'function')) ? tmpEngine : null;
	}

	/**
	 * @return {string}
	 */
	get EngineName()
	{
		return this.StoreName;
	}

	/**
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pContext
	 * @return {{ Capable: boolean, Reason: string|null }}
	 */
	capable(pAgg, pContext)
	{
		let tmpEngine = this.engine();
		return tmpEngine ? tmpEngine.capable(pAgg, pContext) : { Capable: false, Reason: 'StoreUnavailable' };
	}

	/**
	 * @param {Record<string, Array<string>>} pDepSet
	 * @return {Record<string, any>}
	 */
	freshness(pDepSet)
	{
		let tmpEngine = this.engine();
		return (tmpEngine && (typeof(tmpEngine.freshness) === 'function')) ? tmpEngine.freshness(pDepSet) : { Exact: false, State: 'Absent', LagMS: Infinity };
	}

	/**
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	execute(pContext, pAggs, fCallback)
	{
		let tmpEngine = this.engine();
		if (!tmpEngine || (typeof(tmpEngine.execute) !== 'function'))
		{
			return fCallback(abstractError('execute'));
		}
		return tmpEngine.execute(pContext, pAggs, fCallback);
	}

	/**
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	status()
	{
		return { Configured: false, Available: false, Reason: 'Abstract' };
	}
}

module.exports = RetoldFacetingStoreBase;
module.exports.serviceType = 'RetoldFacetingStoreBase';
module.exports.TARGET_LIVE = TARGET_LIVE;
module.exports.BUILD_ID_PATTERN = BUILD_ID_PATTERN;
module.exports.shadowTarget = shadowTarget;
module.exports.isShadowTarget = isShadowTarget;
module.exports.abstractError = abstractError;
