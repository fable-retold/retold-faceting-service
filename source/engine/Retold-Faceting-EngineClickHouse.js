/**
 * Retold Faceting - Engine ClickHouse
 *
 * The store engine the Router talks to (design 03 §10–§11, 04 §2; internal-contracts §64):
 *
 *   capable(pAgg, pContext)          pure, static: store available, Query mode, a kind Live supports,
 *                                    no Show-deleted, the closure rule (MirrorSpec.covers), no Lossy
 *                                    'Value' column read, read breaker closed (freshness admission is
 *                                    the Router's)
 *   freshness(pDepSet)               Freshness.freshness('ClickHouse', pDepSet, now)
 *   execute(pContext, pAggs, cb)     capture every relation (ScopedRelationBuilder.captureRelation:
 *                                    the entity's own behaviors + ScopeGuard, exactly Live's scope),
 *                                    refuse Opaque / non-Portable captures (Execution.Refused), probe
 *                                    the fragment leaves' operator transforms (as Live), compile
 *                                    (ClickHouse-FoldCompiler), run through Store.queryRows with a
 *                                    deadline-bounded max_execution_time, fold with EngineLive.foldRows
 *                                    (the same row shapes) / CubeExecutor.marginalize
 *
 * execute() mirrors EngineLive's phases so captures never race and every error lands where Live puts
 * it: capability and one group per (Pivot, Variant) (each TuplePivot Agg alone); the conditional
 * disjunctive scans (a cube's members all store-routed: one grain statement, marginalized in JS;
 * Live's fallbacks — Transformed, CubeMaxGroups, a refused member — run the members per Variant);
 * per group the pivot / Variant captures, then per Agg its own; then the statements, bounded by
 * Execution.MaxParallelStatements.  A capture error Live would raise (401, a Strict guard 500,
 * TOO_LARGE) is returned exactly as Live returns it (whole request or per facet); refusals go to
 * Execution.Refused (the Router re-runs those Aggs on Live); a store error fails the whole call
 * (.StoreError: the Router falls back) unless only some Aggs failed, which are then Refused
 * 'StoreError'.
 *
 * Registered in SUB_SERVICES; registered with the Router (before Live) only when the store is
 * configured (installStores, §54.2).  Labels are never compiled here (the Live scoped label read
 * runs in post-processing for every engine).
 *
 * Test seam (never set in production): useStaticMirrors({ Specs, Lossy, Filling, Store }) — the
 * statically loaded mirrors of Facet-ClickHouse-Support.loadMirrors, used without a running
 * materializer.
 *
 * Contract: internal-contracts §64, §65.  Owner: builder C (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libRetoldFacetingEngineBase = require('./Retold-Faceting-EngineBase.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFoldCompiler = require('../store/clickhouse/ClickHouse-FoldCompiler.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

const ENGINE_NAME = 'ClickHouse';

// The store this engine reads (Freshness keys, MirrorSpec store name, entity state).
const STORE_NAME = 'ClickHouse';

const hasOwn = libRetoldFacetingUtil.hasOwn;
const toNumber = libRetoldFacetingUtil.toFiniteNumber;
const toCount = libRetoldFacetingUtil.toCount;
const rawKey = libRetoldFacetingEngineBase.rawKey;

// The share of the remaining request deadline a store statement may use (§57.3, §62.1): a fallback
// to Live still has time.
const DEADLINE_SHARE = 0.4;

class RetoldFacetingEngineClickHouse extends libRetoldFacetingEngineBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingEngineClickHouse';

		// Test seam: statically loaded mirrors (no materializer).  null in production.
		this._Static = null;
	}

	/**
	 * @return {string}
	 */
	get EngineName()
	{
		return ENGINE_NAME;
	}

	// ================================================================== wiring

	/**
	 * TESTS / Facet-ClickHouse-Support.loadMirrors ONLY: answer from statically loaded mirrors without
	 * a running materializer.  pStatic: { Specs: { Entity: MirrorSpec }, Lossy: { Entity: { Column: … } },
	 * Filling: { Entity: [ … ] }, Store: <an object with queryRows / status / Database> }; every member
	 * is optional (Specs default to MirrorSpec, Store to RetoldFacetingStoreClickHouse).  null clears it.
	 *
	 * @param {Record<string, any>|null} pStatic
	 * @return {RetoldFacetingEngineClickHouse}
	 */
	useStaticMirrors(pStatic)
	{
		this._Static = ((typeof(pStatic) === 'object') && (pStatic !== null)) ? Object.assign({}, pStatic) : null;
		return this;
	}

	/**
	 * The store service the engine reads through.
	 *
	 * @return {Record<string, any>|null}
	 */
	store()
	{
		if (this._Static && this._Static.Store)
		{
			return this._Static.Store;
		}
		return this.fable.RetoldFacetingStoreClickHouse || null;
	}

	/**
	 * The MirrorSpec of an entity in this store (null: not mirrored).
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	spec(pEntity)
	{
		if (this._Static && this._Static.Specs)
		{
			return hasOwn(this._Static.Specs, pEntity) ? this._Static.Specs[pEntity] : null;
		}
		let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
		if (!tmpMirrorSpec || (typeof(tmpMirrorSpec.spec) !== 'function'))
		{
			return null;
		}
		try
		{
			return tmpMirrorSpec.spec(STORE_NAME, pEntity) || null;
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * The materializer's view of an entity: { Lossy: { Column: 'Compare' | 'Value' }, FillingColumns: [ … ] }.
	 *
	 * @param {string} pEntity
	 * @return {{ Lossy: Record<string, string>, FillingColumns: Array<string> }}
	 */
	entityInfo(pEntity)
	{
		if (this._Static)
		{
			return (
				{
					Lossy: (this._Static.Lossy && hasOwn(this._Static.Lossy, pEntity)) ? (this._Static.Lossy[pEntity] || {}) : {},
					FillingColumns: (this._Static.Filling && hasOwn(this._Static.Filling, pEntity) && Array.isArray(this._Static.Filling[pEntity])) ? this._Static.Filling[pEntity] : []
				});
		}
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		let tmpInfo = null;
		if (tmpMaterializer && (typeof(tmpMaterializer.entityInfo) === 'function'))
		{
			try
			{
				tmpInfo = tmpMaterializer.entityInfo(STORE_NAME, pEntity);
			}
			catch (pError)
			{
				tmpInfo = null;
			}
		}
		return (
			{
				Lossy: (tmpInfo && tmpInfo.Lossy && (typeof(tmpInfo.Lossy) === 'object')) ? tmpInfo.Lossy : {},
				FillingColumns: (tmpInfo && Array.isArray(tmpInfo.FillingColumns)) ? tmpInfo.FillingColumns : []
			});
	}

	/**
	 * Is the store usable: configured, connected and (outside the static test seam) materialized by a
	 * running materializer?
	 *
	 * @return {{ Ready: boolean, Reason: string|null }}
	 */
	storeReady()
	{
		let tmpStore = this.store();
		if (!tmpStore || (typeof(tmpStore.queryRows) !== 'function'))
		{
			return { Ready: false, Reason: 'StoreUnavailable' };
		}
		let tmpStatus = null;
		try
		{
			tmpStatus = (typeof(tmpStore.status) === 'function') ? tmpStore.status() : null;
		}
		catch (pError)
		{
			tmpStatus = null;
		}
		if (!tmpStatus || (tmpStatus.Available !== true))
		{
			return { Ready: false, Reason: 'StoreUnavailable' };
		}
		if (this._Static)
		{
			return { Ready: true, Reason: null };
		}
		let tmpOptions = this.options || {};
		if (tmpOptions.Materializer && (tmpOptions.Materializer.Enabled === false))
		{
			return { Ready: false, Reason: 'StoreUnavailable' };
		}
		// O(1): capable() runs per Agg per request — never build Materializer.status() here.
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		let tmpAvailable = false;
		try
		{
			tmpAvailable = !!(tmpMaterializer && (typeof(tmpMaterializer.storeAvailable) === 'function') && tmpMaterializer.storeAvailable(STORE_NAME));
		}
		catch (pError)
		{
			tmpAvailable = false;
		}
		if (!tmpAvailable)
		{
			return { Ready: false, Reason: 'StoreUnavailable' };
		}
		return { Ready: true, Reason: null };
	}

	/**
	 * One resolved store option (the store's own resolved section first, then the service options).
	 *
	 * @param {string} pName
	 * @param {any} pDefault
	 * @return {any}
	 */
	storeOption(pName, pDefault)
	{
		let tmpStore = this.store();
		let tmpResolved = null;
		try
		{
			tmpResolved = (tmpStore && (typeof(tmpStore.resolvedOptions) === 'function')) ? tmpStore.resolvedOptions() : null;
		}
		catch (pError)
		{
			tmpResolved = null;
		}
		let tmpSections = [ tmpResolved, tmpStore ? tmpStore.StoreOptions : null, (this.options && this.options.Stores) ? this.options.Stores.ClickHouse : null ];
		for (let i = 0; i < tmpSections.length; i++)
		{
			if (tmpSections[i] && (typeof(tmpSections[i]) === 'object') && hasOwn(tmpSections[i], pName))
			{
				return tmpSections[i][pName];
			}
		}
		return pDefault;
	}

	/**
	 * The ClickHouse database the store reads.
	 *
	 * @return {string|null}
	 */
	database()
	{
		let tmpStore = this.store();
		if (!tmpStore)
		{
			return null;
		}
		if (typeof(tmpStore.Database) === 'string')
		{
			return tmpStore.Database;
		}
		try
		{
			let tmpStatus = (typeof(tmpStore.status) === 'function') ? tmpStore.status() : null;
			return (tmpStatus && (typeof(tmpStatus.Database) === 'string')) ? tmpStatus.Database : null;
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * The source dialect of an entity ('SQLite' | 'PostgreSQL'): MaterializeSource, else the host.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {string}
	 */
	sourceDialect(pContext, pEntity)
	{
		let tmpSource = this.fable.RetoldFacetingMaterializeSourceInProcess;
		if (tmpSource && (typeof(tmpSource.dialect) === 'function'))
		{
			try
			{
				let tmpDialect = tmpSource.dialect(pEntity);
				if ((tmpDialect === 'SQLite') || (tmpDialect === 'PostgreSQL'))
				{
					return tmpDialect;
				}
			}
			catch (pError)
			{
				// (a skeleton or an unknown entity: the host decides)
			}
		}
		let tmpHost = (pContext && pContext.Host) ? pContext.Host : null;
		let tmpProfile = (tmpHost && (typeof(tmpHost.getDialectProfile) === 'function')) ? tmpHost.getDialectProfile(pEntity) : null;
		if (tmpProfile && (tmpProfile.Name === 'PostgreSQL'))
		{
			return 'PostgreSQL';
		}
		if (pContext && (pContext.Dialect === 'PostgreSQL'))
		{
			return 'PostgreSQL';
		}
		return 'SQLite';
	}

	/**
	 * The source's string order for the compiler ('Auto' → Binary on SQLite, Collated on PostgreSQL).
	 *
	 * @param {string} pDialect
	 * @return {string}
	 */
	stringOrder(pDialect)
	{
		let tmpOrder = this.storeOption('SourceStringOrder', 'Auto');
		if ((tmpOrder === 'Binary') || (tmpOrder === 'Collated'))
		{
			return tmpOrder;
		}
		return (pDialect === 'SQLite') ? 'Binary' : 'Collated';
	}

	// ================================================================== capability

	/**
	 * The Variant of an Agg (normalized as EngineLive does).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @return {Record<string, any>|null}
	 */
	variantFor(pContext, pAgg)
	{
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		if (tmpLive && (typeof(tmpLive.variantFor) === 'function'))
		{
			return tmpLive.variantFor(pContext, pAgg);
		}
		return { VariantId: pAgg.VariantId || 'v0', Conjuncts: [], PathPred: null, IncludesDeleted: false };
	}

	/**
	 * Does an Agg read deleted rows (Show-deleted): its Variant IncludesDeleted, keeps or excludes a
	 * conjunct that NamesDeleted, or a tuple side is ClientControlled?
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @return {boolean}
	 */
	namesDeleted(pContext, pAgg)
	{
		let tmpVariantId = (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0';
		let tmpVariant = (pContext && pContext.Variants && hasOwn(pContext.Variants, tmpVariantId)) ? pContext.Variants[tmpVariantId] : null;
		let fNames = (pConjuncts) => { return (Array.isArray(pConjuncts) ? pConjuncts : []).some((pConjunct) => { return pConjunct && (pConjunct.NamesDeleted === true); }); };
		if (tmpVariant)
		{
			if ((tmpVariant.IncludesDeleted === true) || fNames(tmpVariant.Conjuncts) || fNames(tmpVariant.ColumnConjuncts))
			{
				return true;
			}
			let tmpExcluded = Array.isArray(tmpVariant.ExcludedIds) ? tmpVariant.ExcludedIds : [];
			let tmpAll = (pContext.FilterAST && Array.isArray(pContext.FilterAST.Conjuncts)) ? pContext.FilterAST.Conjuncts : [];
			if (tmpAll.some((pConjunct) => { return pConjunct && (tmpExcluded.indexOf(pConjunct.Id) >= 0) && (pConjunct.NamesDeleted === true); }))
			{
				return true;
			}
		}
		else if ((tmpVariantId === 'v0') && pContext && pContext.FilterAST && ((pContext.FilterAST.IncludesDeleted === true) || fNames(pContext.FilterAST.Conjuncts)))
		{
			return true;
		}
		if (pAgg.Tuple && Array.isArray(pAgg.Tuple.Sides))
		{
			if (pAgg.Tuple.Sides.some((pSide) => { return pSide && pSide.Rel && (pSide.Rel.SoftDelete === 'ClientControlled'); }))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * The DepSet of an Agg (§24.10): Agg.DepSet ∪ FoldIR.depSet(Agg, Variant) ∪ every relation the
	 * compiler reads (alias → entity), '@' fields dropped.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pAgg
	 * @return {Record<string, Array<string>>}
	 */
	depSet(pContext, pAgg)
	{
		let tmpSets = {};
		let fAdd = (pEntity, pColumn) =>
		{
			if ((typeof(pEntity) !== 'string') || (typeof(pColumn) !== 'string') || (pColumn.length < 1) || (pColumn.charAt(0) === '@'))
			{
				return;
			}
			if (!hasOwn(tmpSets, pEntity))
			{
				tmpSets[pEntity] = {};
			}
			tmpSets[pEntity][pColumn] = true;
		};
		let fAddSet = (pDepSet) =>
		{
			if (!pDepSet || (typeof(pDepSet) !== 'object'))
			{
				return;
			}
			Object.keys(pDepSet).forEach((pEntity) => { (Array.isArray(pDepSet[pEntity]) ? pDepSet[pEntity] : []).forEach((pColumn) => { fAdd(pEntity, pColumn); }); });
		};
		fAddSet(pAgg.DepSet);
		let tmpVariantId = (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0';
		let tmpVariant = (pContext && pContext.Variants && hasOwn(pContext.Variants, tmpVariantId)) ? pContext.Variants[tmpVariantId] : null;
		let tmpFoldIR = this.fable.RetoldFacetingFoldIR;
		if (tmpFoldIR && (typeof(tmpFoldIR.depSet) === 'function'))
		{
			try
			{
				fAddSet(tmpFoldIR.depSet(pAgg, tmpVariant, this.fable.RetoldFacetingCatalog));
			}
			catch (pError)
			{
				// (a malformed tree: the compiler refuses it)
			}
		}
		let tmpCollected = libFoldCompiler.collectRelations(pAgg, { PathPred: tmpVariant ? (tmpVariant.PathPred || null) : null });
		if (tmpCollected && Array.isArray(tmpCollected.Relations))
		{
			tmpCollected.Relations.forEach(
				(pRelation) =>
				{
					let tmpEntity = pRelation.Entity || pAgg.Pivot;
					if (typeof(tmpEntity) !== 'string')
					{
						return;
					}
					if (!hasOwn(tmpSets, tmpEntity))
					{
						tmpSets[tmpEntity] = {};
					}
					pRelation.Columns.forEach((pColumn) => { fAdd(tmpEntity, pColumn); });
				});
		}
		if ((typeof(pAgg.Pivot) === 'string') && !hasOwn(tmpSets, pAgg.Pivot))
		{
			tmpSets[pAgg.Pivot] = {};
		}
		let tmpResult = {};
		Object.keys(tmpSets).sort().forEach((pEntity) => { tmpResult[pEntity] = Object.keys(tmpSets[pEntity]).sort(); });
		return tmpResult;
	}

	/**
	 * The closure rule (§55.3): MirrorSpec.covers, or (static mirrors) the same check over the specs.
	 *
	 * @param {Record<string, Array<string>>} pDepSet
	 * @param {Record<string, Array<string>>} pFilling
	 * @return {{ Covered: boolean, Reason: string|null }}
	 */
	covers(pDepSet, pFilling)
	{
		let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
		if (!(this._Static && this._Static.Specs) && tmpMirrorSpec && (typeof(tmpMirrorSpec.covers) === 'function'))
		{
			try
			{
				let tmpCovers = tmpMirrorSpec.covers(STORE_NAME, pDepSet, pFilling);
				if (tmpCovers && (typeof(tmpCovers.Covered) === 'boolean'))
				{
					return { Covered: tmpCovers.Covered, Reason: tmpCovers.Covered ? null : (tmpCovers.Reason || 'NotMirrored') };
				}
			}
			catch (pError)
			{
				return { Covered: false, Reason: 'StoreUnavailable' };
			}
		}
		let tmpEntities = Object.keys(pDepSet || {}).sort();
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpSpec = this.spec(tmpEntities[i]);
			if (!tmpSpec || !Array.isArray(tmpSpec.Columns))
			{
				return { Covered: false, Reason: `NotMirrored:${tmpEntities[i]}` };
			}
			let tmpNames = Array.isArray(tmpSpec.ColumnNames) ? tmpSpec.ColumnNames : tmpSpec.Columns.map((pColumn) => { return pColumn.Column; });
			let tmpFilling = (pFilling && Array.isArray(pFilling[tmpEntities[i]])) ? pFilling[tmpEntities[i]] : [];
			let tmpColumns = pDepSet[tmpEntities[i]];
			for (let j = 0; j < tmpColumns.length; j++)
			{
				if ((tmpNames.indexOf(tmpColumns[j]) < 0) || (tmpFilling.indexOf(tmpColumns[j]) >= 0))
				{
					return { Covered: false, Reason: `NotMirrored:${tmpEntities[i]}.${tmpColumns[j]}` };
				}
			}
		}
		return { Covered: true, Reason: null };
	}

	/**
	 * Pure, static (§64.1).  Freshness admission is the Router's.
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pContext
	 * @return {{ Capable: boolean, Reason?: string }}
	 */
	capable(pAgg, pContext)
	{
		let tmpReady = this.storeReady();
		if (!tmpReady.Ready)
		{
			return { Capable: false, Reason: tmpReady.Reason || 'StoreUnavailable' };
		}
		if (pContext && (typeof(pContext.Mode) === 'string') && (pContext.Mode !== 'Query'))
		{
			return { Capable: false, Reason: 'Mode' };
		}
		if (!pAgg || (typeof(pAgg) !== 'object'))
		{
			return { Capable: false, Reason: 'KindUnsupported:None' };
		}
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		if (tmpLive && (typeof(tmpLive.capable) === 'function'))
		{
			let tmpLiveCapable = tmpLive.capable(pAgg, pContext);
			if (!tmpLiveCapable || !tmpLiveCapable.Capable)
			{
				return { Capable: false, Reason: `KindUnsupported:${pAgg.Kind}` };
			}
		}
		if (this.namesDeleted(pContext || {}, pAgg))
		{
			return { Capable: false, Reason: 'DeletedRowsNotMirrored' };
		}
		let tmpDepSet = this.depSet(pContext || {}, pAgg);
		let tmpEntities = Object.keys(tmpDepSet);
		let tmpFilling = {};
		let tmpInfos = {};
		for (let i = 0; i < tmpEntities.length; i++)
		{
			tmpInfos[tmpEntities[i]] = this.entityInfo(tmpEntities[i]);
			if (tmpInfos[tmpEntities[i]].FillingColumns.length > 0)
			{
				tmpFilling[tmpEntities[i]] = tmpInfos[tmpEntities[i]].FillingColumns.slice();
			}
		}
		let tmpCovers = this.covers(tmpDepSet, tmpFilling);
		if (!tmpCovers.Covered)
		{
			return { Capable: false, Reason: tmpCovers.Reason || 'NotMirrored' };
		}
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpLossy = tmpInfos[tmpEntities[i]].Lossy;
			let tmpColumns = tmpDepSet[tmpEntities[i]];
			for (let j = 0; j < tmpColumns.length; j++)
			{
				if (hasOwn(tmpLossy, tmpColumns[j]) && (tmpLossy[tmpColumns[j]] === 'Value'))
				{
					return { Capable: false, Reason: `LossyColumn:${tmpEntities[i]}.${tmpColumns[j]}` };
				}
			}
		}
		// 'Compare' columns only fail predicates (§56.3); the Variant's conjuncts are predicates on the
		// pivot, decided here so the Router needs no capture round (the compiler checks the rest).
		let tmpVariantId = (typeof(pAgg.VariantId) === 'string') ? pAgg.VariantId : 'v0';
		let tmpVariant = (pContext && pContext.Variants && hasOwn(pContext.Variants, tmpVariantId)) ? pContext.Variants[tmpVariantId] : null;
		let tmpPivotLossy = (typeof(pAgg.Pivot) === 'string') && hasOwn(tmpInfos, pAgg.Pivot) ? tmpInfos[pAgg.Pivot].Lossy : {};
		let tmpConjuncts = (tmpVariant && Array.isArray(tmpVariant.Conjuncts)) ? tmpVariant.Conjuncts : [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpFields = (tmpConjuncts[i] && Array.isArray(tmpConjuncts[i].Fields)) ? tmpConjuncts[i].Fields : [];
			for (let j = 0; j < tmpFields.length; j++)
			{
				if (hasOwn(tmpPivotLossy, tmpFields[j]) && (tmpPivotLossy[tmpFields[j]] === 'Compare'))
				{
					return { Capable: false, Reason: `LossyColumn:${pAgg.Pivot}.${tmpFields[j]}` };
				}
			}
		}
		let tmpFreshness = this.fable.RetoldFacetingFreshness;
		if (tmpFreshness && (typeof(tmpFreshness.breakerOpen) === 'function'))
		{
			let tmpNow = Date.now();
			for (let i = 0; i < tmpEntities.length; i++)
			{
				if (tmpFreshness.breakerOpen(ENGINE_NAME, tmpEntities[i], tmpNow, 'Read'))
				{
					return { Capable: false, Reason: `Breaker:${tmpEntities[i]}` };
				}
			}
		}
		return { Capable: true };
	}

	/**
	 * @param {Record<string, Array<string>>} pDepSet
	 * @return {{ Exact: boolean, AsOf: string|null, LagMS: number }}
	 */
	freshness(pDepSet)
	{
		let tmpFreshness = this.fable.RetoldFacetingFreshness;
		if (tmpFreshness && (typeof(tmpFreshness.freshness) === 'function'))
		{
			return tmpFreshness.freshness(ENGINE_NAME, pDepSet, Date.now());
		}
		return { Exact: false, AsOf: null, LagMS: Infinity };
	}

	// ================================================================== execute

	/**
	 * A warning at most once per 10 s per key (a store outage must not log a line per statement).
	 *
	 * @param {string} pKey
	 * @param {string} pMessage
	 */
	warnRateLimited(pKey, pMessage)
	{
		if (!this._Warned)
		{
			this._Warned = new Map();
		}
		let tmpNow = Date.now();
		let tmpEntry = this._Warned.get(pKey);
		if (tmpEntry && ((tmpNow - tmpEntry.At) < 10000))
		{
			tmpEntry.Suppressed++;
			return;
		}
		let tmpSuppressed = tmpEntry ? tmpEntry.Suppressed : 0;
		this._Warned.set(pKey, { At: tmpNow, Suppressed: 0 });
		if (this._Warned.size > 1000)
		{
			this._Warned.clear();
		}
		this.fable.log.warn(`${pMessage}${(tmpSuppressed > 0) ? ` (${tmpSuppressed} similar warning(s) suppressed)` : ''}`);
	}

	/**
	 * A store error (the Router falls back to Live on .StoreError).
	 *
	 * @param {string} pMessage
	 * @param {Error} [pCause]
	 * @return {Error}
	 */
	storeError(pMessage, pCause)
	{
		let tmpError = libFacetErrors.create('FACET_ENGINE_UNAVAILABLE', pMessage);
		tmpError.StoreError = true;
		if (pCause)
		{
			tmpError.Cause = pCause;
			tmpError.Code = pCause.Code || tmpError.Code;
			tmpError.Status = pCause.Status;
		}
		return tmpError;
	}

	/**
	 * Execute every Agg (§64.2).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	execute(pContext, pAggs, fCallback)
	{
		return this.run(pContext, pAggs, false, fCallback);
	}

	/**
	 * Capture, probe and compile every Agg exactly as execute() does, without running a statement:
	 * the goldens' entry point (EngineLive.compileComposedAgg's role for the store).  A cube is
	 * compiled (Cubes[CubeId]) and its members are compiled per Variant as well.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {(pError?: Error, pCompiled?: { Compiled: Record<string, { Statements: Array<Record<string, any>>, Fold: string, Input: Record<string, any> }>, Cubes: Record<string, Record<string, any>>, Refused: Record<string, string>, Errors: Record<string, any>, Captures: Record<string, any> }) => void} fCallback
	 */
	compile(pContext, pAggs, fCallback)
	{
		return this.run(pContext, pAggs, true, fCallback);
	}

	/**
	 * execute() / compile().
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {boolean} pDryRun
	 * @param {(pError?: Error, pResult?: Record<string, any>) => void} fCallback
	 */
	run(pContext, pAggs, pDryRun, fCallback)
	{
		let tmpContext = pContext || {};
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}
		let tmpExecution = this.newExecution(tmpContext);
		tmpExecution.Refused = {};
		tmpExecution.Freshness = {};
		tmpExecution.CubeFallbacks = [];
		tmpExecution.LagMS = 0;
		let tmpReady = this.storeReady();
		if (!tmpReady.Ready)
		{
			return fCallback(this.storeError('The ClickHouse store is unavailable.'));
		}
		if (!this.fable.RetoldFacetingScopedRelationBuilder || (typeof(this.fable.RetoldFacetingScopedRelationBuilder.captureRelation) !== 'function')
			|| !this.fable.RetoldFacetingEngineLive || !tmpContext.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The ClickHouse engine is not wired.'));
		}
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		let tmpRun = { Store: this.store(), Ran: [], StoreFailures: {}, FirstStoreError: null, DryRun: (pDryRun === true), Cubes: {} };

		// Phase 0: capability and one group per (Pivot, Variant); each TuplePivot Agg alone.
		let tmpGroups = [];
		let tmpGroupsByKey = Object.create(null);
		let tmpCapable = [];
		for (let i = 0; i < tmpAggs.length; i++)
		{
			let tmpAgg = tmpAggs[i];
			let tmpKey = (tmpAgg && (typeof(tmpAgg.Key) === 'string')) ? tmpAgg.Key : `#${i}`;
			let tmpCheck = this.capable(tmpAgg, tmpContext);
			if (!tmpCheck.Capable)
			{
				tmpExecution.Refused[tmpKey] = tmpCheck.Reason;
				continue;
			}
			let tmpVariant = this.variantFor(tmpContext, tmpAgg);
			if (!tmpVariant)
			{
				tmpExecution.Refused[tmpKey] = 'ShapeUnsupported:Variant';
				continue;
			}
			tmpCapable.push(tmpAgg);
			let tmpTuple = !!(tmpAgg.Tuple && (typeof(tmpAgg.Tuple) === 'object'));
			let tmpGroupKey = tmpTuple ? `tuple|${tmpKey}` : `${tmpAgg.Pivot}|${tmpVariant.VariantId}`;
			if (!hasOwn(tmpGroupsByKey, tmpGroupKey))
			{
				tmpGroupsByKey[tmpGroupKey] = { Entity: tmpAgg.Pivot, Variant: tmpVariant, Tuple: tmpTuple, Aggs: [], Captured: {}, Fragments: {} };
				tmpGroups.push(tmpGroupsByKey[tmpGroupKey]);
			}
			tmpGroupsByKey[tmpGroupKey].Aggs.push(tmpAgg);
		}

		let tmpWork = [];
		let tmpDone = new Set();

		let fFinish = () =>
		{
			let tmpRanKeys = tmpRun.Ran;
			let tmpFailedKeys = Object.keys(tmpRun.StoreFailures);
			if ((tmpFailedKeys.length > 0) && (tmpFailedKeys.length >= tmpRanKeys.length) && (Object.keys(tmpExecution.Results).length < 1) && (Object.keys(tmpExecution.Errors).length < 1))
			{
				// Every store attempt failed: the whole call is a store error (the Router falls back).
				return fCallback(this.storeError('The ClickHouse store failed.', tmpRun.FirstStoreError));
			}
			tmpExecution.StoreErrors = {};
			for (let i = 0; i < tmpFailedKeys.length; i++)
			{
				tmpExecution.Refused[tmpFailedKeys[i]] = 'StoreError';
				tmpExecution.StoreErrors[tmpFailedKeys[i]] = tmpRun.StoreFailures[tmpFailedKeys[i]];
				delete tmpExecution.Results[tmpFailedKeys[i]];
			}
			tmpExecution.StoreError = tmpRun.FirstStoreError || null;
			let tmpFreshKeys = Object.keys(tmpExecution.Freshness).filter((pKey) => { return hasOwn(tmpExecution.Results, pKey); });
			tmpExecution.Exact = (tmpFreshKeys.length > 0) && tmpFreshKeys.every((pKey) => { return tmpExecution.Freshness[pKey].Exact === true; });
			tmpExecution.LagMS = tmpFreshKeys.reduce((pMax, pKey) => { let tmpLag = tmpExecution.Freshness[pKey].LagMS; return ((typeof(tmpLag) === 'number') && (tmpLag > pMax)) ? tmpLag : pMax; }, 0);
			return fCallback(null, tmpExecution);
		};

		// Phase 3: the statements, bounded parallelism.
		let fRunStatements = () =>
		{
			if (tmpRun.DryRun)
			{
				let tmpCompiled = {};
				tmpWork.forEach((pItem) => { tmpCompiled[pItem.Agg.Key] = { Statements: pItem.Compiled.Statements, Fold: pItem.Compiled.Fold, Input: pItem.Input }; });
				return fCallback(null, { Compiled: tmpCompiled, Cubes: tmpRun.Cubes, Refused: tmpExecution.Refused, Errors: tmpExecution.Errors, Captures: tmpExecution.Captures, CubeFallbacks: tmpExecution.CubeFallbacks });
			}
			let tmpOptions = tmpContext.Options || this.options;
			let tmpParallel = (tmpOptions.Execution && (tmpOptions.Execution.MaxParallelStatements >= 1)) ? Math.floor(tmpOptions.Execution.MaxParallelStatements) : 4;
			this.fable.Utility.eachLimit(tmpWork, tmpParallel,
				(pItem, fItemDone) =>
				{
					tmpRun.Ran.push(pItem.Agg.Key);
					this.runAgg(tmpContext, tmpExecution, tmpRun, pItem,
						(pError, pRaw) =>
						{
							if (pError)
							{
								if (pError.StoreError)
								{
									tmpRun.StoreFailures[pItem.Agg.Key] = pError;
									tmpRun.FirstStoreError = tmpRun.FirstStoreError || pError;
								}
								else
								{
									tmpExecution.Errors[pItem.Agg.Key] = libFacetErrors.toEntry(pError);
								}
							}
							else if (pRaw && pRaw.Refused)
							{
								tmpExecution.Refused[pItem.Agg.Key] = pRaw.Refused;
							}
							else
							{
								tmpExecution.Results[pItem.Agg.Key] = pRaw;
							}
							return fItemDone();
						});
				},
				() =>
				{
					return fFinish();
				});
		};

		// Phase 2: per group, sequentially: captures, probes, compilation.
		let fCompose = (pIndex) =>
		{
			if (pIndex >= tmpGroups.length)
			{
				return fRunStatements();
			}
			let tmpGroup = tmpGroups[pIndex];
			tmpGroup.Aggs = tmpGroup.Aggs.filter((pAgg) => { return !tmpDone.has(pAgg.Key); });
			if (tmpGroup.Aggs.length < 1)
			{
				return fCompose(pIndex + 1);
			}
			this.composeGroup(tmpContext, tmpExecution, tmpGroup, tmpWork,
				(pGroupError) =>
				{
					if (pGroupError)
					{
						return fCallback(pGroupError);
					}
					return fCompose(pIndex + 1);
				});
		};

		// Phase 1: the conditional disjunctive scans whose members are all here.
		let tmpCubes = this.cubePlans(tmpContext);
		let tmpCubeExecutor = this.fable.RetoldFacetingCubeExecutor;
		if ((tmpCubes.length < 1) || !tmpCubeExecutor || (tmpContext.PlanForm && (tmpContext.PlanForm.Cube === 'Never')))
		{
			return fCompose(0);
		}
		this.fable.Utility.eachLimit(tmpCubes, 1,
			(pCubePlan, fCubeDone) =>
			{
				let tmpMembers = [];
				let tmpMemberAggs = [];
				(Array.isArray(pCubePlan.Members) ? pCubePlan.Members : []).forEach(
					(pMember) =>
					{
						let tmpAgg = tmpCapable.find((pAgg) => { return (pAgg.Key === pMember.AggKey) && !pAgg.Tuple; });
						if (tmpAgg && !tmpDone.has(tmpAgg.Key))
						{
							tmpMembers.push(pMember);
							tmpMemberAggs.push(tmpAgg);
						}
					});
				if ((tmpMembers.length < 1) || (tmpMembers.length !== (Array.isArray(pCubePlan.Members) ? pCubePlan.Members.length : 0)))
				{
					// A member is not store-routed (refused here, or answered Live): every member runs
					// per Variant (§63.6), exactly as Live does when a member is missing.
					if (tmpMembers.length > 0)
					{
						tmpExecution.CubeFallbacks.push(pCubePlan.CubeId);
					}
					return fCubeDone();
				}
				this.executeCube(tmpContext, tmpExecution, tmpRun, pCubePlan, tmpMemberAggs,
					(pCubeError, pCubeResult) =>
					{
						if (pCubeError)
						{
							return fCubeDone(pCubeError);
						}
						if (pCubeResult && pCubeResult.StoreFailed)
						{
							// The grain statement failed on the store: every member is a store failure (the
							// Router answers them Live and counts the breaker) — never re-run per Variant on a
							// store that just failed.
							tmpMemberAggs.forEach(
								(pAgg) =>
								{
									tmpRun.Ran.push(pAgg.Key);
									tmpRun.StoreFailures[pAgg.Key] = pCubeResult.StoreFailed;
									tmpDone.add(pAgg.Key);
								});
							tmpRun.FirstStoreError = tmpRun.FirstStoreError || pCubeResult.StoreFailed;
							return fCubeDone();
						}
						if (!pCubeResult || pCubeResult.FellBack)
						{
							tmpExecution.CubeFallbacks.push(pCubePlan.CubeId);
							return fCubeDone();
						}
						Object.keys(pCubeResult.Results || {}).forEach((pKey) => { tmpExecution.Results[pKey] = pCubeResult.Results[pKey]; tmpDone.add(pKey); });
						Object.keys(pCubeResult.Errors || {}).forEach((pKey) => { tmpExecution.Errors[pKey] = pCubeResult.Errors[pKey]; tmpDone.add(pKey); });
						return fCubeDone();
					});
			},
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCompose(0);
			});
	}

	/**
	 * The cube plans of the request (Plan.Cubes, §25.2).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Array<Record<string, any>>}
	 */
	cubePlans(pContext)
	{
		let tmpCubes = (pContext && Array.isArray(pContext.Cubes) && (pContext.Cubes.length > 0)) ? pContext.Cubes
			: (pContext && pContext.Plan && Array.isArray(pContext.Plan.Cubes)) ? pContext.Plan.Cubes
			: [];
		return tmpCubes.filter((pCube) => { return pCube && (typeof(pCube.CubeId) === 'string'); });
	}

	/**
	 * Is a relation error whole-request?  (EngineLive's rule, §19.7.)
	 *
	 * @param {Error} pError
	 * @param {boolean} pFilterLevel
	 * @return {boolean}
	 */
	isWholeRequestError(pError, pFilterLevel)
	{
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		if (tmpLive && (typeof(tmpLive.isWholeRequestError) === 'function'))
		{
			return tmpLive.isWholeRequestError(pError, pFilterLevel);
		}
		return true;
	}

	/**
	 * A projection: the identity first, then the sorted unique columns.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {Array<string>} pColumns
	 * @return {Array<string>}
	 */
	projection(pContext, pEntity, pColumns)
	{
		let tmpPrimaryKey = pContext.Host.getPrimaryKey(pEntity);
		let tmpOthers = Array.from(new Set(pColumns || [])).filter((pColumn) => { return pColumn !== tmpPrimaryKey; }).sort();
		return (typeof(tmpPrimaryKey) === 'string') ? [ tmpPrimaryKey ].concat(tmpOthers) : tmpOthers;
	}

	/**
	 * Capture a list of relations sequentially into pCaptured (alias → capture).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Array<{ Alias: string, Rel: Record<string, any> }>} pRels
	 * @param {Record<string, any>} pCaptured
	 * @param {(pError?: Error, pOpaque?: string|null) => void} fCallback - pOpaque: 'OpaqueScope:<E>' of the first Opaque capture
	 */
	captureAll(pContext, pExecution, pRels, pCaptured, fCallback)
	{
		let tmpBuilder = this.fable.RetoldFacetingScopedRelationBuilder;
		let fNext = (pIndex) =>
		{
			if (pIndex >= pRels.length)
			{
				return fCallback(null, null);
			}
			let tmpItem = pRels[pIndex];
			if (hasOwn(pCaptured, tmpItem.Alias))
			{
				return fNext(pIndex + 1);
			}
			tmpBuilder.captureRelation(pContext, tmpItem.Rel,
				(pError, pCapture) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					pCaptured[tmpItem.Alias] = pCapture;
					if (pCapture.Capture)
					{
						this.recordEntityCapture(pExecution, pCapture.Entity, pCapture.Capture);
					}
					if (pCapture.Opaque)
					{
						return fCallback(null, `OpaqueScope:${pCapture.Entity}`);
					}
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	}

	/**
	 * Probe the column leaves a fragment renders outside its relation for behavior operator transforms
	 * (PredicateCompiler.probeTransforms, memoized per request — exactly Live's probe), and collect the
	 * transforms of every probed entity as { Entity: { <signature>: <operator> } }.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, Array<Record<string, any>>>} pLeaves - alias → leaves
	 * @param {Record<string, string>} pAliasEntities - alias → entity
	 * @param {(pError?: Error, pFragments?: Record<string, Record<string, string>>, pTransformed?: number) => void} fCallback
	 */
	probeLeaves(pContext, pLeaves, pAliasEntities, fCallback)
	{
		let tmpByEntity = new Map();
		Object.keys(pLeaves || {}).forEach(
			(pAlias) =>
			{
				let tmpEntity = hasOwn(pAliasEntities, pAlias) ? pAliasEntities[pAlias] : null;
				if (!tmpEntity)
				{
					return;
				}
				if (!tmpByEntity.has(tmpEntity))
				{
					tmpByEntity.set(tmpEntity, []);
				}
				tmpByEntity.set(tmpEntity, tmpByEntity.get(tmpEntity).concat(pLeaves[pAlias]));
			});
		let tmpEntities = Array.from(tmpByEntity.keys());
		let tmpCompiler = this.fable.RetoldFacetingPredicateCompiler;
		let tmpTransformed = 0;
		let fCollect = () =>
		{
			let tmpFragments = {};
			let tmpProbes = (pContext.Memo && (pContext.Memo.FragmentProbes instanceof Map)) ? pContext.Memo.FragmentProbes : null;
			if (tmpProbes)
			{
				tmpProbes.forEach(
					(pProbe, pEntity) =>
					{
						if (pProbe && (pProbe.Transforms instanceof Map) && (pProbe.Transforms.size > 0))
						{
							tmpFragments[pEntity] = {};
							pProbe.Transforms.forEach((pOperator, pSignature) => { tmpFragments[pEntity][pSignature] = pOperator; });
						}
					});
			}
			return fCallback(null, tmpFragments, tmpTransformed);
		};
		if ((tmpEntities.length < 1) || !tmpCompiler || (typeof(tmpCompiler.probeTransforms) !== 'function'))
		{
			return fCollect();
		}
		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpEntities.length)
			{
				return fCollect();
			}
			tmpCompiler.probeTransforms(pContext, tmpEntities[pIndex], tmpByEntity.get(tmpEntities[pIndex]),
				(pError, pCount) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					tmpTransformed += (pCount || 0);
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	}

	/**
	 * The compile input shared by an Agg's statements.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pCaptured - alias → capture
	 * @param {Record<string, any>} pVariant
	 * @param {Record<string, any>} pFragments
	 * @param {string} pPivotEntity
	 * @return {Record<string, any>}
	 */
	compileInput(pContext, pCaptured, pVariant, pFragments, pPivotEntity)
	{
		let tmpSpecs = {};
		let tmpLossy = {};
		let tmpFilling = {};
		let tmpRelations = {};
		Object.keys(pCaptured).forEach(
			(pAlias) =>
			{
				let tmpCapture = pCaptured[pAlias];
				tmpRelations[pAlias] = { Entity: tmpCapture.Entity, Filter: tmpCapture.Filter, Capture: tmpCapture.Capture };
				if (!hasOwn(tmpSpecs, tmpCapture.Entity))
				{
					let tmpSpec = this.spec(tmpCapture.Entity);
					if (tmpSpec)
					{
						tmpSpecs[tmpCapture.Entity] = tmpSpec;
					}
					let tmpInfo = this.entityInfo(tmpCapture.Entity);
					tmpLossy[tmpCapture.Entity] = tmpInfo.Lossy;
					tmpFilling[tmpCapture.Entity] = tmpInfo.FillingColumns;
				}
			});
		let tmpDialect = this.sourceDialect(pContext, pPivotEntity);
		let tmpOptions = pContext.Options || this.options;
		return (
			{
				Database: this.database(),
				Specs: tmpSpecs,
				Relations: tmpRelations,
				Variant: { PathPred: (pVariant && pVariant.PathPred) ? pVariant.PathPred : null },
				Fragments: pFragments || {},
				Lossy: tmpLossy,
				Filling: tmpFilling,
				SourceDialect: tmpDialect,
				SourceStringOrder: this.stringOrder(tmpDialect),
				Limits: tmpOptions.Limits || {},
				Geometry: null
			});
	}

	/**
	 * Phase 2 for one group: the pivot (or nothing for a TuplePivot) and the Variant's path-predicate
	 * hops (filter-level: their errors fail the request like Live's), then per Agg its own captures,
	 * probes and compilation.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pGroup
	 * @param {Array<Record<string, any>>} pWork - receives { Agg, Input, Compiled }
	 * @param {(pError?: Error) => void} fCallback - pError only for whole-request failures
	 */
	composeGroup(pContext, pExecution, pGroup, pWork, fCallback)
	{
		let tmpVariant = pGroup.Variant;
		let fRefuseGroup = (pReason) =>
		{
			pGroup.Aggs.forEach((pAgg) => { pExecution.Refused[pAgg.Key] = pReason; });
			return fCallback(null);
		};
		let fFailGroup = (pError) =>
		{
			pGroup.Aggs.forEach((pAgg) => { pExecution.Errors[pAgg.Key] = libFacetErrors.toEntry(pError); });
			return fCallback(null);
		};
		let fGroupError = (pError) =>
		{
			if (!this.isWholeRequestError(pError, true))
			{
				return fFailGroup(pError);
			}
			return fCallback(pError);
		};

		// What every Agg reads; the Variant's own relations are group-level.
		let tmpVariantCollected = libFoldCompiler.collectRelations({ Kind: 'Count', Pivot: pGroup.Entity, Dimensions: [], Where: null }, { PathPred: tmpVariant.PathPred || null });
		if (tmpVariantCollected.Refused)
		{
			return fRefuseGroup(tmpVariantCollected.Refused);
		}
		let tmpAggCollected = {};
		let tmpAggs = [];
		for (let i = 0; i < pGroup.Aggs.length; i++)
		{
			let tmpCollected = libFoldCompiler.collectRelations(pGroup.Aggs[i], { PathPred: tmpVariant.PathPred || null });
			if (tmpCollected.Refused)
			{
				pExecution.Refused[pGroup.Aggs[i].Key] = tmpCollected.Refused;
				continue;
			}
			tmpAggCollected[pGroup.Aggs[i].Key] = tmpCollected;
			tmpAggs.push(pGroup.Aggs[i]);
		}
		pGroup.Aggs = tmpAggs;
		if (tmpAggs.length < 1)
		{
			return fCallback(null);
		}
		let tmpVariantAliases = tmpVariantCollected.Relations.filter((pRelation) => { return pRelation.Alias !== 'p'; });
		let tmpGroupCaptured = {};

		let fVariantHops = () =>
		{
			let tmpRels = tmpVariantAliases.map((pRelation) => { return { Alias: pRelation.Alias, Rel: Object.assign({}, pRelation.Rel, { Project: this.projection(pContext, pRelation.Entity, pRelation.Columns) }) }; });
			this.captureAll(pContext, pExecution, tmpRels, tmpGroupCaptured,
				(pHopError, pOpaque) =>
				{
					if (pHopError)
					{
						return fGroupError(pHopError);
					}
					if (pOpaque)
					{
						return fRefuseGroup(pOpaque);
					}
					let tmpEntities = {};
					Object.keys(tmpGroupCaptured).forEach((pAlias) => { tmpEntities[pAlias] = tmpGroupCaptured[pAlias].Entity; });
					if (!pGroup.Tuple)
					{
						tmpEntities.p = pGroup.Entity;
					}
					else
					{
						// (a TuplePivot's Variant hops correlate with the Home side 'p': the route entity)
						tmpEntities.p = pGroup.Entity || pContext.Entity;
					}
					this.probeLeaves(pContext, tmpVariantCollected.Leaves, tmpEntities,
						(pProbeError) =>
						{
							if (pProbeError)
							{
								return fGroupError(pProbeError);
							}
							return fAggs(0);
						});
				});
		};

		let fAggs = (pIndex) =>
		{
			if (pIndex >= tmpAggs.length)
			{
				return fCallback(null);
			}
			let tmpAgg = tmpAggs[pIndex];
			this.composeAgg(pContext, pExecution, pGroup, tmpAgg, tmpAggCollected[tmpAgg.Key], tmpGroupCaptured, tmpVariantAliases, pWork,
				(pAggError) =>
				{
					if (pAggError)
					{
						return fCallback(pAggError);
					}
					return fAggs(pIndex + 1);
				});
		};

		if (pGroup.Tuple)
		{
			return fVariantHops();
		}

		// The pivot relation: every column any Agg of the group (or the Variant) reads on 'p'.
		let tmpPivotColumns = [];
		tmpVariantCollected.Relations.concat(...Object.keys(tmpAggCollected).map((pKey) => { return tmpAggCollected[pKey].Relations; })).forEach(
			(pRelation) =>
			{
				if (pRelation.Alias === 'p')
				{
					tmpPivotColumns = tmpPivotColumns.concat(pRelation.Columns);
				}
			});
		let tmpPivotRel = this.fable.RetoldFacetingEngineLive.pivotRel(pContext, pGroup.Entity, tmpVariant, tmpPivotColumns);
		this.captureAll(pContext, pExecution, [ { Alias: 'p', Rel: tmpPivotRel } ], tmpGroupCaptured,
			(pPivotError, pOpaque) =>
			{
				if (pPivotError)
				{
					return fGroupError(pPivotError);
				}
				if (pOpaque)
				{
					return fRefuseGroup(pOpaque);
				}
				return fVariantHops();
			});
	}

	/**
	 * One Agg of a group: its own captures (tuple sides, hops of Agg.Where and the dimensions), its
	 * fragment probes, then compilation.  Errors per Agg as Live (a refused principal fails the request).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pGroup
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pCollected - compiler.collectRelations(pAgg, Variant)
	 * @param {Record<string, any>} pGroupCaptured
	 * @param {Array<Record<string, any>>} pVariantRelations
	 * @param {Array<Record<string, any>>} pWork
	 * @param {(pError?: Error) => void} fCallback
	 */
	composeAgg(pContext, pExecution, pGroup, pAgg, pCollected, pGroupCaptured, pVariantRelations, pWork, fCallback)
	{
		let tmpCaptured = Object.assign({}, pGroupCaptured);
		let tmpVariantAliases = pVariantRelations.map((pRelation) => { return pRelation.Alias; });
		let fAggError = (pError) =>
		{
			if (this.isWholeRequestError(pError, false))
			{
				return fCallback(pError);
			}
			pExecution.Errors[pAgg.Key] = libFacetErrors.toEntry(pError);
			return fCallback(null);
		};
		let tmpRels = [];
		pCollected.Relations.forEach(
			(pRelation) =>
			{
				if ((pRelation.Alias === 'p') && !pGroup.Tuple)
				{
					return;
				}
				if (tmpVariantAliases.indexOf(pRelation.Alias) >= 0)
				{
					return;
				}
				let tmpRel = Object.assign({ Scope: 'Inherit' }, pRelation.Rel, { Project: this.projection(pContext, pRelation.Entity, pRelation.Columns) });
				if (pGroup.Tuple && (pRelation.Rel.Role === 'TupleSide'))
				{
					let tmpHome = (pRelation.Alias === 'p');
					tmpRel.Client = tmpHome ? (Array.isArray(pRelation.Rel.Client) ? pRelation.Rel.Client : pGroup.Variant.Conjuncts) : null;
					tmpRel.SoftDelete = pRelation.Rel.SoftDelete || ((tmpHome && pGroup.Variant.IncludesDeleted) ? 'ClientControlled' : 'Explicit');
				}
				else if (pGroup.Tuple && (pRelation.Alias === 'p'))
				{
					tmpRel.Client = Array.isArray(pRelation.Rel.Client) ? pRelation.Rel.Client : pGroup.Variant.Conjuncts;
				}
				tmpRels.push({ Alias: pRelation.Alias, Rel: tmpRel });
			});
		// Tuple sides first (Home side, then the others), then the hops.
		if (pGroup.Tuple)
		{
			let tmpSides = pAgg.Tuple.Sides.map((pSide) => { return pSide.Alias; });
			tmpRels.sort((pA, pB) =>
			{
				let tmpA = tmpSides.indexOf(pA.Alias);
				let tmpB = tmpSides.indexOf(pB.Alias);
				return ((tmpA < 0) ? 1000 : tmpA) - ((tmpB < 0) ? 1000 : tmpB);
			});
		}
		this.captureAll(pContext, pExecution, tmpRels, tmpCaptured,
			(pCaptureError, pOpaque) =>
			{
				if (pCaptureError)
				{
					return fAggError(pCaptureError);
				}
				if (pOpaque)
				{
					pExecution.Refused[pAgg.Key] = pOpaque;
					return fCallback(null);
				}
				let tmpEntities = {};
				Object.keys(tmpCaptured).forEach((pAlias) => { tmpEntities[pAlias] = tmpCaptured[pAlias].Entity; });
				let tmpAggLeaves = {};
				Object.keys(pCollected.Leaves || {}).forEach((pAlias) => { tmpAggLeaves[pAlias] = pCollected.Leaves[pAlias]; });
				this.probeLeaves(pContext, tmpAggLeaves, tmpEntities,
					(pProbeError, pFragments) =>
					{
						if (pProbeError)
						{
							return fAggError(pProbeError);
						}
						let tmpPivotEntity = pGroup.Tuple ? pAgg.Tuple.Sides[0].Rel.Entity : pGroup.Entity;
						let tmpInput = this.compileInput(pContext, tmpCaptured, pGroup.Variant, pFragments, tmpPivotEntity);
						let tmpCompiled;
						try
						{
							tmpCompiled = libFoldCompiler.compileAgg(pAgg, tmpInput);
						}
						catch (pCompileError)
						{
							this.fable.log.error(`RetoldFaceting ClickHouse could not compile facet ${libRetoldFacetingUtil.logSafe(pAgg.Key)} (${pAgg.Kind}): ${pCompileError.message}`);
							tmpCompiled = { Refused: 'ShapeUnsupported:Internal' };
						}
						if (tmpCompiled.Refused)
						{
							pExecution.Refused[pAgg.Key] = tmpCompiled.Refused;
							return fCallback(null);
						}
						pWork.push({ Agg: pAgg, Input: tmpInput, Compiled: tmpCompiled });
						return fCallback(null);
					});
			});
	}

	// ================================================================== statements

	/**
	 * Run one statement through Store.queryRows with the deadline-bounded settings (§57.3).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pRun
	 * @param {Record<string, any>} pStatement
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback - a store failure has .StoreError
	 */
	query(pContext, pExecution, pRun, pStatement, fCallback)
	{
		let tmpNow = Date.now();
		if ((typeof(pContext.Deadline) === 'number') && (tmpNow > pContext.Deadline))
		{
			return fCallback(libFacetErrors.create('FACET_TIMEOUT'));
		}
		if (pRun.Abandon)
		{
			// An earlier statement of this request found the store unwell: fail fast (the Router answers
			// these Aggs Live with the time that is left).
			return fCallback(pRun.Abandon);
		}
		// The store attempt's budget (Router: DEADLINE_SHARE of the remaining deadline, from routing on):
		// the client time-out of this statement (agent queue time included) and its max_execution_time.
		let tmpDeadlineAt = (pContext.Store && (typeof(pContext.Store.DeadlineAt) === 'number')) ? pContext.Store.DeadlineAt
			: ((typeof(pContext.Deadline) === 'number') ? (tmpNow + Math.floor(DEADLINE_SHARE * (pContext.Deadline - tmpNow))) : null);
		let tmpStoreTimeout = (this.store() && (typeof(this.store().resolvedOptions) === 'function') && this.store().resolvedOptions()) ? this.store().resolvedOptions().TimeoutMS : 20000;
		let tmpBudget = (tmpDeadlineAt === null) ? tmpStoreTimeout : Math.min(tmpStoreTimeout, tmpDeadlineAt - tmpNow);
		if (tmpBudget < 1)
		{
			let tmpSpent = this.storeError('The ClickHouse store used up its share of the request deadline.');
			tmpSpent.TimedOut = true;
			tmpSpent.BudgetMS = Math.max(0, (tmpDeadlineAt || tmpNow) - (pContext.Store && pContext.Store.RoutedAt ? pContext.Store.RoutedAt : tmpNow));
			return fCallback(tmpSpent);
		}
		let tmpSettings = Object.assign({}, pStatement.Settings || libFoldCompiler.READ_SETTINGS);
		tmpSettings.max_execution_time = Math.max(1, Math.ceil(tmpBudget / 1000));
		if ((typeof(pStatement.MaxRows) === 'number') && (pStatement.MaxRows >= 1))
		{
			tmpSettings.max_result_rows = pStatement.MaxRows + 2;
			tmpSettings.result_overflow_mode = 'throw';
		}
		pExecution.Statements++;
		pContext.Counters.StoreStatements = (pContext.Counters.StoreStatements || 0) + 1;
		if (pContext.Store && (typeof(pContext.Store) === 'object'))
		{
			pContext.Store.Statements = (pContext.Store.Statements || 0) + 1;
		}
		let tmpCalledBack = false;
		let fDone = (pError, pRows) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			if (pError)
			{
				// Store messages never carry bound values (the client redacts; values travel as parameters).
				if (!pError.Busy)
				{
					this.warnRateLimited(`statement:${pStatement.Purpose}:${pError.Code || pError.Status || 'error'}`, `RetoldFaceting ClickHouse statement (${pStatement.Purpose}) failed for request ${pContext.RequestID || '?'}: ${libRetoldFacetingUtil.logSafe(String(pError.message || '').slice(0, 300))}`);
				}
				let tmpError = (pError.StoreError === true) ? pError : this.storeError('A ClickHouse statement failed.', pError);
				tmpError.StoreError = true;
				if (typeof(tmpError.BudgetMS) !== 'number')
				{
					tmpError.BudgetMS = tmpBudget;
				}
				// Network trouble or a time-out: the store is unwell for this request — fail the rest fast.
				let tmpStore = pRun.Store;
				if (!pRun.Abandon && (tmpError.Busy || (tmpStore && (typeof(tmpStore.isHealthFailure) === 'function') && tmpStore.isHealthFailure(tmpError, tmpBudget) && ((tmpError.Status === 0) || tmpError.TimedOut))))
				{
					pRun.Abandon = tmpError;
				}
				return fCallback(tmpError);
			}
			return fCallback(null, Array.isArray(pRows) ? pRows : []);
		};
		try
		{
			pRun.Store.queryRows(pStatement.SQL, pStatement.Params || {}, pStatement.Types || {}, tmpSettings, fDone, { Request: true, TimeoutMS: tmpBudget });
		}
		catch (pQueryError)
		{
			return fDone(pQueryError);
		}
	}

	/**
	 * Run a compiled Agg into its RawFacetResult (one statement; NumericHistogram: bounds then buckets;
	 * K9: terms, total, covered) — the Live row folds over the same row shapes.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pRun
	 * @param {{ Agg: Record<string, any>, Input: Record<string, any>, Compiled: Record<string, any> }} pItem
	 * @param {(pError?: Error, pRaw?: Record<string, any>) => void} fCallback
	 */
	runAgg(pContext, pExecution, pRun, pItem, fCallback)
	{
		let tmpAgg = pItem.Agg;
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		// The freshness of the answer, read BEFORE the statements run (§64.2 step 3).
		let tmpFreshness = this.freshness(this.depSet(pContext, tmpAgg)) || {};
		pExecution.Freshness[tmpAgg.Key] = { Exact: tmpFreshness.Exact === true, LagMS: (typeof(tmpFreshness.LagMS) === 'number') ? tmpFreshness.LagMS : Infinity, AsOf: tmpFreshness.AsOf || null, State: tmpFreshness.State || null };
		let fFold = (fWork) =>
		{
			try
			{
				return fCallback(null, fWork());
			}
			catch (pFoldError)
			{
				if (!libFacetErrors.isFacetError(pFoldError))
				{
					this.fable.log.error(`RetoldFaceting ClickHouse could not read the rows of facet ${libRetoldFacetingUtil.logSafe(tmpAgg.Key)} (${tmpAgg.Kind}): ${pFoldError.message}`);
				}
				return fCallback(libFacetErrors.isFacetError(pFoldError) ? pFoldError : libFacetErrors.create('FACET_INTERNAL'));
			}
		};
		let tmpStatements = pItem.Compiled.Statements;
		switch (pItem.Compiled.Fold)
		{
			case 'Multi':
				return this.query(pContext, pExecution, pRun, tmpStatements[0],
					(pTermsError, pTermsRows) =>
					{
						if (pTermsError)
						{
							return fCallback(pTermsError);
						}
						this.query(pContext, pExecution, pRun, tmpStatements[1],
							(pTotalError, pTotalRows) =>
							{
								if (pTotalError)
								{
									return fCallback(pTotalError);
								}
								this.query(pContext, pExecution, pRun, tmpStatements[2],
									(pCoveredError, pCoveredRows) =>
									{
										if (pCoveredError)
										{
											return fCallback(pCoveredError);
										}
										return fFold(() => { return this.foldMulti(tmpAgg, pTermsRows, pTotalRows, pCoveredRows); });
									});
							});
					});

			case 'NumericBounds':
				return this.query(pContext, pExecution, pRun, tmpStatements[0],
					(pBoundsError, pBoundsRows) =>
					{
						if (pBoundsError)
						{
							return fCallback(pBoundsError);
						}
						let tmpRaw = tmpLive.newRaw(tmpAgg);
						let tmpDimension = tmpAgg.Dimensions[0];
						let tmpGeometry;
						try
						{
							let tmpRow = pBoundsRows[0] || {};
							let tmpRows = toCount(tmpRow.Rows);
							let tmpNonNull = toCount(tmpRow.NonNull);
							tmpRaw.Total = tmpRows;
							tmpRaw.MissingCount = tmpRows - tmpNonNull;
							tmpRaw.Bounds = (tmpNonNull > 0) ? { Lo: toNumber(rawKey(tmpRow.Lo)), Hi: toNumber(rawKey(tmpRow.Hi)) } : null;
							tmpGeometry = tmpLive.numericGeometryFor(pContext, tmpDimension, tmpRaw.Bounds);
							tmpRaw.Geometry = tmpGeometry;
						}
						catch (pGeometryError)
						{
							return fCallback(libFacetErrors.isFacetError(pGeometryError) ? pGeometryError : libFacetErrors.create('FACET_INTERNAL'));
						}
						if ((tmpRaw.Bounds === null) || !(tmpGeometry.N >= 1))
						{
							return fCallback(null, tmpRaw);
						}
						let tmpShellGeometry = (tmpDimension.Mode === 'Edges')
							? { Mode: 'Edges', Edges: tmpGeometry.Edges || tmpDimension.Edges, OpenEnded: !!tmpDimension.OpenEnded }
							: { Mode: 'Nice', Factor: tmpGeometry.Factor, LoUnits: tmpGeometry.LoUnits, WidthUnits: tmpGeometry.WidthUnits, N: tmpGeometry.N };
						let tmpBuckets = libFoldCompiler.compileAgg(tmpAgg, Object.assign({}, pItem.Input, { Geometry: tmpShellGeometry }));
						if (tmpBuckets.Refused)
						{
							return fCallback(null, { Refused: tmpBuckets.Refused });
						}
						this.query(pContext, pExecution, pRun, tmpBuckets.Statements[0],
							(pBucketError, pBucketRows) =>
							{
								if (pBucketError)
								{
									return fCallback(pBucketError);
								}
								return fFold(
									() =>
									{
										for (let i = 0; i < pBucketRows.length; i++)
										{
											let tmpIndex = toNumber(rawKey(pBucketRows[i].Key));
											if (tmpIndex === null)
											{
												// Outside an Edges geometry: no group (it surfaces as OtherCount).
												continue;
											}
											tmpRaw.Groups.push({ Key: tmpIndex, Count: toCount(pBucketRows[i].Count) });
										}
										return tmpRaw;
									});
							});
					});

			default:
				return this.query(pContext, pExecution, pRun, tmpStatements[0],
					(pError, pRows) =>
					{
						if (pError)
						{
							return fCallback(pError);
						}
						return fFold(() => { return tmpLive.foldRows(pContext, tmpAgg, pRows); });
					});
		}
	}

	/**
	 * K9 rows → RawFacetResult (EngineLive.runMulti's fold).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Array<Record<string, any>>} pTermsRows
	 * @param {Array<Record<string, any>>} pTotalRows
	 * @param {Array<Record<string, any>>} pCoveredRows
	 * @return {Record<string, any>}
	 */
	foldMulti(pAgg, pTermsRows, pTotalRows, pCoveredRows)
	{
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		let tmpRaw = tmpLive.newRaw(pAgg);
		let tmpDimension = pAgg.Dimensions[0];
		tmpRaw.Total = toCount(pTotalRows[0] ? pTotalRows[0].Total : 0);
		tmpRaw.MissingCount = Math.max(0, tmpRaw.Total - toCount(pCoveredRows[0] ? pCoveredRows[0].Covered : 0));
		tmpRaw.DistinctKeys = (pTermsRows.length > 0) ? toCount(pTermsRows[0].FacetDistinct) : 0;
		for (let i = 0; i < pTermsRows.length; i++)
		{
			let tmpKey = rawKey(pTermsRows[i].Key);
			if (tmpKey === null)
			{
				continue;
			}
			tmpRaw.Groups.push({ Key: libRetoldFacetingEngineBase.dimensionKey({ Kind: 'Column', DataType: tmpDimension.DataType }, tmpKey), Count: toCount(pTermsRows[i].Count) });
		}
		return tmpRaw;
	}

	// ================================================================== cube

	/**
	 * Resolve a CubePlan's Common conjuncts and flags exactly as RetoldFacetingCubeExecutor.execute does.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pCubePlan
	 * @return {{ FallBack?: string, CommonColumn?: Array<Record<string, any>>, CommonPathPred?: Record<string, any>|null, Flags?: Array<Record<string, any>> }}
	 */
	resolveCube(pContext, pCubePlan)
	{
		let tmpCubeExecutor = this.fable.RetoldFacetingCubeExecutor;
		let tmpConjuncts = tmpCubeExecutor.conjunctsById(pContext);
		let tmpCommonColumn = [];
		let tmpCommonPath = [];
		let tmpCommon = Array.isArray(pCubePlan.Common) ? pCubePlan.Common : [];
		for (let i = 0; i < tmpCommon.length; i++)
		{
			let tmpConjunct = tmpConjuncts.get(tmpCommon[i]);
			if (!tmpConjunct)
			{
				return { FallBack: `UnknownConjunct:${tmpCommon[i]}` };
			}
			if (tmpConjunct.NamesDeleted === true)
			{
				return { FallBack: 'IncludesDeleted' };
			}
			if (tmpConjunct.Shape === 'Path')
			{
				tmpCommonPath.push(tmpConjunct);
			}
			else
			{
				tmpCommonColumn.push(tmpConjunct);
			}
		}
		let tmpCommonPathPred = pCubePlan.CommonPathPred || null;
		if (!tmpCommonPathPred && (tmpCommonPath.length > 0))
		{
			let tmpLowered = tmpCommonPath.map((pConjunct) => { return tmpCubeExecutor.pathPredFor(pContext, pCubePlan, pConjunct); });
			if (tmpLowered.some((pPred) => { return !pPred; }))
			{
				return { FallBack: 'CommonPathNotLowered' };
			}
			tmpCommonPathPred = (tmpLowered.length === 1) ? tmpLowered[0] : { Node: 'And', Items: tmpLowered };
		}
		let tmpFlags = [];
		let tmpFlagEntries = Array.isArray(pCubePlan.Flags) ? pCubePlan.Flags : [];
		for (let i = 0; i < tmpFlagEntries.length; i++)
		{
			let tmpConjunct = tmpConjuncts.get(tmpFlagEntries[i].ConjunctId);
			if (!tmpConjunct)
			{
				return { FallBack: `UnknownConjunct:${tmpFlagEntries[i].ConjunctId}` };
			}
			if (tmpConjunct.NamesDeleted === true)
			{
				return { FallBack: 'IncludesDeleted' };
			}
			if (tmpConjunct.Shape === 'Path')
			{
				let tmpPred = tmpFlagEntries[i].Pred || tmpCubeExecutor.pathPredFor(pContext, pCubePlan, tmpConjunct);
				if (!tmpPred)
				{
					return { FallBack: 'FlagNotLowered' };
				}
				tmpFlags.push({ Column: tmpFlagEntries[i].Flag, Pred: tmpPred });
			}
			else
			{
				tmpFlags.push({ Column: tmpFlagEntries[i].Flag, ColumnPred: tmpConjunct.Pred });
			}
		}
		let tmpWhereFlags = Array.isArray(pCubePlan.WhereFlags) ? pCubePlan.WhereFlags : [];
		for (let i = 0; i < tmpWhereFlags.length; i++)
		{
			tmpFlags.push({ Column: tmpWhereFlags[i].Flag, Pred: tmpWhereFlags[i].Where });
		}
		return { CommonColumn: tmpCommonColumn, CommonPathPred: tmpCommonPathPred, Flags: tmpFlags };
	}

	/**
	 * Run one CubePlan on the store (§63.6): the Common relation captured as Live captures it, one
	 * grain statement, CubeExecutor.marginalize.  Falls back (FellBack: true) exactly when Live does.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pRun
	 * @param {Record<string, any>} pCubePlan
	 * @param {Array<Record<string, any>>} pMemberAggs
	 * @param {(pError?: Error, pResult?: { Results: Record<string, any>, Errors?: Record<string, any>, FellBack: boolean }) => void} fCallback
	 */
	executeCube(pContext, pExecution, pRun, pCubePlan, pMemberAggs, fCallback)
	{
		let tmpCubeExecutor = this.fable.RetoldFacetingCubeExecutor;
		let fFallBack = (pReason) =>
		{
			this.fable.log.info(`RetoldFaceting ClickHouse cube ${pCubePlan.CubeId} fell back to per-Variant statements: ${pReason}`);
			return fCallback(null, { Results: {}, FellBack: true, Reason: pReason });
		};
		if (pMemberAggs.some((pAgg) => { return !tmpCubeExecutor.eligible(pAgg); }))
		{
			return fFallBack('Ineligible');
		}
		let tmpResolved = this.resolveCube(pContext, pCubePlan);
		if (tmpResolved.FallBack)
		{
			return fFallBack(tmpResolved.FallBack);
		}
		let tmpBounds = tmpCubeExecutor.boundsSpec(pCubePlan, pMemberAggs);
		let tmpCubeInput = Object.assign({}, pCubePlan, { Resolved: { CommonPathPred: tmpResolved.CommonPathPred, Flags: tmpResolved.Flags, Bounds: tmpBounds } });
		let tmpCollected = libFoldCompiler.collectCubeRelations(tmpCubeInput);
		if (tmpCollected.Refused)
		{
			return fFallBack(tmpCollected.Refused);
		}
		let fRelationError = (pError) =>
		{
			if (libFacetErrors.isFacetError(pError) && (pError.Code === 'FACET_UNAUTHENTICATED'))
			{
				return fCallback(pError);
			}
			return fFallBack(`Relation:${libFacetErrors.isFacetError(pError) ? pError.Code : 'Error'}`);
		};
		let tmpCaptured = {};
		let tmpPivotColumns = [];
		let tmpRels = [];
		tmpCollected.Relations.forEach(
			(pRelation) =>
			{
				if (pRelation.Alias === 'p')
				{
					tmpPivotColumns = pRelation.Columns;
					return;
				}
				tmpRels.push({ Alias: pRelation.Alias, Rel: Object.assign({ Scope: 'Inherit' }, pRelation.Rel, { Project: this.projection(pContext, pRelation.Entity, pRelation.Columns) }) });
			});
		let tmpVariant = { VariantId: pCubePlan.CubeId, Conjuncts: tmpResolved.CommonColumn, PathPred: tmpResolved.CommonPathPred, IncludesDeleted: false };
		let tmpPivotRel = this.fable.RetoldFacetingEngineLive.pivotRel(pContext, pCubePlan.Pivot, tmpVariant, tmpPivotColumns);
		this.captureAll(pContext, pExecution, [ { Alias: 'p', Rel: tmpPivotRel } ].concat(tmpRels), tmpCaptured,
			(pCaptureError, pOpaque) =>
			{
				if (pCaptureError)
				{
					return fRelationError(pCaptureError);
				}
				if (pOpaque)
				{
					return fFallBack(pOpaque);
				}
				let tmpPivotCapture = tmpCaptured.p ? tmpCaptured.p.Capture : null;
				if (tmpPivotCapture && Array.isArray(tmpPivotCapture.Transformed) && (tmpPivotCapture.Transformed.length > 0))
				{
					return fFallBack('Transformed');
				}
				let tmpEntities = {};
				Object.keys(tmpCaptured).forEach((pAlias) => { tmpEntities[pAlias] = tmpCaptured[pAlias].Entity; });
				this.probeLeaves(pContext, tmpCollected.Leaves, tmpEntities,
					(pProbeError, pFragments, pTransformed) =>
					{
						if (pProbeError)
						{
							return fRelationError(pProbeError);
						}
						if (pTransformed > 0)
						{
							// A behavior rewrites an operator of a flag / W_def / Common column leaf (Live falls back too).
							return fFallBack('Transformed');
						}
						let tmpInput = this.compileInput(pContext, tmpCaptured, null, pFragments, pCubePlan.Pivot);
						let tmpOptions = pContext.Options || this.options;
						let tmpMaxGroups = (tmpOptions.Limits && (tmpOptions.Limits.CubeMaxGroups >= 1)) ? Math.floor(tmpOptions.Limits.CubeMaxGroups) : 100000;
						if ((typeof(pCubePlan.MaxGroups) === 'number') && (pCubePlan.MaxGroups >= 1))
						{
							tmpMaxGroups = Math.min(tmpMaxGroups, Math.floor(pCubePlan.MaxGroups));
						}
						let tmpCompiled = libFoldCompiler.compileCube(Object.assign({}, tmpCubeInput, { MaxGroups: tmpMaxGroups }), pMemberAggs, tmpInput);
						if (tmpCompiled.Refused)
						{
							return fFallBack(tmpCompiled.Refused);
						}
						if (pRun.DryRun)
						{
							// compile(): keep the grain statement, then compile the members per Variant too.
							pRun.Cubes[pCubePlan.CubeId] = tmpCompiled.Statement;
							return fCallback(null, { Results: {}, FellBack: true, Reason: 'DryRun' });
						}
						pMemberAggs.forEach(
							(pAgg) =>
							{
								let tmpFreshness = this.freshness(this.depSet(pContext, pAgg)) || {};
								pExecution.Freshness[pAgg.Key] = { Exact: tmpFreshness.Exact === true, LagMS: (typeof(tmpFreshness.LagMS) === 'number') ? tmpFreshness.LagMS : Infinity, AsOf: tmpFreshness.AsOf || null, State: tmpFreshness.State || null };
							});
						this.query(pContext, pExecution, pRun, tmpCompiled.Statement,
							(pRunError, pRows) =>
							{
								if (pRunError)
								{
									if (pRunError.StoreError)
									{
										return fCallback(null, { Results: {}, FellBack: false, StoreFailed: pRunError });
									}
									if (pRunError.Code === 'FACET_TIMEOUT')
									{
										return fCallback(null, { Results: {}, Errors: pMemberAggs.reduce((pErrors, pAgg) => { pErrors[pAgg.Key] = libFacetErrors.toEntry(pRunError); return pErrors; }, {}), FellBack: false });
									}
									return fFallBack(`Statement:${pRunError.Code || 'Error'}`);
								}
								if (pRows.length > tmpMaxGroups)
								{
									return fFallBack('CubeMaxGroups');
								}
								let tmpMarginal = tmpCubeExecutor.marginalize(Object.assign({}, pCubePlan, { Bounds: tmpBounds }), pMemberAggs, pRows, tmpOptions);
								return fCallback(null, { Results: tmpMarginal.Results, Errors: tmpMarginal.Errors, FellBack: false });
							});
					});
			});
	}
}

module.exports = RetoldFacetingEngineClickHouse;
module.exports.serviceType = 'RetoldFacetingEngineClickHouse';
module.exports.ENGINE_NAME = ENGINE_NAME;
module.exports.STORE_NAME = STORE_NAME;
