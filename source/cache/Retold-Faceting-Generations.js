/**
 * Retold Faceting - Generations
 *
 * Tick-stamped generation counters per (Entity, TenantKey, Column | '#row' | '#all' | '#cols')
 * (design 05 §6): every ChangeEvent the intake delivers bumps, synchronously, the keys of the tenants
 * (and, for PersonalScopes entities, the owners) it touched; a fold's GenVector is read BEFORE
 * execution over every key it depends on.
 *
 *   GenKey    = Entity '|' TenantKey '|' Column
 *   TenantKey = '*' | '#any' | Part | Part '/' Owner | Part '/*'     Part = enc(tenant) | '#none'
 *
 * Writes bump (internal-contracts §41.2 / §41.3):
 *
 *   Unscoped / Global   '*'                                           (every tenant)
 *   Tenant              enc(t) per tenant of the event ('*' for an unknown one)
 *   Personal            the tenant keys as Tenant ('#none' without a tenant column) plus Part/o per
 *                       (tenant, owner) pair, Part/* for an unknown owner (or for every known tenant
 *                       when the event carries no Owners)
 *   always              '#any'
 *
 * on the columns '#row' (Create / Delete / Undelete, or an Update of a row column: delete, tenant,
 * owner, identity, Required), the changed column itself plus '#cols' (Update / Touch with a column
 * list), or '#all' (an unknown column list, EntityDirty).  A fold reads (§41.4) its own tenant key (or
 * its owner-qualified keys), '*' — '#any' only when it has no captured tenant — on its DepSet columns,
 * '#row' and '#all'.
 *
 * Storage (internal-contracts §41.6, review fixes §51.53): keys live in GROUPS, one per
 * (Entity, TenantKey) — the floor key.  A group holds at most the entity's columns (bounded by the
 * model), so the only unbounded dimension, tenants × owners, is bounded by evicting WHOLE groups:
 *
 *   - the '*' and '#any' groups of every entity are PINNED (created on first use, never evicted:
 *     at most 2 × entities groups), so the keys every fold reads never fall back to a floor;
 *   - other groups are evicted approximately-LRU (each bump / read stamps a use counter; eviction
 *     samples the oldest-inserted groups and drops the least recently used — no Map re-insertion on
 *     the hot path) while the table holds more than Cache.MaxGenerationKeys keys;
 *   - an evicted group's largest tick becomes its floor (no ABA: a missing key never reads lower than
 *     any value it had); when the floor map overflows Cache.MaxGenerationFloors, the oldest floor
 *     folds into its ENTITY's floor (never a global one: churn on one entity can never move another
 *     entity's keys).
 *
 * The vector Hash covers the dependency keys and their MAX tick, not every tick: any bump of a
 * dependency raises the max (ticks only grow), and an eviction changes it only when the evicted
 * group's own last bump is newer than every dependency of the fold — so cache pressure from other
 * tenants almost never moves an idle tenant's vectors.
 *
 * Contract: internal-contracts §41 (key grammar §41.1, kinds §41.2, bumps §41.3, reads §41.4,
 * vector §41.5, floors §41.6, API §41.7).  Owner: builder A (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Pseudo-columns (internal-contracts §41.1).
const ROW = '#row';
const ALL = '#all';
const COLS = '#cols';

// Pseudo tenant keys and parts (internal-contracts §41.1).
const GLOBAL = '*';
const ANY = '#any';
const NO_TENANT = '#none';

// Operations that change row membership (bump '#row'), and those that change columns.
const ROW_OPERATIONS = Object.freeze([ 'Create', 'Delete', 'Undelete' ]);
const COLUMN_OPERATIONS = Object.freeze([ 'Update', 'Touch' ]);

// Bounds when the options carry nothing usable (internal-contracts §38.4): 'Auto' derives the key
// budget from Cache.MaxBytes (about AUTO_BYTES_PER_KEY bytes of table per key), clamped.
const AUTO_MAX_GENERATION_KEYS = 200000;
const AUTO_MIN_GENERATION_KEYS = 4096;
const AUTO_BYTES_PER_KEY = 320;
const DEFAULT_MAX_GENERATION_FLOORS = 50000;

// How many of the oldest-inserted groups one eviction step compares (approximate LRU).
const EVICTION_SAMPLE = 16;

// Approximate heap per stored key / group / floor (stats().ApproxBytes; measured order of magnitude).
const APPROX_KEY_BYTES = 100;
const APPROX_GROUP_BYTES = 240;
const APPROX_FLOOR_BYTES = 90;

/**
 * Encode one tenant / owner value as a key part: normalized like a scope value, URI-encoded, and '*'
 * escaped, so no encoded value can collide with '*', '#any', '#none' or the '/' and '|' separators.
 *
 * @param {any} pValue
 * @return {string}
 */
const encodePart = (pValue) =>
{
	return encodeURIComponent(String(libRetoldFacetingUtil.normalizeScopeValue(pValue))).replace(/\*/g, '%2A');
};

/**
 * The (Entity, TenantKey) part of a GenKey — the floor key.  Entity names never hold '|' (model
 * names) and tenant keys are encoded, so the second '|' ends the floor key whatever the column is.
 *
 * @param {string} pGenKey
 * @return {string|null} null for a malformed key
 */
const floorKeyOf = (pGenKey) =>
{
	if (typeof(pGenKey) !== 'string')
	{
		return null;
	}
	let tmpFirst = pGenKey.indexOf('|');
	let tmpSecond = (tmpFirst >= 0) ? pGenKey.indexOf('|', tmpFirst + 1) : -1;
	return (tmpSecond > tmpFirst) ? pGenKey.slice(0, tmpSecond) : null;
};

/**
 * A positive integer option, else the default.
 *
 * @param {any} pValue
 * @param {number} pDefault
 * @return {number}
 */
const positiveInteger = (pValue, pDefault) =>
{
	return (Number.isSafeInteger(pValue) && (pValue > 0)) ? pValue : pDefault;
};

/**
 * Sorted, unique strings.
 *
 * @param {Iterable<string>} pValues
 * @return {Array<string>}
 */
const sortedUnique = (pValues) =>
{
	return Array.from(new Set(pValues)).sort();
};

class RetoldFacetingGenerations extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingGenerations';

		// 'g:' + 8 hex: part of every GenVector hash, so nothing computed before a restart matches after it.
		this.BootEpoch = `g:${libCrypto.createHash('sha256').update(`${this.fable.getUUID()}|${process.pid}|${Date.now()}`).digest('hex').slice(0, 8)}`;

		this._GlobalTick = 0;
		// 'Entity|TenantKey' → group { Entity, Base, Max, Cols: Map<Column, { Tick, At }>, Used }
		// Evictable groups (insertion order; recency is the Used stamp, never a re-insertion) …
		this._Groups = new Map();
		// … and the pinned '*' / '#any' groups (never evicted).
		this._Pinned = new Map();
		// Keys held by the evictable groups (the Cache.MaxGenerationKeys budget) and by the pinned ones.
		this._KeyCount = 0;
		this._PinnedKeyCount = 0;
		// The use counter (bumps and reads stamp a group with ++_UseClock).
		this._UseClock = 0;
		// 'Entity|TenantKey' → floor tick of an evicted group (insertion order = raise order)
		this._Floors = new Map();
		// Entity → floor folded from overflowing floors (bounded by the number of entities)
		this._EntityFloors = new Map();
		// Raised only by clear() (tests): no vector read before a clear matches one after it.
		this._GlobalFloor = 0;
		// Bump listeners: name → fListener(pBump)
		this._Listeners = new Map();
		this._Stats = { Bumps: 0, Evictions: 0, FloorRaises: 0, GroupEvictions: 0, EntityFloorRaises: 0, ApplyErrors: 0 };
	}

	/**
	 * The last tick handed out.
	 *
	 * @return {number}
	 */
	get GlobalTick()
	{
		return this._GlobalTick;
	}

	/**
	 * A tenant key (internal-contracts §41.1): unknown tenant → '*'; pOwner undefined → the tenant key;
	 * pOwner unknown → '<Part>/*'.  pTenant '#none' is the Part of a Personal entity with no tenant column.
	 *
	 * @param {any} pTenant
	 * @param {any} [pOwner]
	 * @param {Array<any>} [pUnsetValues] - Scope.UnsetValues
	 * @return {string}
	 */
	static tenantKey(pTenant, pOwner, pUnsetValues)
	{
		let tmpPart = null;
		if (pTenant === NO_TENANT)
		{
			tmpPart = NO_TENANT;
		}
		else if ((pTenant !== GLOBAL) && !libRetoldFacetingUtil.isUnsetScopeValue(pTenant, pUnsetValues))
		{
			tmpPart = encodePart(pTenant);
		}
		if (tmpPart === null)
		{
			return GLOBAL;
		}
		if (typeof(pOwner) === 'undefined')
		{
			return tmpPart;
		}
		if ((pOwner === GLOBAL) || libRetoldFacetingUtil.isUnsetScopeValue(pOwner, pUnsetValues))
		{
			return `${tmpPart}/${GLOBAL}`;
		}
		return `${tmpPart}/${encodePart(pOwner)}`;
	}

	/**
	 * @param {any} pTenant
	 * @param {any} [pOwner]
	 * @return {string}
	 */
	tenantKey(pTenant, pOwner)
	{
		return RetoldFacetingGenerations.tenantKey(pTenant, pOwner, this._unsetValues());
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pTenantKey
	 * @param {string} pColumn
	 * @return {string}
	 */
	static genKey(pEntity, pTenantKey, pColumn)
	{
		return `${pEntity}|${pTenantKey}|${pColumn}`;
	}

	/**
	 * Scope.UnsetValues of the options (the values a scope value is unset at).
	 *
	 * @return {Array<any>}
	 */
	_unsetValues()
	{
		return (this.options.Scope && Array.isArray(this.options.Scope.UnsetValues)) ? this.options.Scope.UnsetValues : [];
	}

	/**
	 * Cache.MaxGenerationKeys: a positive integer, or 'Auto' → Cache.MaxBytes / 320 clamped to
	 * [ 4096, 200000 ] (the default 64 MiB gives 200 000), so a host that shrinks the result cache for a
	 * small box shrinks the generation table with it (P11).
	 *
	 * @return {number}
	 */
	_maxKeys()
	{
		let tmpCache = this.options.Cache || {};
		if (Number.isSafeInteger(tmpCache.MaxGenerationKeys) && (tmpCache.MaxGenerationKeys > 0))
		{
			return tmpCache.MaxGenerationKeys;
		}
		let tmpMaxBytes = (Number.isSafeInteger(tmpCache.MaxBytes) && (tmpCache.MaxBytes > 0)) ? tmpCache.MaxBytes : (AUTO_MAX_GENERATION_KEYS * AUTO_BYTES_PER_KEY);
		return Math.max(AUTO_MIN_GENERATION_KEYS, Math.min(AUTO_MAX_GENERATION_KEYS, Math.floor(tmpMaxBytes / AUTO_BYTES_PER_KEY)));
	}

	/**
	 * Cache.MaxGenerationFloors.
	 *
	 * @return {number}
	 */
	_maxFloors()
	{
		let tmpCache = this.options.Cache || {};
		return positiveInteger(tmpCache.MaxGenerationFloors, DEFAULT_MAX_GENERATION_FLOORS);
	}

	/**
	 * Cache.GenerationGranularity: 'Entity' collapses every column bump but '#row' into '#all'.
	 *
	 * @return {string} 'Column' | 'Entity'
	 */
	_granularity()
	{
		let tmpCache = this.options.Cache || {};
		return (tmpCache.GenerationGranularity === 'Entity') ? 'Entity' : 'Column';
	}

	/**
	 * The scope columns of an entity (Host.entityScopeColumns, internal-contracts §41.2); an Unscoped
	 * descriptor when no host is attached.
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	scopeColumns(pEntity)
	{
		let tmpHost = (this.fable.RetoldFacetingService && this.fable.RetoldFacetingService.Host) ? this.fable.RetoldFacetingService.Host : null;
		if (tmpHost && (typeof(tmpHost.entityScopeColumns) === 'function'))
		{
			try
			{
				return tmpHost.entityScopeColumns(pEntity);
			}
			catch (pScopeError)
			{
				// Fail closed: an Unscoped descriptor bumps '*', which every fold of the entity reads.
				this.fable.log.warn(`RetoldFaceting Generations: the scope columns of ${libRetoldFacetingUtil.logSafe(pEntity)} could not be read (treated as Unscoped): ${pScopeError && pScopeError.message ? pScopeError.message : pScopeError}`);
			}
		}
		return { Entity: pEntity, Kind: 'Unscoped', TenantColumn: null, OwnerColumn: null, RequiredColumns: [], DeleteColumn: null, PrimaryKey: null, RowColumns: [] };
	}

	/**
	 * The Part of a tenant value for an entity: '#none' for an entity without a tenant column, '*'
	 * for an unknown / unset tenant (or a '#none' marker on an entity that has a tenant column), else
	 * enc(tenant).
	 *
	 * @param {Record<string, any>} pScope - scopeColumns()
	 * @param {any} pTenant
	 * @return {string}
	 */
	_partFor(pScope, pTenant)
	{
		if (!pScope.TenantColumn)
		{
			return NO_TENANT;
		}
		if (pTenant === NO_TENANT)
		{
			return GLOBAL;
		}
		return this.tenantKey(pTenant);
	}

	/**
	 * The tenant keys a ChangeEvent bumps (internal-contracts §41.2, middle column, plus '#any').
	 *
	 * @param {Record<string, any>} pEvent
	 * @return {Array<string>}
	 */
	tenantKeysForChange(pEvent)
	{
		let tmpEvent = ((typeof(pEvent) === 'object') && (pEvent !== null)) ? pEvent : {};
		return this._tenantKeysFor(tmpEvent, this.scopeColumns(tmpEvent.Entity));
	}

	/**
	 * tenantKeysForChange over already-resolved scope columns.
	 *
	 * @param {Record<string, any>} pEvent
	 * @param {Record<string, any>} pScope - scopeColumns(pEvent.Entity)
	 * @return {Array<string>}
	 */
	_tenantKeysFor(pEvent, pScope)
	{
		let tmpKeys = new Set([ ANY ]);
		// No tenants on the event means "unknown" (every tenant).
		let tmpTenants = (Array.isArray(pEvent.Tenants) && (pEvent.Tenants.length > 0)) ? pEvent.Tenants : [ GLOBAL ];
		if (pScope.Kind === 'Tenant')
		{
			tmpTenants.forEach((pTenant) => { tmpKeys.add(this._partFor(pScope, pTenant)); });
		}
		else if (pScope.Kind === 'Personal')
		{
			// The tenant-wide keys first (TenantOnly folds and every owner of the tenant read them).
			let tmpKnownParts = [];
			if (!pScope.TenantColumn)
			{
				tmpKeys.add(NO_TENANT);
				tmpKnownParts.push(NO_TENANT);
			}
			else
			{
				tmpTenants.forEach(
					(pTenant) =>
					{
						let tmpPart = this._partFor(pScope, pTenant);
						tmpKeys.add(tmpPart);
						if ((tmpPart !== GLOBAL) && (tmpKnownParts.indexOf(tmpPart) < 0))
						{
							tmpKnownParts.push(tmpPart);
						}
					});
			}
			let tmpOwners = Array.isArray(pEvent.Owners) ? pEvent.Owners : null;
			if (!tmpOwners || (tmpOwners.length < 1))
			{
				// Owners unknown: every owner-qualified fold of each known tenant reads Part/*.
				tmpKnownParts.forEach((pPart) => { tmpKeys.add(`${pPart}/${GLOBAL}`); });
			}
			else
			{
				tmpOwners.forEach(
					(pPair) =>
					{
						if ((typeof(pPair) !== 'object') || (pPair === null))
						{
							tmpKnownParts.forEach((pPart) => { tmpKeys.add(`${pPart}/${GLOBAL}`); });
							return;
						}
						let tmpPart = this._partFor(pScope, pPair.Tenant);
						if (tmpPart === GLOBAL)
						{
							// An unknown tenant cannot qualify an owner: '*' (read by every fold) covers it.
							tmpKeys.add(GLOBAL);
							return;
						}
						// The pair's tenant-wide key too (a pair whose tenant is not in Tenants still moves it).
						tmpKeys.add(tmpPart);
						let tmpOwner = (typeof(pPair.Owner) === 'undefined') ? GLOBAL : pPair.Owner;
						tmpKeys.add(RetoldFacetingGenerations.tenantKey(tmpPart === NO_TENANT ? NO_TENANT : pPair.Tenant, tmpOwner, this._unsetValues()));
					});
			}
		}
		else
		{
			// Unscoped and Global entities: one write may affect every tenant.
			tmpKeys.add(GLOBAL);
		}
		return sortedUnique(tmpKeys);
	}

	/**
	 * The column keys a ChangeEvent bumps (internal-contracts §41.3).
	 *
	 * @param {Record<string, any>} pEvent
	 * @return {Array<string>}
	 */
	columnsForChange(pEvent)
	{
		let tmpEvent = ((typeof(pEvent) === 'object') && (pEvent !== null)) ? pEvent : {};
		return this._columnsFor(tmpEvent, null);
	}

	/**
	 * columnsForChange, with the scope columns resolved only when a column list needs them.
	 *
	 * @param {Record<string, any>} pEvent
	 * @param {Record<string, any>|null} pScope - scopeColumns(pEvent.Entity), or null to resolve on demand
	 * @return {Array<string>}
	 */
	_columnsFor(pEvent, pScope)
	{
		let tmpColumns = new Set();
		if (ROW_OPERATIONS.indexOf(pEvent.Operation) >= 0)
		{
			tmpColumns.add(ROW);
		}
		else if ((COLUMN_OPERATIONS.indexOf(pEvent.Operation) >= 0) && Array.isArray(pEvent.ChangedColumns))
		{
			let tmpRowColumns = (pScope || this.scopeColumns(pEvent.Entity)).RowColumns || [];
			pEvent.ChangedColumns.forEach(
				(pColumn) =>
				{
					if ((typeof(pColumn) !== 'string') || (pColumn.length < 1))
					{
						return;
					}
					tmpColumns.add((tmpRowColumns.indexOf(pColumn) >= 0) ? ROW : pColumn);
				});
			tmpColumns.add(COLS);
		}
		else
		{
			// Update / Touch without a column list, EntityDirty, anything else: every column may have moved.
			tmpColumns.add(ALL);
		}
		if (this._granularity() === 'Entity')
		{
			let tmpCollapsed = new Set();
			tmpColumns.forEach((pColumn) => { tmpCollapsed.add((pColumn === ROW) ? ROW : ALL); });
			tmpColumns = tmpCollapsed;
		}
		return sortedUnique(tmpColumns);
	}

	/**
	 * The floor a key of a (Entity, TenantKey) that has no group reads: max(Floor[E|T], EntityFloor[E],
	 * GlobalFloor).
	 *
	 * @param {string} pFloorKey
	 * @param {string} pEntity
	 * @return {number}
	 */
	_floorOf(pFloorKey, pEntity)
	{
		let tmpFloor = this._Floors.has(pFloorKey) ? this._Floors.get(pFloorKey) : 0;
		let tmpEntityFloor = this._EntityFloors.has(pEntity) ? this._EntityFloors.get(pEntity) : 0;
		return Math.max(tmpFloor, tmpEntityFloor, this._GlobalFloor);
	}

	/**
	 * The group of a (Entity, TenantKey), created when pCreate or when it is a pinned ('*' / '#any')
	 * group: a new group starts at the floor its keys read so far (Base), so creating it never moves
	 * any read.
	 *
	 * @param {string} pEntity
	 * @param {string} pTenantKey
	 * @param {boolean} pCreate
	 * @return {Record<string, any>|null}
	 */
	_group(pEntity, pTenantKey, pCreate)
	{
		let tmpFloorKey = `${pEntity}|${pTenantKey}`;
		let tmpPinned = (pTenantKey === GLOBAL) || (pTenantKey === ANY);
		let tmpMap = tmpPinned ? this._Pinned : this._Groups;
		let tmpGroup = tmpMap.get(tmpFloorKey);
		if (tmpGroup || (!pCreate && !tmpPinned))
		{
			return tmpGroup || null;
		}
		let tmpBase = this._floorOf(tmpFloorKey, pEntity);
		tmpGroup = { Entity: pEntity, Base: tmpBase, Max: tmpBase, Cols: new Map(), Used: ++this._UseClock };
		tmpMap.set(tmpFloorKey, tmpGroup);
		// The group carries the floor now (re-recorded if it is evicted again).
		this._Floors.delete(tmpFloorKey);
		return tmpGroup;
	}

	/**
	 * Stamp one tick on every (tenant key × column) of an entity, then evict to the bounds.
	 *
	 * @param {string} pEntity
	 * @param {Array<string>} pTenantKeys
	 * @param {Array<string>} pColumns
	 * @return {{ Tick: number, At: number }}
	 */
	_stamp(pEntity, pTenantKeys, pColumns)
	{
		this._GlobalTick++;
		let tmpValue = Object.freeze({ Tick: this._GlobalTick, At: Date.now() });
		let tmpUsed = ++this._UseClock;
		for (let i = 0; i < pTenantKeys.length; i++)
		{
			let tmpGroup = this._group(pEntity, pTenantKeys[i], true);
			let tmpPinned = (pTenantKeys[i] === GLOBAL) || (pTenantKeys[i] === ANY);
			for (let j = 0; j < pColumns.length; j++)
			{
				if (!tmpGroup.Cols.has(pColumns[j]))
				{
					if (tmpPinned)
					{
						this._PinnedKeyCount++;
					}
					else
					{
						this._KeyCount++;
					}
				}
				tmpGroup.Cols.set(pColumns[j], tmpValue);
			}
			tmpGroup.Max = tmpValue.Tick;
			tmpGroup.Used = tmpUsed;
		}
		this._Stats.Bumps++;
		this._evict();
		return tmpValue;
	}

	/**
	 * Evict least recently used groups (approximately: the least recently used of the
	 * EVICTION_SAMPLE oldest-inserted ones) while the evictable keys exceed Cache.MaxGenerationKeys;
	 * an evicted group's largest tick becomes its floor.  Floors beyond Cache.MaxGenerationFloors fold,
	 * oldest first, into their entity's floor (internal-contracts §41.6).
	 */
	_evict()
	{
		let tmpMaxKeys = this._maxKeys();
		while ((this._KeyCount > tmpMaxKeys) && (this._Groups.size > 0))
		{
			let tmpVictimKey = null;
			let tmpVictim = null;
			let tmpSeen = 0;
			for (let [ tmpKey, tmpGroup ] of this._Groups)
			{
				if (!tmpVictim || (tmpGroup.Used < tmpVictim.Used))
				{
					tmpVictimKey = tmpKey;
					tmpVictim = tmpGroup;
				}
				tmpSeen++;
				if (tmpSeen >= EVICTION_SAMPLE)
				{
					break;
				}
			}
			this._Groups.delete(tmpVictimKey);
			this._KeyCount -= tmpVictim.Cols.size;
			this._Stats.Evictions += tmpVictim.Cols.size;
			this._Stats.GroupEvictions++;
			let tmpFloor = this._Floors.has(tmpVictimKey) ? this._Floors.get(tmpVictimKey) : 0;
			if (tmpVictim.Max > tmpFloor)
			{
				this._Floors.set(tmpVictimKey, tmpVictim.Max);
				this._Stats.FloorRaises++;
			}
		}
		let tmpMaxFloors = this._maxFloors();
		while (this._Floors.size > tmpMaxFloors)
		{
			let tmpOldest = this._Floors.keys().next().value;
			let tmpFloor = this._Floors.get(tmpOldest);
			this._Floors.delete(tmpOldest);
			let tmpEntity = tmpOldest.slice(0, tmpOldest.indexOf('|'));
			if (tmpFloor > (this._EntityFloors.get(tmpEntity) || 0))
			{
				this._EntityFloors.set(tmpEntity, tmpFloor);
				this._Stats.EntityFloorRaises++;
			}
		}
	}

	/**
	 * Call every bump listener, each isolated (an exception is logged and the rest still run).
	 *
	 * @param {Record<string, any>} pBump
	 */
	_notify(pBump)
	{
		this._Listeners.forEach(
			(fListener, pName) =>
			{
				try
				{
					fListener(pBump);
				}
				catch (pListenerError)
				{
					this.fable.log.warn(`RetoldFaceting Generations: bump listener [${libRetoldFacetingUtil.logSafe(pName)}] failed: ${pListenerError && pListenerError.message ? pListenerError.message : pListenerError}`);
				}
			});
	}

	/**
	 * Bump the keys of one ChangeEvent (internal-contracts §41.3), then call every bump listener.
	 * Never throws.
	 *
	 * @param {Record<string, any>} pEvent - a ChangeEvent (internal-contracts §39.2)
	 * @return {Record<string, any>|null} the bump { Entity, Tick, At, Seq, Source, Operation, TenantKeys, Columns, Keys }
	 */
	applyChange(pEvent)
	{
		let tmpBump;
		let tmpEntity = null;
		try
		{
			if ((typeof(pEvent) !== 'object') || (pEvent === null) || (typeof(pEvent.Entity) !== 'string') || (pEvent.Entity.length < 1))
			{
				return null;
			}
			tmpEntity = pEvent.Entity;
			// One scope lookup per event (the bump runs inside every write).
			let tmpScope = this.scopeColumns(pEvent.Entity);
			let tmpTenantKeys = this._tenantKeysFor(pEvent, tmpScope);
			let tmpColumns = this._columnsFor(pEvent, tmpScope);
			let tmpKeys = [];
			for (let i = 0; i < tmpTenantKeys.length; i++)
			{
				for (let j = 0; j < tmpColumns.length; j++)
				{
					tmpKeys.push(RetoldFacetingGenerations.genKey(pEvent.Entity, tmpTenantKeys[i], tmpColumns[j]));
				}
			}
			let tmpStamp = this._stamp(pEvent.Entity, tmpTenantKeys, tmpColumns);
			tmpBump = Object.freeze(
				{
					Entity: pEvent.Entity,
					Tick: tmpStamp.Tick,
					At: tmpStamp.At,
					Seq: (typeof(pEvent.Seq) === 'string') ? pEvent.Seq : null,
					Source: (typeof(pEvent.Source) === 'string') ? pEvent.Source : null,
					Operation: (typeof(pEvent.Operation) === 'string') ? pEvent.Operation : null,
					TenantKeys: Object.freeze(tmpTenantKeys),
					Columns: Object.freeze(tmpColumns),
					Keys: Object.freeze(tmpKeys)
				});
		}
		catch (pBumpError)
		{
			// Fail closed: a change that cannot be applied precisely still moves every fold of its entity.
			if (tmpEntity === null)
			{
				// Not even an entity to bump: nothing this event could have changed is known.
				return null;
			}
			this._Stats.ApplyErrors++;
			this.fable.log.warn(`RetoldFaceting Generations: a change of ${libRetoldFacetingUtil.logSafe(tmpEntity)} could not be applied precisely (the whole entity is bumped): ${pBumpError && pBumpError.message ? pBumpError.message : pBumpError}`);
			return this.bumpEntity(tmpEntity, 'ApplyError');
		}
		this._notify(tmpBump);
		return tmpBump;
	}

	/**
	 * Bump (E, '*', '#all') and (E, '#any', '#all') (model reloads, tests), then call every bump
	 * listener.  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string} [pReason]
	 * @return {Record<string, any>|null}
	 */
	bumpEntity(pEntity, pReason)
	{
		if ((typeof(pEntity) !== 'string') || (pEntity.length < 1))
		{
			return null;
		}
		let tmpKeys = [ RetoldFacetingGenerations.genKey(pEntity, ANY, ALL), RetoldFacetingGenerations.genKey(pEntity, GLOBAL, ALL) ];
		let tmpStamp = this._stamp(pEntity, [ ANY, GLOBAL ], [ ALL ]);
		let tmpBump = Object.freeze(
			{
				Entity: pEntity,
				Tick: tmpStamp.Tick,
				At: tmpStamp.At,
				Seq: null,
				Source: 'Generations',
				Operation: 'EntityDirty',
				Reason: (typeof(pReason) === 'string') ? pReason : null,
				TenantKeys: Object.freeze([ ANY, GLOBAL ]),
				Columns: Object.freeze([ ALL ]),
				Keys: Object.freeze(tmpKeys)
			});
		this._notify(tmpBump);
		return tmpBump;
	}

	/**
	 * The tenant keys a fold over pEntity reads for this principal (internal-contracts §41.2, right column).
	 *
	 * @param {Record<string, any>} pPrincipal
	 * @param {string} pEntity
	 * @param {boolean} [pTenantOnly] - the plan reads pEntity through a TenantOnly Rel somewhere
	 * @return {Array<string>}
	 */
	foldTenantKeys(pPrincipal, pEntity, pTenantOnly)
	{
		let tmpScope = this.scopeColumns(pEntity);
		let tmpScopeValues = (pPrincipal && (typeof(pPrincipal.ScopeValues) === 'object') && (pPrincipal.ScopeValues !== null)) ? pPrincipal.ScopeValues : {};
		let tmpUnset = this._unsetValues();
		if ((tmpScope.Kind !== 'Tenant') && (tmpScope.Kind !== 'Personal'))
		{
			return [ GLOBAL ];
		}
		let tmpPart = NO_TENANT;
		if (tmpScope.TenantColumn)
		{
			let tmpTenant = tmpScopeValues[tmpScope.TenantColumn];
			if (libRetoldFacetingUtil.isUnsetScopeValue(tmpTenant, tmpUnset))
			{
				// No captured tenant: every write of the entity moves '#any'.
				return sortedUnique([ ANY, GLOBAL ]);
			}
			tmpPart = this.tenantKey(tmpTenant);
		}
		if (tmpScope.Kind === 'Tenant')
		{
			return sortedUnique([ tmpPart, GLOBAL ]);
		}
		let tmpOwner = tmpScopeValues[tmpScope.OwnerColumn];
		if ((pTenantOnly === true) || libRetoldFacetingUtil.isUnsetScopeValue(tmpOwner, tmpUnset))
		{
			// Read tenant-wide (a TenantOnly Rel sees every owner's rows of the tenant).
			return sortedUnique([ tmpPart, GLOBAL ]);
		}
		return sortedUnique([ RetoldFacetingGenerations.tenantKey(tmpPart === NO_TENANT ? NO_TENANT : tmpScopeValues[tmpScope.TenantColumn], tmpOwner, tmpUnset), `${tmpPart}/${GLOBAL}`, GLOBAL ]);
	}

	/**
	 * The tenant keys whose bumps this principal may be told about over SSE (internal-contracts §46.4):
	 * Tenant → [ enc(t) ]; Personal → [ Part/o, Part/* ] (never the plain tenant key: a colleague's
	 * private write is not signalled); Global / Unscoped → [ '*' ]; [] when the principal's value is unset.
	 *
	 * @param {Record<string, any>} pPrincipal
	 * @param {string} pEntity
	 * @return {Array<string>}
	 */
	principalTenantKeys(pPrincipal, pEntity)
	{
		let tmpScope = this.scopeColumns(pEntity);
		let tmpScopeValues = (pPrincipal && (typeof(pPrincipal.ScopeValues) === 'object') && (pPrincipal.ScopeValues !== null)) ? pPrincipal.ScopeValues : {};
		let tmpUnset = this._unsetValues();
		if ((tmpScope.Kind !== 'Tenant') && (tmpScope.Kind !== 'Personal'))
		{
			return [ GLOBAL ];
		}
		let tmpTenant = NO_TENANT;
		if (tmpScope.TenantColumn)
		{
			tmpTenant = tmpScopeValues[tmpScope.TenantColumn];
			if (libRetoldFacetingUtil.isUnsetScopeValue(tmpTenant, tmpUnset))
			{
				return [];
			}
		}
		if (tmpScope.Kind === 'Tenant')
		{
			return [ this.tenantKey(tmpTenant) ];
		}
		let tmpOwner = tmpScopeValues[tmpScope.OwnerColumn];
		if (libRetoldFacetingUtil.isUnsetScopeValue(tmpOwner, tmpUnset))
		{
			return [];
		}
		let tmpPart = (tmpTenant === NO_TENANT) ? NO_TENANT : this.tenantKey(tmpTenant);
		return sortedUnique([ RetoldFacetingGenerations.tenantKey(tmpTenant, tmpOwner, tmpUnset), `${tmpPart}/${GLOBAL}` ]);
	}

	/**
	 * The current value of one key: its group's value (the group's use stamp is refreshed), the
	 * group's Base for a column it never saw, else the floor of its (Entity, TenantKey).  A read
	 * creates only a pinned ('*' / '#any') group; nothing else is inserted.
	 *
	 * @param {string} pGenKey
	 * @return {{ Tick: number, At: number|null }}
	 */
	read(pGenKey)
	{
		let tmpFloorKey = floorKeyOf(pGenKey);
		if (tmpFloorKey === null)
		{
			return { Tick: this._GlobalFloor, At: null };
		}
		let tmpEntity = tmpFloorKey.slice(0, tmpFloorKey.indexOf('|'));
		let tmpTenantKey = tmpFloorKey.slice(tmpEntity.length + 1);
		let tmpColumn = pGenKey.slice(tmpFloorKey.length + 1);
		let tmpGroup = this._group(tmpEntity, tmpTenantKey, false);
		if (!tmpGroup)
		{
			return { Tick: this._floorOf(tmpFloorKey, tmpEntity), At: null };
		}
		tmpGroup.Used = ++this._UseClock;
		let tmpValue = tmpGroup.Cols.get(tmpColumn);
		return tmpValue ? { Tick: tmpValue.Tick, At: tmpValue.At } : { Tick: tmpGroup.Base, At: null };
	}

	/**
	 * The GenVector of a set of dependencies (internal-contracts §41.5): every [ GenKey, Tick ] of
	 * each dependency's TenantKeys × Columns, deduplicated and sorted by key; MaxTick; and
	 * Hash = 'g:' + 16 hex of sha256(BootEpoch | the sorted keys | MaxTick).  Ticks only grow, so a
	 * bump of any dependency after the read raises MaxTick (the Hash changes); a key's value only
	 * moves up through floors, which can change MaxTick only by raising it (invalidates more, never
	 * less).
	 *
	 * @param {Array<{ Entity: string, TenantKeys: Array<string>, Columns: Array<string> }>} pDependencies
	 * @return {{ Hash: string, Entries: Array<[string, number]>, MaxTick: number }}
	 */
	vector(pDependencies)
	{
		let tmpKeys = new Set();
		(Array.isArray(pDependencies) ? pDependencies : []).forEach(
			(pDependency) =>
			{
				if (!pDependency || (typeof(pDependency.Entity) !== 'string'))
				{
					return;
				}
				let tmpTenantKeys = Array.isArray(pDependency.TenantKeys) ? pDependency.TenantKeys : [];
				let tmpColumns = Array.isArray(pDependency.Columns) ? pDependency.Columns : [];
				for (let i = 0; i < tmpTenantKeys.length; i++)
				{
					for (let j = 0; j < tmpColumns.length; j++)
					{
						tmpKeys.add(RetoldFacetingGenerations.genKey(pDependency.Entity, tmpTenantKeys[i], tmpColumns[j]));
					}
				}
			});
		let tmpMaxTick = 0;
		let tmpSorted = Array.from(tmpKeys).sort();
		let tmpEntries = tmpSorted.map(
			(pKey) =>
			{
				let tmpTick = this.read(pKey).Tick;
				if (tmpTick > tmpMaxTick)
				{
					tmpMaxTick = tmpTick;
				}
				return [ pKey, tmpTick ];
			});
		let tmpHash = `g:${libCrypto.createHash('sha256').update(`${this.BootEpoch}|${JSON.stringify(tmpSorted)}|${tmpMaxTick}`, 'utf8').digest('hex').slice(0, 16)}`;
		return { Hash: tmpHash, Entries: tmpEntries, MaxTick: tmpMaxTick };
	}

	/**
	 * Register a bump listener (synchronous; exceptions are caught and logged).  A second subscribe
	 * with the same name replaces the first.
	 *
	 * @param {string} pName
	 * @param {(pBump: Record<string, any>) => void} fListener
	 */
	subscribe(pName, fListener)
	{
		if ((typeof(pName) === 'string') && (typeof(fListener) === 'function'))
		{
			this._Listeners.set(pName, fListener);
		}
	}

	/**
	 * @param {string} pName
	 */
	unsubscribe(pName)
	{
		this._Listeners.delete(pName);
	}

	/**
	 * @return {{ Keys: number, Groups: number, PinnedKeys: number, Floors: number, EntityFloors: number, GlobalFloor: number, GlobalTick: number, Bumps: number, Evictions: number, GroupEvictions: number, FloorRaises: number, EntityFloorRaises: number, ApplyErrors: number, MaxKeys: number, ApproxBytes: number }}
	 */
	stats()
	{
		let tmpGroups = this._Groups.size + this._Pinned.size;
		let tmpKeys = this._KeyCount + this._PinnedKeyCount;
		return (
			{
				Keys: tmpKeys,
				Groups: tmpGroups,
				PinnedKeys: this._PinnedKeyCount,
				Floors: this._Floors.size,
				EntityFloors: this._EntityFloors.size,
				GlobalFloor: this._GlobalFloor,
				GlobalTick: this._GlobalTick,
				Bumps: this._Stats.Bumps,
				Evictions: this._Stats.Evictions,
				GroupEvictions: this._Stats.GroupEvictions,
				FloorRaises: this._Stats.FloorRaises,
				EntityFloorRaises: this._Stats.EntityFloorRaises,
				ApplyErrors: this._Stats.ApplyErrors,
				MaxKeys: this._maxKeys(),
				ApproxBytes: (tmpKeys * APPROX_KEY_BYTES) + (tmpGroups * APPROX_GROUP_BYTES) + ((this._Floors.size + this._EntityFloors.size) * APPROX_FLOOR_BYTES)
			});
	}

	/**
	 * Forget every key and floor (tests).  The tick never goes backwards, and GlobalFloor becomes the
	 * current tick, so a vector read before the clear never matches one read after it (no ABA through
	 * a clear either).
	 */
	clear()
	{
		this._Groups.clear();
		this._Pinned.clear();
		this._KeyCount = 0;
		this._PinnedKeyCount = 0;
		this._Floors.clear();
		this._EntityFloors.clear();
		this._GlobalFloor = this._GlobalTick;
	}
}

module.exports = RetoldFacetingGenerations;
module.exports.serviceType = 'RetoldFacetingGenerations';
module.exports.ROW = ROW;
module.exports.ALL = ALL;
module.exports.COLS = COLS;
module.exports.GLOBAL = GLOBAL;
module.exports.ANY = ANY;
module.exports.NO_TENANT = NO_TENANT;
module.exports.encodePart = encodePart;
module.exports.floorKeyOf = floorKeyOf;
