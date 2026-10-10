/**
 * Retold Faceting - Change Intake
 *
 * The one place a change enters the service (design 05 §1.2, §3–§5): every source — the interim
 * intake (the wrapped behavior dispatcher and DAL write methods of each facetable entity's
 * route-bound controller, Change-Intake-Interim.js), notify() / notifyByFilter() from raw writers, and later
 * the upstream MeadowChangeBus — hands a raw change to ingest(), which normalizes it into a
 * ChangeEvent (05 §3.3 shape), assigns the local Seq '<NodeEpoch>:<n>' synchronously, freezes it and
 * delivers it synchronously to every subscriber (Generations first, then ReadYourWrites), each in
 * its own try/catch.  Nothing here ever fails, throws into or delays a write.
 *
 *   NodeEpoch                                   'e:' + 8 hex, minted per process
 *   install() → { Source, Entities }            idempotent; after every catalog (re)build
 *   subscribe(pName, fListener) / unsubscribe(pName)
 *   ingest(pRaw) → ChangeEvent | null
 *   changeFromRows(pEntity, pOperation, pBefore, pAfter, pExtra) → raw change
 *   notify(pEntity, pChange) / notifyByFilter(pEntity, pFilter, pOptions) → Seq | null
 *   covers(pEntity) / uncovered(pEntities) / notifyManaged(pEntity)   is every write of E seen?
 *   ingestBusEvent(pBusEvent) → ChangeEvent | null
 *   currentSeq(), shutdown(), stats()
 *
 * The event never carries row data: only the policy columns' values (KeyImages), ids, tenants,
 * owners and column names.  Tenants come only from row images or a notify caller's explicit list,
 * never from the writer's session (05 §3.3).
 *
 * Contract: internal-contracts §39 (ChangeEvent, Seq, delivery) and §40 (install, wrapping rules,
 * derivation, notify, the Bus seam, API §40.7).  Owner: builder B (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');

const libChangeIntakeInterim = require('./Change-Intake-Interim.js');
const libChangeIntakeBus = require('./Change-Intake-Bus.js');

// ChangeEvent vocabulary (internal-contracts §39.2).
const OPERATIONS = Object.freeze([ 'Create', 'Update', 'Delete', 'Undelete', 'Touch', 'EntityDirty' ]);
const SOURCES = Object.freeze([ 'Interim', 'Notify', 'Bus' ]);

// The per-record write slots the interim intake wraps (internal-contracts §40.2).
const INTERIM_SLOTS = libChangeIntakeInterim.SLOTS;

// ChangeCapture.Intake values (internal-contracts §40.1).
const INTAKE_MODES = Object.freeze([ 'Auto', 'Interim', 'Bus', 'None' ]);

// Operations whose ChangedColumns are meaningful.
const COLUMN_OPERATIONS = Object.freeze([ 'Update', 'Touch' ]);

// Meadow stamps these on every update (05 §3.3: always in an Update's ChangedColumns).
const AUDIT_COLUMNS = Object.freeze([ 'UpdateDate', 'UpdatingIDUser' ]);

// The unknown tenant / owner, and the Part of a Personal entity without a tenant column (§39.2).
const UNKNOWN = '*';
const NO_TENANT = '#none';

const PRINCIPAL_KEY_PATTERN = /^pk:[0-9a-f]{16}$/;
const MAX_ENTITY_NAME = 256;
const MAX_VERB = 64;

const isPlainObject = libFacetUtil.isPlainObject;
const hasOwn = libFacetUtil.hasOwn;
const logSafe = libFacetUtil.logSafe;
const canonicalJSON = libFacetClauses.canonicalJSON;
const normalizeScopeValue = libRetoldFacetingUtil.normalizeScopeValue;

/**
 * Freeze a value and everything it holds (the event is shared by every subscriber).
 *
 * @param {any} pValue
 * @return {any}
 */
const deepFreeze = (pValue) =>
{
	if ((typeof(pValue) === 'object') && (pValue !== null) && !Object.isFrozen(pValue))
	{
		Object.freeze(pValue);
		Object.keys(pValue).forEach((pKey) => { deepFreeze(pValue[pKey]); });
	}
	return pValue;
};

/**
 * A row-shaped value (a non-array object), else null.
 *
 * @param {any} pValue
 * @return {Record<string, any>|null}
 */
const rowOf = (pValue) =>
{
	return ((typeof(pValue) === 'object') && (pValue !== null) && !Array.isArray(pValue)) ? pValue : null;
};

/**
 * Rows of a Before / After argument: one row, an array of rows, or nothing.
 *
 * @param {any} pValue
 * @return {Array<Record<string, any>>}
 */
const rowsOf = (pValue) =>
{
	if (Array.isArray(pValue))
	{
		return pValue.filter((pRow) => { return rowOf(pRow) !== null; });
	}
	return rowOf(pValue) ? [ pValue ] : [];
};

/**
 * A record id, normalized like a scope value ('12' → 12); null for nothing usable.
 *
 * @param {any} pValue
 * @return {string|number|null}
 */
const idValue = (pValue) =>
{
	let tmpValue = normalizeScopeValue(pValue);
	return ((tmpValue === null) || (tmpValue === '')) ? null : tmpValue;
};

/**
 * A dedupe key that keeps 7 and '7' apart only when normalization did (it never does for numbers).
 *
 * @param {any} pValue
 * @return {string}
 */
const identityOf = (pValue) =>
{
	return `${typeof(pValue)}:${String(pValue)}`;
};

/**
 * Do two column values compare equal (internal-contracts §40.3)?  Dates by instant, Buffers by their
 * bytes (Buffer.equals, no base64 copy), anything else as canonical JSON.
 *
 * @param {any} pA
 * @param {any} pB
 * @return {boolean}
 */
const sameValue = (pA, pB) =>
{
	if (pA === pB)
	{
		return true;
	}
	let tmpADate = (pA instanceof Date) && !Number.isNaN(pA.getTime());
	let tmpBDate = (pB instanceof Date) && !Number.isNaN(pB.getTime());
	if (tmpADate || tmpBDate)
	{
		return tmpADate && tmpBDate && (pA.getTime() === pB.getTime());
	}
	if (Buffer.isBuffer(pA) || Buffer.isBuffer(pB))
	{
		return Buffer.isBuffer(pA) && Buffer.isBuffer(pB) && pA.equals(pB);
	}
	return canonicalJSON(pA) === canonicalJSON(pB);
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

// Event size caps (internal-contracts §39.2, P1): beyond them IDs / KeyImages become unknown ([] / {})
// and Owners unknown (null → Part/* per known tenant), which only invalidates more.
const DEFAULT_MAX_EVENT_IDS = 10000;
const DEFAULT_MAX_EVENT_OWNERS = 1000;

// How often the "notify fell back to every tenant" warning may repeat per entity.
const UNKNOWN_TENANT_WARN_MS = 60000;

class RetoldFacetingChangeIntake extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingChangeIntake';

		// 'e:' + 8 hex (internal-contracts §39.1)
		this.NodeEpoch = `e:${libCrypto.createHash('sha256').update(`${this.fable.getUUID()}|${process.pid}|${Date.now()}`).digest('hex').slice(0, 8)}`;
		this._SeqCounter = 0;
		this._ChangeCounter = 0;

		// name → fListener(pChangeEvent), called in subscription order
		this._Subscribers = new Map();

		// The adapters (plain classes, internal-contracts §38.3)
		this.Interim = new libChangeIntakeInterim(this);
		this.Bus = new libChangeIntakeBus(this);

		this._Source = 'None';
		this._Entities = [];
		// Notify settle timers (internal-contracts §40.5), and the settle being coalesced per
		// 'Entity|Operation' within one NotifySettleMS window (P8)
		this._SettleTimers = new Set();
		this._SettlePending = new Map();
		this._ShutDown = false;
		// Model table object → Set of its column names (re-derived after a model reload: new table objects)
		this._ModelColumns = new WeakMap();
		// Entity → Date.now() of the last "notify fell back to every tenant" warning (S8)
		this._UnknownTenantWarned = new Map();
		this._Stats =
			{
				Events: 0, BySource: {}, ByOperation: {}, SubscriberErrors: 0, WrapperErrors: 0, Invalid: 0,
				// M4 review fixes (internal-contracts §51.46–§51.52)
				UnconfirmedWrites: 0, FailClosed: 0, Rewraps: 0, UnknownTenant: 0, Capped: 0
			};
	}

	// ---------------------------------------------------------------- host access

	/**
	 * The host the faceting service is attached to (null before attach).
	 *
	 * @return {any|null}
	 */
	_host()
	{
		let tmpService = this.fable.RetoldFacetingService;
		return (tmpService && tmpService.Host) ? tmpService.Host : null;
	}

	/**
	 * Host.entityScopeColumns (internal-contracts §41.2), or an Unscoped descriptor without a host.
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	scopeColumns(pEntity)
	{
		let tmpHost = this._host();
		if (tmpHost && (typeof(tmpHost.entityScopeColumns) === 'function'))
		{
			try
			{
				return tmpHost.entityScopeColumns(pEntity);
			}
			catch (pScopeError)
			{
				this.fable.log.warn(`RetoldFaceting change intake: the scope columns of ${logSafe(pEntity)} could not be read: ${logSafe(pScopeError.message)}`);
			}
		}
		let tmpPrimaryKey = null;
		if (tmpHost && (typeof(tmpHost.getPrimaryKey) === 'function'))
		{
			try
			{
				tmpPrimaryKey = tmpHost.getPrimaryKey(pEntity) || null;
			}
			catch (pKeyError)
			{
				tmpPrimaryKey = null;
			}
		}
		return { Entity: pEntity, Kind: 'Unscoped', TenantColumn: null, OwnerColumn: null, RequiredColumns: [], DeleteColumn: null, PrimaryKey: tmpPrimaryKey, RowColumns: [] };
	}

	/**
	 * "Is this a model column of the entity?" (decorations are ignored, internal-contracts §40.3), or
	 * null when the model is unknown (then every column counts).
	 *
	 * @param {string} pEntity
	 * @return {((pColumn: string) => boolean)|null}
	 */
	_modelColumnTest(pEntity)
	{
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.getEntityModel) !== 'function'))
		{
			return null;
		}
		let tmpTable = null;
		try
		{
			tmpTable = tmpHost.getEntityModel(pEntity);
		}
		catch (pModelError)
		{
			tmpTable = null;
		}
		if (!tmpTable || (typeof(tmpTable) !== 'object'))
		{
			return null;
		}
		let tmpColumns = this._ModelColumns.get(tmpTable);
		if (!tmpColumns)
		{
			tmpColumns = new Set();
			if (Array.isArray(tmpTable.Columns))
			{
				tmpTable.Columns.forEach((pEntry) => { if (pEntry && (typeof(pEntry.Column) === 'string')) { tmpColumns.add(pEntry.Column); } });
			}
			let tmpSchema = (isPlainObject(tmpTable.MeadowSchema) && Array.isArray(tmpTable.MeadowSchema.Schema)) ? tmpTable.MeadowSchema.Schema : [];
			tmpSchema.forEach((pEntry) => { if (pEntry && (typeof(pEntry.Column) === 'string')) { tmpColumns.add(pEntry.Column); } });
			this._ModelColumns.set(tmpTable, tmpColumns);
		}
		return (pColumn) => { return tmpColumns.has(pColumn); };
	}

	// ---------------------------------------------------------------- install and subscriptions

	/**
	 * Select and install the source (internal-contracts §40.1).  Idempotent: the wiring calls it after
	 * every catalog (re)build; the interim intake then wraps only controllers it has not wrapped.
	 *
	 * @return {{ Source: string, Entities: Array<string> }}
	 */
	install()
	{
		let tmpCapture = isPlainObject(this.options.ChangeCapture) ? this.options.ChangeCapture : {};
		let tmpMode = (typeof(tmpCapture.Intake) === 'string') ? tmpCapture.Intake : 'Auto';
		if (INTAKE_MODES.indexOf(tmpMode) < 0)
		{
			this.fable.log.warn(`RetoldFaceting change intake: unknown ChangeCapture.Intake ${logSafe(tmpMode)}; using 'Auto'.`);
			tmpMode = 'Auto';
		}
		let tmpSource = tmpMode;
		if (tmpMode === 'Auto')
		{
			tmpSource = this.Bus.available() ? 'Bus' : 'Interim';
		}
		else if ((tmpMode === 'Bus') && !this.Bus.available())
		{
			this.fable.log.warn('RetoldFaceting change intake: ChangeCapture.Intake is \'Bus\' but fable has no MeadowChangeBus; no change source is installed (only notify() moves generations).');
			tmpSource = 'None';
		}

		let tmpEntities = [];
		if (tmpSource === 'Bus')
		{
			if (this.Bus.install())
			{
				let tmpCatalog = this.fable.RetoldFacetingCatalog;
				tmpEntities = (tmpCatalog && (typeof(tmpCatalog.entities) === 'function')) ? tmpCatalog.entities().slice() : [];
			}
			else
			{
				this.fable.log.warn('RetoldFaceting change intake: subscribing to the MeadowChangeBus failed; no change source is installed.');
				tmpSource = 'None';
			}
		}
		// The source is set before wrapping so a write racing the install is seen.
		this._Source = tmpSource;
		if (tmpSource === 'Interim')
		{
			tmpEntities = this.Interim.install();
			// Facetable entities the interim intake cannot see (no route-bound controller) and nobody
			// declared notify-managed: their answers are never cached (Bypass 'NoChangeSource', §42.3).
			let tmpCatalog = this.fable.RetoldFacetingCatalog;
			let tmpAll = (tmpCatalog && (typeof(tmpCatalog.entities) === 'function')) ? tmpCatalog.entities() : [];
			let tmpUnseen = tmpAll.filter((pEntity) => { return (tmpEntities.indexOf(pEntity) < 0) && !this.notifyManaged(pEntity); });
			if (tmpUnseen.length > 0)
			{
				this.fable.log.warn(`RetoldFaceting change intake: no route-bound controller to capture writes of [${tmpUnseen.slice(0, 20).map(logSafe).join(', ')}]${(tmpUnseen.length > 20) ? ' …' : ''}; their answers are never cached unless ChangeCapture.NotifyManaged lists them (and every write of them calls notify()).`);
			}
		}
		this._Entities = tmpEntities;
		return { Source: this._Source, Entities: this._Entities.slice() };
	}

	/**
	 * Is an entity declared notify-managed (ChangeCapture.NotifyManaged: true, or a list naming it):
	 * the host promises every write of it reaches notify() / notifyByFilter()?
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	notifyManaged(pEntity)
	{
		let tmpCapture = isPlainObject(this.options.ChangeCapture) ? this.options.ChangeCapture : {};
		if (tmpCapture.NotifyManaged === true)
		{
			return true;
		}
		return Array.isArray(tmpCapture.NotifyManaged) && (tmpCapture.NotifyManaged.indexOf(pEntity) >= 0);
	}

	/**
	 * Does a change source cover every write of this entity right now (internal-contracts §40.1)?
	 *
	 *   'Bus'      the upstream DAL hook sees every write: yes
	 *   'None'     the operator chose notify-only (warned at install): yes
	 *   'Interim'  declared notify-managed, or its route-bound controller's write path still carries
	 *              this intake's wrappers — a dispatcher replaced since the install is wrapped again
	 *              (and the entity invalidated) before this answers
	 *
	 * A cheap property test; the Cache stage asks it for every DepSet entity of a cacheable request.
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	covers(pEntity)
	{
		if ((this._Source === 'Bus') || (this._Source === 'None'))
		{
			return true;
		}
		if (this.notifyManaged(pEntity))
		{
			return true;
		}
		if (this._Source !== 'Interim')
		{
			return false;
		}
		return this.Interim.ensureCovered(pEntity);
	}

	/**
	 * The entities of a list no change source covers (covers() false).
	 *
	 * @param {Array<string>} pEntities
	 * @return {Array<string>}
	 */
	uncovered(pEntities)
	{
		return (Array.isArray(pEntities) ? pEntities : []).filter((pEntity) => { return !this.covers(pEntity); });
	}

	/**
	 * @param {string} pName
	 * @param {(pChangeEvent: Record<string, any>) => void} fListener
	 */
	subscribe(pName, fListener)
	{
		if ((typeof(pName) === 'string') && (typeof(fListener) === 'function'))
		{
			// A second subscribe with the same name replaces the first (and keeps its place).
			this._Subscribers.set(pName, fListener);
		}
	}

	/**
	 * @param {string} pName
	 */
	unsubscribe(pName)
	{
		this._Subscribers.delete(pName);
	}

	// ---------------------------------------------------------------- the Seq clock

	/**
	 * Assign the next Seq (internal-contracts §39.1).
	 *
	 * @return {string}
	 */
	nextSeq()
	{
		this._SeqCounter++;
		return libRetoldFacetingUtil.formatSeq(this.NodeEpoch, this._SeqCounter);
	}

	/**
	 * The last assigned Seq ('<NodeEpoch>:0' before the first change).
	 *
	 * @return {string}
	 */
	currentSeq()
	{
		return libRetoldFacetingUtil.formatSeq(this.NodeEpoch, this._SeqCounter);
	}

	// ---------------------------------------------------------------- ingest and delivery

	/**
	 * Count and log an invalid raw change (entity and reason only).
	 *
	 * @param {string} pWhere
	 * @param {any} pEntity
	 * @param {string} pReason
	 * @return {null}
	 */
	_invalid(pWhere, pEntity, pReason)
	{
		this._Stats.Invalid++;
		this.fable.log.warn(`RetoldFaceting change intake: ${pWhere} refused a change of ${logSafe((typeof(pEntity) === 'string') ? pEntity : '?')}: ${pReason}`);
		return null;
	}

	/**
	 * A tenant value of the event: '*' for unknown or unset (Scope.UnsetValues).
	 *
	 * @param {any} pValue
	 * @return {string|number}
	 */
	_tenantValue(pValue)
	{
		if ((pValue === UNKNOWN) || (pValue === NO_TENANT))
		{
			return UNKNOWN;
		}
		if (libRetoldFacetingUtil.isUnsetScopeValue(pValue, this.options.Scope.UnsetValues))
		{
			return UNKNOWN;
		}
		let tmpValue = normalizeScopeValue(pValue);
		return (tmpValue === null) ? UNKNOWN : tmpValue;
	}

	/**
	 * An owner value of the event: '*' for unknown or unset.
	 *
	 * @param {any} pValue
	 * @return {string|number}
	 */
	_ownerValue(pValue)
	{
		return this._tenantValue(pValue);
	}

	/**
	 * Normalize one raw change into an (unfrozen, Seq-less) event, or { Invalid: reason }.
	 *
	 * @param {Record<string, any>} pRaw
	 * @return {Record<string, any>}
	 */
	_normalize(pRaw)
	{
		if (!isPlainObject(pRaw))
		{
			return { Invalid: 'not an object' };
		}
		let tmpEntity = pRaw.Entity;
		if ((typeof(tmpEntity) !== 'string') || (tmpEntity.length < 1) || (tmpEntity.length > MAX_ENTITY_NAME))
		{
			return { Invalid: 'Entity' };
		}
		let tmpOperation = pRaw.Operation;
		if (OPERATIONS.indexOf(tmpOperation) < 0)
		{
			return { Invalid: 'Operation' };
		}
		let tmpSource = (typeof(pRaw.Source) === 'undefined') ? 'Notify' : pRaw.Source;
		if (SOURCES.indexOf(tmpSource) < 0)
		{
			return { Invalid: 'Source' };
		}
		let tmpScope = this.scopeColumns(tmpEntity);

		// IDs: normalized, deduplicated, in order.
		let tmpIDs = [];
		if ((pRaw.IDs !== null) && (typeof(pRaw.IDs) !== 'undefined'))
		{
			if (!Array.isArray(pRaw.IDs))
			{
				return { Invalid: 'IDs' };
			}
			let tmpSeen = new Set();
			pRaw.IDs.forEach(
				(pID) =>
				{
					let tmpID = idValue(pID);
					if ((tmpID !== null) && !tmpSeen.has(identityOf(tmpID)))
					{
						tmpSeen.add(identityOf(tmpID));
						tmpIDs.push(tmpID);
					}
				});
		}

		// Tenants: '*' for unknown / unset / an entity without a tenant column; never empty.
		let tmpTenants = [];
		if ((pRaw.Tenants !== null) && (typeof(pRaw.Tenants) !== 'undefined'))
		{
			if (!Array.isArray(pRaw.Tenants))
			{
				return { Invalid: 'Tenants' };
			}
			let tmpSeen = new Set();
			pRaw.Tenants.forEach(
				(pTenant) =>
				{
					let tmpTenant = this._tenantValue(pTenant);
					if (!tmpSeen.has(identityOf(tmpTenant)))
					{
						tmpSeen.add(identityOf(tmpTenant));
						tmpTenants.push(tmpTenant);
					}
				});
		}
		if ((tmpTenants.length < 1) || !tmpScope.TenantColumn)
		{
			tmpTenants = [ UNKNOWN ];
		}

		// Owners: Personal entities only; null = unknown owners.
		let tmpOwners = null;
		if ((pRaw.Owners !== null) && (typeof(pRaw.Owners) !== 'undefined'))
		{
			if (!Array.isArray(pRaw.Owners))
			{
				return { Invalid: 'Owners' };
			}
			let tmpPairs = [];
			let tmpSeen = new Set();
			for (let i = 0; i < pRaw.Owners.length; i++)
			{
				let tmpPair = pRaw.Owners[i];
				if (!isPlainObject(tmpPair))
				{
					return { Invalid: 'Owners' };
				}
				let tmpTenant = tmpScope.TenantColumn ? this._tenantValue(tmpPair.Tenant)
					: (tmpScope.OwnerColumn ? NO_TENANT : this._tenantValue(tmpPair.Tenant));
				let tmpOwner = this._ownerValue(tmpPair.Owner);
				let tmpKey = `${identityOf(tmpTenant)}|${identityOf(tmpOwner)}`;
				if (!tmpSeen.has(tmpKey))
				{
					tmpSeen.add(tmpKey);
					tmpPairs.push({ Tenant: tmpTenant, Owner: tmpOwner });
				}
			}
			tmpOwners = tmpPairs;
		}
		// A known non-Personal entity carries no owners; without a host (Unscoped) neither.
		if (!tmpScope.OwnerColumn)
		{
			tmpOwners = null;
		}

		// ChangedColumns: Update / Touch only; null = unknown ('#all').
		let tmpChangedColumns = null;
		if ((COLUMN_OPERATIONS.indexOf(tmpOperation) >= 0) && (pRaw.ChangedColumns !== null) && (typeof(pRaw.ChangedColumns) !== 'undefined'))
		{
			if (!Array.isArray(pRaw.ChangedColumns) || pRaw.ChangedColumns.some((pColumn) => { return (typeof(pColumn) !== 'string') || (pColumn.length < 1); }))
			{
				return { Invalid: 'ChangedColumns' };
			}
			tmpChangedColumns = Array.from(new Set(pRaw.ChangedColumns)).sort();
		}

		// KeyImages: { '<id>': { B?: { col: value }, A?: { … } } }, primitive values only.
		let tmpKeyImages = {};
		if (isPlainObject(pRaw.KeyImages))
		{
			Object.keys(pRaw.KeyImages).forEach(
				(pID) =>
				{
					let tmpImage = pRaw.KeyImages[pID];
					if (!isPlainObject(tmpImage))
					{
						return;
					}
					let tmpClean = {};
					[ 'B', 'A' ].forEach(
						(pSide) =>
						{
							if (isPlainObject(tmpImage[pSide]))
							{
								tmpClean[pSide] = {};
								Object.keys(tmpImage[pSide]).forEach((pColumn) => { tmpClean[pSide][pColumn] = normalizeScopeValue(tmpImage[pSide][pColumn]); });
							}
						});
					if (tmpClean.B || tmpClean.A)
					{
						tmpKeyImages[String(pID)] = tmpClean;
					}
				});
		}

		// Filter: EntityDirty only, the PRE-write predicate, carried (a private copy), never executed.
		let tmpFilter = null;
		if (tmpOperation === 'EntityDirty')
		{
			if ((typeof(pRaw.Filter) === 'string') && (pRaw.Filter.length > 0))
			{
				tmpFilter = pRaw.Filter;
			}
			else if (Array.isArray(pRaw.Filter))
			{
				try
				{
					tmpFilter = JSON.parse(JSON.stringify(pRaw.Filter));
				}
				catch (pCopyError)
				{
					return { Invalid: 'Filter' };
				}
			}
		}

		// Size caps (P1): an event naming more ids / owners than the caps says "unknown" instead (only
		// ever invalidates more; a 20k-owner notify must not become a 20k-key bump).
		let tmpCapture = isPlainObject(this.options.ChangeCapture) ? this.options.ChangeCapture : {};
		if (tmpIDs.length > positiveInteger(tmpCapture.MaxEventIDs, DEFAULT_MAX_EVENT_IDS))
		{
			tmpIDs = [];
			tmpKeyImages = {};
			this._Stats.Capped++;
		}
		if (Array.isArray(tmpOwners) && (tmpOwners.length > positiveInteger(tmpCapture.MaxEventOwners, DEFAULT_MAX_EVENT_OWNERS)))
		{
			tmpOwners = null;
			this._Stats.Capped++;
		}

		// Actor
		let tmpActorIn = isPlainObject(pRaw.Actor) ? pRaw.Actor : {};
		let tmpUserID = normalizeScopeValue(tmpActorIn.UserID);
		let tmpActor = (
			{
				PrincipalKey: ((typeof(tmpActorIn.PrincipalKey) === 'string') && PRINCIPAL_KEY_PATTERN.test(tmpActorIn.PrincipalKey)) ? tmpActorIn.PrincipalKey : null,
				UserID: (tmpUserID === null) ? 0 : tmpUserID,
				Verb: ((typeof(tmpActorIn.Verb) === 'string') && (tmpActorIn.Verb.length > 0)) ? tmpActorIn.Verb.slice(0, MAX_VERB) : ((tmpSource === 'Notify') ? 'Notify' : 'Unknown')
			});

		return (
			{
				ChangeID: null,
				Source: tmpSource,
				Entity: tmpEntity,
				Operation: tmpOperation,
				IDs: tmpIDs,
				Tenants: tmpTenants,
				Owners: tmpOwners,
				ChangedColumns: tmpChangedColumns,
				KeyImages: tmpKeyImages,
				Filter: tmpFilter,
				Actor: tmpActor,
				Timestamp: (Number.isFinite(pRaw.Timestamp) && (tmpSource === 'Bus')) ? pRaw.Timestamp : Date.now(),
				Epoch: null,
				Seq: null
			});
	}

	/**
	 * Stamp ChangeID + Seq, freeze, count and deliver one event.
	 *
	 * @param {Record<string, any>} pEvent - unfrozen
	 * @param {string|null} [pKeepSeq] - a Bus Seq to keep (matches SEQ_PATTERN)
	 * @param {string|null} [pChangeID] - a fixed ChangeID (settle re-delivery)
	 * @return {Readonly<Record<string, any>>}
	 */
	_emit(pEvent, pKeepSeq, pChangeID)
	{
		this._ChangeCounter++;
		pEvent.ChangeID = (typeof(pChangeID) === 'string') ? pChangeID : `ch:${String(this._ChangeCounter).padStart(6, '0')}`;
		let tmpSeq = (typeof(pKeepSeq) === 'string') ? pKeepSeq : this.nextSeq();
		pEvent.Seq = tmpSeq;
		pEvent.Epoch = libRetoldFacetingUtil.parseSeq(tmpSeq).Epoch;
		deepFreeze(pEvent);

		this._Stats.Events++;
		this._Stats.BySource[pEvent.Source] = (this._Stats.BySource[pEvent.Source] || 0) + 1;
		this._Stats.ByOperation[pEvent.Operation] = (this._Stats.ByOperation[pEvent.Operation] || 0) + 1;

		// A snapshot: a subscriber that (un)subscribes during delivery does not disturb this round.
		let tmpSubscribers = Array.from(this._Subscribers.entries());
		for (let i = 0; i < tmpSubscribers.length; i++)
		{
			try
			{
				tmpSubscribers[i][1](pEvent);
			}
			catch (pSubscriberError)
			{
				this._Stats.SubscriberErrors++;
				let tmpMessage = (pSubscriberError && (typeof(pSubscriberError.message) === 'string')) ? pSubscriberError.message : String(pSubscriberError);
				this.fable.log.warn(`RetoldFaceting change intake: subscriber ${logSafe(tmpSubscribers[i][0])} failed on a change of ${logSafe(pEvent.Entity)}: ${logSafe(tmpMessage)}`);
			}
		}
		return pEvent;
	}

	/**
	 * Normalize a raw change, assign its Seq, freeze it and deliver it synchronously
	 * (internal-contracts §39.3).  Never throws.
	 *
	 * @param {Record<string, any>} pRaw
	 * @return {Readonly<Record<string, any>>|null}
	 */
	ingest(pRaw)
	{
		let tmpEntity = null;
		try
		{
			tmpEntity = isPlainObject(pRaw) ? pRaw.Entity : null;
			let tmpEvent = this._normalize(pRaw);
			if (tmpEvent.Invalid)
			{
				return this._invalid('ingest', tmpEntity, tmpEvent.Invalid);
			}
			let tmpKeepSeq = ((tmpEvent.Source === 'Bus') && (libRetoldFacetingUtil.parseSeq(pRaw.Seq) !== null)) ? pRaw.Seq : null;
			return this._emit(tmpEvent, tmpKeepSeq, null);
		}
		catch (pIngestError)
		{
			return this._invalid('ingest', tmpEntity, `failed (${(pIngestError && pIngestError.message) ? pIngestError.message : String(pIngestError)})`);
		}
	}

	// ---------------------------------------------------------------- derivation from rows (§40.3)

	/**
	 * A raw change from row images (internal-contracts §40.3), shared by the interim intake and
	 * notify({ Records, Before }).  One row each (the interim intake: they are the same record), or
	 * arrays paired by primary key (notify).
	 *
	 *   pExtra.Source          'Interim' | 'Notify' | 'Bus'
	 *   pExtra.Actor           { PrincipalKey, UserID, Verb }
	 *   pExtra.Submitted       the submitted record (an Update's RecordToModify)
	 *   pExtra.BeforeMayBeAliased  the before-image may be the object a PreOperation behavior mutated
	 *                          (no snapshot): the submitted columns join the diff, and a submitted
	 *                          policy column whose images agree adds the unknown tenant / owner
	 *   pExtra.IDs             ids always included (notify)
	 *   pExtra.FallbackIDs     ids used only when no row names one (a Delete's IDRecord)
	 *   pExtra.Tenants / .Owners   explicit values, added to what the rows say (notify)
	 *   pExtra.ChangedColumns  explicit (an own property, even null, wins over the derivation; notify)
	 *   pExtra.Filter          EntityDirty only
	 *
	 * @param {string} pEntity
	 * @param {string} pOperation
	 * @param {Record<string, any>|Array<Record<string, any>>|null} pBefore
	 * @param {Record<string, any>|Array<Record<string, any>>|null} pAfter
	 * @param {Record<string, any>} [pExtra]
	 * @return {Record<string, any>}
	 */
	changeFromRows(pEntity, pOperation, pBefore, pAfter, pExtra)
	{
		let tmpExtra = isPlainObject(pExtra) ? pExtra : {};
		let tmpScope = this.scopeColumns(pEntity);
		let tmpPrimaryKey = tmpScope.PrimaryKey;
		let tmpTenantColumn = tmpScope.TenantColumn;
		let tmpOwnerColumn = tmpScope.OwnerColumn;
		let tmpIsModelColumn = this._modelColumnTest(pEntity) || (() => { return true; });
		let tmpIsColumnOperation = (COLUMN_OPERATIONS.indexOf(pOperation) >= 0);

		// Pair the images: a single row on each side is one record; arrays pair by primary key.
		let tmpPairs = [];
		let tmpBeforeRows = rowsOf(pBefore);
		let tmpAfterRows = rowsOf(pAfter);
		let tmpSubmitted = rowOf(tmpExtra.Submitted);
		if (!Array.isArray(pBefore) && !Array.isArray(pAfter))
		{
			if ((tmpBeforeRows.length > 0) || (tmpAfterRows.length > 0) || tmpSubmitted)
			{
				tmpPairs.push({ B: tmpBeforeRows[0] || null, A: tmpAfterRows[0] || null });
			}
		}
		else
		{
			let tmpByID = new Map();
			let fPair = (pRow, pSide) =>
			{
				let tmpID = (tmpPrimaryKey && hasOwn(pRow, tmpPrimaryKey)) ? idValue(pRow[tmpPrimaryKey]) : null;
				let tmpKey = (tmpID === null) ? null : identityOf(tmpID);
				if ((tmpKey !== null) && tmpByID.has(tmpKey) && !tmpByID.get(tmpKey)[pSide])
				{
					tmpByID.get(tmpKey)[pSide] = pRow;
					return;
				}
				let tmpPair = { B: null, A: null };
				tmpPair[pSide] = pRow;
				tmpPairs.push(tmpPair);
				if ((tmpKey !== null) && !tmpByID.has(tmpKey))
				{
					tmpByID.set(tmpKey, tmpPair);
				}
			};
			tmpBeforeRows.forEach((pRow) => { fPair(pRow, 'B'); });
			tmpAfterRows.forEach((pRow) => { fPair(pRow, 'A'); });
		}
		let fIDOf = (pPair) =>
		{
			let tmpID = null;
			if (tmpPrimaryKey)
			{
				if (pPair.A && hasOwn(pPair.A, tmpPrimaryKey))
				{
					tmpID = idValue(pPair.A[tmpPrimaryKey]);
				}
				if ((tmpID === null) && pPair.B && hasOwn(pPair.B, tmpPrimaryKey))
				{
					tmpID = idValue(pPair.B[tmpPrimaryKey]);
				}
				if ((tmpID === null) && tmpSubmitted && (tmpPairs.length === 1) && hasOwn(tmpSubmitted, tmpPrimaryKey))
				{
					tmpID = idValue(tmpSubmitted[tmpPrimaryKey]);
				}
			}
			return tmpID;
		};

		// IDs (a Set beside the list: notify() batches of 100k ids stay linear, P1)
		let tmpIDs = [];
		let tmpIDSeen = new Set();
		let fAddID = (pID) =>
		{
			let tmpID = idValue(pID);
			if (tmpID === null)
			{
				return;
			}
			let tmpIdentity = identityOf(tmpID);
			if (!tmpIDSeen.has(tmpIdentity))
			{
				tmpIDSeen.add(tmpIdentity);
				tmpIDs.push(tmpID);
			}
		};
		tmpPairs.forEach((pPair) => { pPair.ID = fIDOf(pPair); fAddID(pPair.ID); });
		if (Array.isArray(tmpExtra.IDs))
		{
			tmpExtra.IDs.forEach(fAddID);
		}
		if ((tmpIDs.length < 1) && Array.isArray(tmpExtra.FallbackIDs))
		{
			tmpExtra.FallbackIDs.forEach(fAddID);
			if ((tmpPairs.length === 1) && (tmpPairs[0].ID === null) && (tmpIDs.length > 0))
			{
				tmpPairs[0].ID = tmpIDs[0];
			}
		}

		// The submitted model columns (never the identity: it only locates the row).
		let tmpSubmittedColumns = [];
		if (tmpSubmitted && (tmpPairs.length === 1))
		{
			Object.keys(tmpSubmitted).forEach(
				(pColumn) =>
				{
					if ((pColumn !== tmpPrimaryKey) && tmpIsModelColumn(pColumn))
					{
						tmpSubmittedColumns.push(pColumn);
					}
				});
		}
		// An Update whose before-image may be the very object a PreOperation behavior mutated
		// (OriginalRecord === Record until the DAL update): the submitted columns are added to the diff,
		// and a submitted policy column whose two images agree has an unknown old value (§51.47).
		let tmpAliased = (tmpExtra.BeforeMayBeAliased === true) && (tmpPairs.length === 1);

		// ChangedColumns (Update / Touch): explicit, else the model-column diff of each pair ∪ the
		// audit columns (∪ the submitted columns when the before-image may be aliased), else the
		// submitted model columns ∪ the audit columns, else unknown.
		let tmpChangedColumns = null;
		if (tmpIsColumnOperation)
		{
			if (hasOwn(tmpExtra, 'ChangedColumns'))
			{
				tmpChangedColumns = Array.isArray(tmpExtra.ChangedColumns) ? tmpExtra.ChangedColumns.slice() : null;
			}
			else
			{
				let tmpColumns = new Set();
				let tmpUnknown = (tmpPairs.length < 1);
				tmpPairs.forEach(
					(pPair) =>
					{
						if (pPair.B && pPair.A)
						{
							let tmpNames = new Set(Object.keys(pPair.B).concat(Object.keys(pPair.A)));
							tmpNames.forEach(
								(pColumn) =>
								{
									if (!tmpIsModelColumn(pColumn))
									{
										return;
									}
									if (!hasOwn(pPair.B, pColumn) || !hasOwn(pPair.A, pColumn) || !sameValue(pPair.B[pColumn], pPair.A[pColumn]))
									{
										tmpColumns.add(pColumn);
									}
								});
							if (tmpAliased)
							{
								tmpSubmittedColumns.forEach((pColumn) => { tmpColumns.add(pColumn); });
							}
						}
						else if (tmpSubmitted && (tmpPairs.length === 1))
						{
							tmpSubmittedColumns.forEach((pColumn) => { tmpColumns.add(pColumn); });
						}
						else
						{
							tmpUnknown = true;
						}
					});
				if (!tmpUnknown)
				{
					AUDIT_COLUMNS.forEach((pColumn) => { if (tmpIsModelColumn(pColumn)) { tmpColumns.add(pColumn); } });
					tmpChangedColumns = Array.from(tmpColumns).sort();
				}
			}
		}
		// A column-changing write with a missing image whose policy column may have changed: the
		// other side's tenant (owner) is unknown.
		let fMayHaveChanged = (pColumn) =>
		{
			return !!pColumn && tmpIsColumnOperation && ((tmpChangedColumns === null) || (tmpChangedColumns.indexOf(pColumn) >= 0));
		};

		// Tenants (only from the rows or explicit values; never the session)
		let tmpTenants = [];
		let tmpTenantSeen = new Set();
		let fAddTenant = (pValue) =>
		{
			let tmpTenant = this._tenantValue(pValue);
			let tmpIdentity = identityOf(tmpTenant);
			if (!tmpTenantSeen.has(tmpIdentity))
			{
				tmpTenantSeen.add(tmpIdentity);
				tmpTenants.push(tmpTenant);
			}
		};
		// Owners (Personal entities): one pair per distinct (tenant, owner)
		let tmpOwners = null;
		let tmpOwnerSeen = new Set();
		let fAddOwner = (pTenant, pOwner) =>
		{
			let tmpTenant = tmpTenantColumn ? this._tenantValue(pTenant) : NO_TENANT;
			let tmpOwner = this._ownerValue(pOwner);
			if (!tmpOwners)
			{
				tmpOwners = [];
			}
			let tmpIdentity = `${identityOf(tmpTenant)}|${identityOf(tmpOwner)}`;
			if (!tmpOwnerSeen.has(tmpIdentity))
			{
				tmpOwnerSeen.add(tmpIdentity);
				tmpOwners.push({ Tenant: tmpTenant, Owner: tmpOwner });
			}
		};
		let fRowValue = (pRow, pColumn) =>
		{
			return hasOwn(pRow, pColumn) ? pRow[pColumn] : UNKNOWN;
		};
		tmpPairs.forEach(
			(pPair) =>
			{
				let tmpSides = [ pPair.B, pPair.A ].filter((pRow) => { return !!pRow; });
				tmpSides.forEach(
					(pRow) =>
					{
						if (tmpTenantColumn)
						{
							fAddTenant(fRowValue(pRow, tmpTenantColumn));
						}
						if (tmpOwnerColumn)
						{
							fAddOwner(tmpTenantColumn ? fRowValue(pRow, tmpTenantColumn) : NO_TENANT, fRowValue(pRow, tmpOwnerColumn));
						}
					});
				if (tmpIsColumnOperation && (tmpSides.length === 1))
				{
					let tmpKnown = tmpSides[0];
					let tmpTenantMoved = fMayHaveChanged(tmpTenantColumn);
					if (tmpTenantMoved)
					{
						fAddTenant(UNKNOWN);
					}
					if (tmpOwnerColumn && (tmpTenantMoved || fMayHaveChanged(tmpOwnerColumn)))
					{
						fAddOwner(tmpTenantMoved ? UNKNOWN : (tmpTenantColumn ? fRowValue(tmpKnown, tmpTenantColumn) : NO_TENANT), UNKNOWN);
					}
				}
				else if (tmpAliased && pPair.B && pPair.A)
				{
					// A submitted policy column whose images agree may have been rewritten in place.
					let tmpTenantSuspect = !!tmpTenantColumn && (tmpSubmittedColumns.indexOf(tmpTenantColumn) >= 0)
						&& sameValue(fRowValue(pPair.B, tmpTenantColumn), fRowValue(pPair.A, tmpTenantColumn));
					let tmpOwnerSuspect = !!tmpOwnerColumn && (tmpSubmittedColumns.indexOf(tmpOwnerColumn) >= 0)
						&& sameValue(fRowValue(pPair.B, tmpOwnerColumn), fRowValue(pPair.A, tmpOwnerColumn));
					if (tmpTenantSuspect)
					{
						fAddTenant(UNKNOWN);
					}
					if (tmpOwnerColumn && (tmpTenantSuspect || tmpOwnerSuspect))
					{
						fAddOwner(tmpTenantSuspect ? UNKNOWN : (tmpTenantColumn ? fRowValue(pPair.A, tmpTenantColumn) : NO_TENANT), UNKNOWN);
					}
				}
			});
		if (Array.isArray(tmpExtra.Tenants))
		{
			tmpExtra.Tenants.forEach(fAddTenant);
		}
		if (tmpOwnerColumn && Array.isArray(tmpExtra.Owners))
		{
			tmpExtra.Owners.forEach((pPair) => { if (isPlainObject(pPair)) { fAddOwner(pPair.Tenant, pPair.Owner); } });
		}
		if (!tmpTenantColumn || (tmpTenants.length < 1))
		{
			tmpTenants = [ UNKNOWN ];
		}
		if (!tmpOwnerColumn)
		{
			tmpOwners = null;
		}

		// KeyImages: the policy columns only; B absent on Create, A absent on Delete / Undelete.
		let tmpKeyImages = {};
		let tmpPolicyColumns = [ tmpTenantColumn, tmpOwnerColumn ].filter((pColumn) => { return !!pColumn; });
		if (tmpPolicyColumns.length > 0)
		{
			let fPick = (pRow) =>
			{
				let tmpImage = {};
				tmpPolicyColumns.forEach((pColumn) => { tmpImage[pColumn] = hasOwn(pRow, pColumn) ? normalizeScopeValue(pRow[pColumn]) : null; });
				return tmpImage;
			};
			tmpPairs.forEach(
				(pPair) =>
				{
					if (pPair.ID === null)
					{
						return;
					}
					let tmpImage = {};
					if (pPair.B && (pOperation !== 'Create'))
					{
						tmpImage.B = fPick(pPair.B);
					}
					if (pPair.A && (pOperation !== 'Delete') && (pOperation !== 'Undelete'))
					{
						tmpImage.A = fPick(pPair.A);
					}
					if (tmpImage.B || tmpImage.A)
					{
						tmpKeyImages[String(pPair.ID)] = tmpImage;
					}
				});
		}

		let tmpRaw = (
			{
				Source: (SOURCES.indexOf(tmpExtra.Source) >= 0) ? tmpExtra.Source : 'Notify',
				Entity: pEntity,
				Operation: pOperation,
				IDs: tmpIDs,
				Tenants: tmpTenants,
				Owners: tmpOwners,
				ChangedColumns: tmpChangedColumns,
				KeyImages: tmpKeyImages,
				Filter: (pOperation === 'EntityDirty') ? (tmpExtra.Filter || null) : null,
				Actor: isPlainObject(tmpExtra.Actor) ? Object.assign({}, tmpExtra.Actor) : null
			});
		return tmpRaw;
	}

	// ---------------------------------------------------------------- notify (§40.5)

	/**
	 * The Actor of a notify: the principal key the caller passed ({ Principal } or { PrincipalKey },
	 * for read-your-writes, §45); false when malformed.
	 *
	 * @param {Record<string, any>} pSource
	 * @return {{ PrincipalKey: string|null, UserID: any, Verb: string }|false}
	 */
	_notifyActor(pSource)
	{
		let tmpActor = { PrincipalKey: null, UserID: 0, Verb: 'Notify' };
		if ((pSource.PrincipalKey !== null) && (typeof(pSource.PrincipalKey) !== 'undefined'))
		{
			if ((typeof(pSource.PrincipalKey) !== 'string') || !PRINCIPAL_KEY_PATTERN.test(pSource.PrincipalKey))
			{
				return false;
			}
			tmpActor.PrincipalKey = pSource.PrincipalKey;
		}
		else if ((pSource.Principal !== null) && (typeof(pSource.Principal) !== 'undefined'))
		{
			if (!isPlainObject(pSource.Principal))
			{
				return false;
			}
			tmpActor.PrincipalKey = libRetoldFacetingUtil.principalKey(pSource.Principal);
			let tmpUserID = normalizeScopeValue(pSource.Principal.IDUser);
			tmpActor.UserID = (tmpUserID === null) ? 0 : tmpUserID;
		}
		return tmpActor;
	}

	/**
	 * Is the entity known to the host (it has a DAL)?
	 *
	 * @param {any} pEntity
	 * @return {boolean}
	 */
	_hasDAL(pEntity)
	{
		if ((typeof(pEntity) !== 'string') || (pEntity.length < 1))
		{
			return false;
		}
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.getDAL) !== 'function'))
		{
			return false;
		}
		try
		{
			return !!tmpHost.getDAL(pEntity);
		}
		catch (pDALError)
		{
			return false;
		}
	}

	/**
	 * Arm the settle re-delivery of a Notify event (05 §5): the same facts once more after
	 * ChangeCapture.NotifySettleMS, under a new Seq, so a notify sent just before its commit became
	 * visible cannot leave an entry computed on the old row valid.  Settles are coalesced per
	 * (Entity, Operation) within one window (P8): the first notify arms ONE timer, later ones merge
	 * their ids, tenants, owners and changed columns into it (an unknown list wins), so an importer
	 * notifying per row costs one re-delivery per window, not one per row.
	 *
	 * @param {Readonly<Record<string, any>>} pEvent
	 */
	_armSettle(pEvent)
	{
		let tmpSettleMS = isPlainObject(this.options.ChangeCapture) ? this.options.ChangeCapture.NotifySettleMS : 0;
		if (!pEvent || this._ShutDown || (typeof(tmpSettleMS) !== 'number') || !(tmpSettleMS > 0))
		{
			return;
		}
		let tmpKey = `${pEvent.Entity}|${pEvent.Operation}`;
		let tmpPending = this._SettlePending.get(tmpKey);
		if (tmpPending)
		{
			tmpPending.Count++;
			pEvent.IDs.forEach((pID) => { tmpPending.IDs.set(identityOf(pID), pID); });
			pEvent.Tenants.forEach((pTenant) => { tmpPending.Tenants.set(identityOf(pTenant), pTenant); });
			if ((tmpPending.Owners === null) || (pEvent.Owners === null))
			{
				tmpPending.Owners = null;
			}
			else
			{
				pEvent.Owners.forEach((pPair) => { tmpPending.Owners.set(`${identityOf(pPair.Tenant)}|${identityOf(pPair.Owner)}`, pPair); });
			}
			if ((tmpPending.ChangedColumns === null) || (pEvent.ChangedColumns === null))
			{
				tmpPending.ChangedColumns = null;
			}
			else
			{
				pEvent.ChangedColumns.forEach((pColumn) => { tmpPending.ChangedColumns.add(pColumn); });
			}
			return;
		}
		tmpPending = (
			{
				First: pEvent,
				Count: 1,
				IDs: new Map(pEvent.IDs.map((pID) => { return [ identityOf(pID), pID ]; })),
				Tenants: new Map(pEvent.Tenants.map((pTenant) => { return [ identityOf(pTenant), pTenant ]; })),
				Owners: (pEvent.Owners === null) ? null : new Map(pEvent.Owners.map((pPair) => { return [ `${identityOf(pPair.Tenant)}|${identityOf(pPair.Owner)}`, pPair ]; })),
				ChangedColumns: (pEvent.ChangedColumns === null) ? null : new Set(pEvent.ChangedColumns),
				Timer: null
			});
		this._SettlePending.set(tmpKey, tmpPending);
		let tmpTimer = setTimeout(
			() =>
			{
				this._SettleTimers.delete(tmpTimer);
				if (this._SettlePending.get(tmpKey) === tmpPending)
				{
					this._SettlePending.delete(tmpKey);
				}
				try
				{
					let tmpFirst = tmpPending.First;
					let tmpEvent = Object.assign({}, tmpFirst,
						{
							IDs: Array.from(tmpPending.IDs.values()),
							Tenants: Array.from(tmpPending.Tenants.values()),
							Owners: (tmpPending.Owners === null) ? null : Array.from(tmpPending.Owners.values()).map((pPair) => { return { Tenant: pPair.Tenant, Owner: pPair.Owner }; }),
							ChangedColumns: (tmpPending.ChangedColumns === null) ? null : Array.from(tmpPending.ChangedColumns).sort(),
							// One write's key images say nothing about a merged settle.
							KeyImages: (tmpPending.Count === 1) ? tmpFirst.KeyImages : {},
							Filter: (tmpPending.Count === 1) ? tmpFirst.Filter : null,
							Timestamp: Date.now(),
							Epoch: null,
							Seq: null
						});
					this._emit(tmpEvent, null, `${tmpFirst.ChangeID}~settle`);
				}
				catch (pSettleError)
				{
					this.fable.log.warn(`RetoldFaceting change intake: the settle re-delivery of a change of ${logSafe(tmpPending.First.Entity)} failed: ${logSafe(pSettleError.message)}`);
				}
			}, tmpSettleMS);
		if (tmpTimer && (typeof(tmpTimer.unref) === 'function'))
		{
			tmpTimer.unref();
		}
		tmpPending.Timer = tmpTimer;
		this._SettleTimers.add(tmpTimer);
	}

	/**
	 * A notify event that fell back to every tenant ('*') on a Tenant / Personal entity of a policy
	 * host (S8): counted (UnknownTenant) and warned about at most once a minute per entity — one such
	 * call invalidates every tenant's answers over the entity.
	 *
	 * @param {Readonly<Record<string, any>>} pEvent
	 */
	_noteUnknownTenant(pEvent)
	{
		if (!pEvent || !Array.isArray(pEvent.Tenants) || (pEvent.Tenants.indexOf(UNKNOWN) < 0))
		{
			return;
		}
		let tmpScope = this.scopeColumns(pEvent.Entity);
		if (!tmpScope.TenantColumn)
		{
			return;
		}
		this._Stats.UnknownTenant++;
		let tmpNow = Date.now();
		let tmpLast = this._UnknownTenantWarned.get(pEvent.Entity) || 0;
		if ((tmpNow - tmpLast) >= UNKNOWN_TENANT_WARN_MS)
		{
			this._UnknownTenantWarned.set(pEvent.Entity, tmpNow);
			this.fable.log.warn(`RetoldFaceting change intake: a notify of ${logSafe(pEvent.Entity)} named no tenant, so it invalidates (and signals) every tenant; pass Tenants (or Records carrying ${logSafe(tmpScope.TenantColumn)}).`);
		}
	}

	/**
	 * ChangeCapture.RequireNotifyTenants: refuse a notify of a Tenant / Personal entity that names no
	 * tenant (no Tenants, and no row image carrying the tenant column).
	 *
	 * @param {string} pEntity
	 * @param {any} pTenants
	 * @param {Array<any>} pRows
	 * @return {boolean} true when the notify must be refused
	 */
	_missingRequiredTenants(pEntity, pTenants, pRows)
	{
		let tmpCapture = isPlainObject(this.options.ChangeCapture) ? this.options.ChangeCapture : {};
		if (tmpCapture.RequireNotifyTenants !== true)
		{
			return false;
		}
		let tmpScope = this.scopeColumns(pEntity);
		if (!tmpScope.TenantColumn)
		{
			return false;
		}
		if (Array.isArray(pTenants) && (pTenants.length > 0))
		{
			return false;
		}
		return !pRows.some((pRow) => { return isPlainObject(pRow) && hasOwn(pRow, tmpScope.TenantColumn); });
	}

	/**
	 * A raw writer's change, after COMMIT (internal-contracts §40.5).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pChange] - { Operation, IDs, Records, Before, Tenants, Owners, ChangedColumns, Principal | PrincipalKey }
	 * @return {string|null} the Seq, or null when refused (logged)
	 */
	notify(pEntity, pChange)
	{
		try
		{
			if (!this._hasDAL(pEntity))
			{
				return this._invalid('notify', pEntity, 'unknown entity (no DAL)');
			}
			let tmpChange = ((pChange === null) || (typeof(pChange) === 'undefined')) ? {} : pChange;
			if (!isPlainObject(tmpChange))
			{
				return this._invalid('notify', pEntity, 'the change is not an object');
			}
			let tmpOperation = (typeof(tmpChange.Operation) === 'undefined') ? 'Update' : tmpChange.Operation;
			if (OPERATIONS.indexOf(tmpOperation) < 0)
			{
				return this._invalid('notify', pEntity, 'Operation');
			}
			let tmpArrays = [ 'IDs', 'Records', 'Before', 'Tenants', 'Owners' ];
			for (let i = 0; i < tmpArrays.length; i++)
			{
				let tmpValue = tmpChange[tmpArrays[i]];
				if ((tmpValue !== null) && (typeof(tmpValue) !== 'undefined') && !Array.isArray(tmpValue))
				{
					return this._invalid('notify', pEntity, `${tmpArrays[i]} is not an array`);
				}
			}
			if ((tmpChange.ChangedColumns !== null) && (typeof(tmpChange.ChangedColumns) !== 'undefined')
				&& (!Array.isArray(tmpChange.ChangedColumns) || tmpChange.ChangedColumns.some((pColumn) => { return (typeof(pColumn) !== 'string') || (pColumn.length < 1); })))
			{
				return this._invalid('notify', pEntity, 'ChangedColumns');
			}
			if (Array.isArray(tmpChange.Owners) && tmpChange.Owners.some((pPair) => { return !isPlainObject(pPair); }))
			{
				return this._invalid('notify', pEntity, 'Owners');
			}
			let tmpActor = this._notifyActor(tmpChange);
			if (tmpActor === false)
			{
				return this._invalid('notify', pEntity, 'Principal / PrincipalKey');
			}
			if (this._missingRequiredTenants(pEntity, tmpChange.Tenants, (Array.isArray(tmpChange.Records) ? tmpChange.Records : []).concat(Array.isArray(tmpChange.Before) ? tmpChange.Before : [])))
			{
				return this._invalid('notify', pEntity, 'Tenants (ChangeCapture.RequireNotifyTenants)');
			}
			let tmpRaw = this.changeFromRows(pEntity, tmpOperation,
				Array.isArray(tmpChange.Before) ? tmpChange.Before : null,
				Array.isArray(tmpChange.Records) ? tmpChange.Records : null,
				{
					Source: 'Notify',
					Actor: tmpActor,
					IDs: Array.isArray(tmpChange.IDs) ? tmpChange.IDs : [],
					Tenants: Array.isArray(tmpChange.Tenants) ? tmpChange.Tenants : null,
					Owners: Array.isArray(tmpChange.Owners) ? tmpChange.Owners : null,
					// absent or null → unknown ('#all')
					ChangedColumns: Array.isArray(tmpChange.ChangedColumns) ? tmpChange.ChangedColumns : null
				});
			let tmpEvent = this.ingest(tmpRaw);
			if (!tmpEvent)
			{
				return null;
			}
			this._noteUnknownTenant(tmpEvent);
			this._armSettle(tmpEvent);
			return tmpEvent.Seq;
		}
		catch (pNotifyError)
		{
			return this._invalid('notify', pEntity, `failed (${(pNotifyError && pNotifyError.message) ? pNotifyError.message : String(pNotifyError)})`);
		}
	}

	/**
	 * Alias of notify (05 §5 naming).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pChange]
	 * @return {string|null}
	 */
	notifyChanged(pEntity, pChange)
	{
		return this.notify(pEntity, pChange);
	}

	/**
	 * "Everything matching this PRE-write predicate changed" (internal-contracts §40.5): an EntityDirty
	 * event carrying the filter (never parsed or executed in M4).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string|Array<Record<string, any>>} pFilter
	 * @param {Record<string, any>} [pOptions] - { Tenants, Owners, Principal | PrincipalKey }
	 * @return {string|null}
	 */
	notifyByFilter(pEntity, pFilter, pOptions)
	{
		try
		{
			if (!this._hasDAL(pEntity))
			{
				return this._invalid('notifyByFilter', pEntity, 'unknown entity (no DAL)');
			}
			if (!(((typeof(pFilter) === 'string') && (pFilter.length > 0)) || Array.isArray(pFilter)))
			{
				return this._invalid('notifyByFilter', pEntity, 'the filter must be a non-empty string or an array');
			}
			let tmpOptions = ((pOptions === null) || (typeof(pOptions) === 'undefined')) ? {} : pOptions;
			if (!isPlainObject(tmpOptions))
			{
				return this._invalid('notifyByFilter', pEntity, 'the options are not an object');
			}
			let tmpArrays = [ 'Tenants', 'Owners' ];
			for (let i = 0; i < tmpArrays.length; i++)
			{
				let tmpValue = tmpOptions[tmpArrays[i]];
				if ((tmpValue !== null) && (typeof(tmpValue) !== 'undefined') && !Array.isArray(tmpValue))
				{
					return this._invalid('notifyByFilter', pEntity, `${tmpArrays[i]} is not an array`);
				}
			}
			if (Array.isArray(tmpOptions.Owners) && tmpOptions.Owners.some((pPair) => { return !isPlainObject(pPair); }))
			{
				return this._invalid('notifyByFilter', pEntity, 'Owners');
			}
			let tmpActor = this._notifyActor(tmpOptions);
			if (tmpActor === false)
			{
				return this._invalid('notifyByFilter', pEntity, 'Principal / PrincipalKey');
			}
			if (this._missingRequiredTenants(pEntity, tmpOptions.Tenants, []))
			{
				return this._invalid('notifyByFilter', pEntity, 'Tenants (ChangeCapture.RequireNotifyTenants)');
			}
			let tmpEvent = this.ingest(
				{
					Source: 'Notify',
					Entity: pEntity,
					Operation: 'EntityDirty',
					IDs: [],
					Tenants: Array.isArray(tmpOptions.Tenants) ? tmpOptions.Tenants : [ UNKNOWN ],
					Owners: Array.isArray(tmpOptions.Owners) ? tmpOptions.Owners : null,
					ChangedColumns: null,
					KeyImages: {},
					Filter: pFilter,
					Actor: tmpActor
				});
			if (!tmpEvent)
			{
				return null;
			}
			this._noteUnknownTenant(tmpEvent);
			this._armSettle(tmpEvent);
			return tmpEvent.Seq;
		}
		catch (pNotifyError)
		{
			return this._invalid('notifyByFilter', pEntity, `failed (${(pNotifyError && pNotifyError.message) ? pNotifyError.message : String(pNotifyError)})`);
		}
	}

	// ---------------------------------------------------------------- the Bus seam (§40.6)

	/**
	 * Map an upstream MeadowChangeBus event (05 §3.3) onto a ChangeEvent (internal-contracts §40.6):
	 * Images dropped, KeyImages reduced to the policy columns (Via dropped), Owners derived from the
	 * KeyImages, DeleteByFilter folded into EntityDirty, the bus Seq kept when it matches SEQ_PATTERN.
	 *
	 * @param {Record<string, any>} pBusEvent
	 * @return {Readonly<Record<string, any>>|null}
	 */
	ingestBusEvent(pBusEvent)
	{
		let tmpEntity = null;
		try
		{
			if (!isPlainObject(pBusEvent))
			{
				return this._invalid('the bus', null, 'not an object');
			}
			tmpEntity = pBusEvent.Entity;
			if ((typeof(tmpEntity) !== 'string') || (tmpEntity.length < 1))
			{
				return this._invalid('the bus', null, 'Entity');
			}
			let tmpScope = this.scopeColumns(tmpEntity);
			let tmpPolicyColumns = [ tmpScope.TenantColumn, tmpScope.OwnerColumn ].filter((pColumn) => { return !!pColumn; });
			let tmpOperation = (pBusEvent.Operation === 'DeleteByFilter') ? 'EntityDirty' : pBusEvent.Operation;

			let tmpKeyImages = {};
			let tmpOwners = null;
			if (isPlainObject(pBusEvent.KeyImages))
			{
				Object.keys(pBusEvent.KeyImages).forEach(
					(pID) =>
					{
						let tmpImage = pBusEvent.KeyImages[pID];
						if (!isPlainObject(tmpImage))
						{
							return;
						}
						let tmpClean = {};
						[ 'B', 'A' ].forEach(
							(pSide) =>
							{
								if (!isPlainObject(tmpImage[pSide]))
								{
									return;
								}
								if (tmpPolicyColumns.length > 0)
								{
									tmpClean[pSide] = {};
									tmpPolicyColumns.forEach((pColumn) => { tmpClean[pSide][pColumn] = hasOwn(tmpImage[pSide], pColumn) ? tmpImage[pSide][pColumn] : null; });
								}
								if (tmpScope.OwnerColumn && hasOwn(tmpImage[pSide], tmpScope.OwnerColumn))
								{
									if (!tmpOwners)
									{
										tmpOwners = [];
									}
									tmpOwners.push(
										{
											Tenant: tmpScope.TenantColumn ? (hasOwn(tmpImage[pSide], tmpScope.TenantColumn) ? tmpImage[pSide][tmpScope.TenantColumn] : UNKNOWN) : NO_TENANT,
											Owner: tmpImage[pSide][tmpScope.OwnerColumn]
										});
								}
							});
						if (tmpClean.B || tmpClean.A)
						{
							tmpKeyImages[String(pID)] = tmpClean;
						}
					});
			}

			let tmpActorIn = isPlainObject(pBusEvent.Actor) ? pBusEvent.Actor : {};
			let tmpActor = { PrincipalKey: null, UserID: tmpActorIn.UserID, Verb: (typeof(tmpActorIn.Verb) === 'string') ? tmpActorIn.Verb : 'Bus' };
			if ((typeof(tmpActorIn.PrincipalKey) === 'string') && PRINCIPAL_KEY_PATTERN.test(tmpActorIn.PrincipalKey))
			{
				tmpActor.PrincipalKey = tmpActorIn.PrincipalKey;
			}
			else if (isPlainObject(tmpActorIn.Session))
			{
				// ME-3 ChangeContext.Session: the writer's session, built into a principal exactly like a read's.
				let tmpHost = this._host();
				if (tmpHost && (typeof(tmpHost.buildPrincipal) === 'function'))
				{
					try
					{
						let tmpPrincipal = tmpHost.buildPrincipal(tmpActorIn.Session, null);
						tmpActor.PrincipalKey = libRetoldFacetingUtil.principalKey(tmpPrincipal);
						if ((tmpActor.UserID === null) || (typeof(tmpActor.UserID) === 'undefined'))
						{
							tmpActor.UserID = tmpPrincipal.IDUser;
						}
					}
					catch (pPrincipalError)
					{
						tmpActor.PrincipalKey = null;
					}
				}
			}

			return this.ingest(
				{
					Source: 'Bus',
					Entity: tmpEntity,
					Operation: tmpOperation,
					IDs: Array.isArray(pBusEvent.IDs) ? pBusEvent.IDs : [],
					Tenants: Array.isArray(pBusEvent.Tenants) ? pBusEvent.Tenants : [ UNKNOWN ],
					Owners: tmpOwners,
					ChangedColumns: Array.isArray(pBusEvent.ChangedColumns) ? pBusEvent.ChangedColumns : null,
					KeyImages: tmpKeyImages,
					Filter: (tmpOperation === 'EntityDirty') ? (pBusEvent.Filter || null) : null,
					Actor: tmpActor,
					Timestamp: pBusEvent.Timestamp,
					Seq: pBusEvent.Seq
				});
		}
		catch (pBusError)
		{
			return this._invalid('the bus', tmpEntity, `failed (${(pBusError && pBusError.message) ? pBusError.message : String(pBusError)})`);
		}
	}

	// ---------------------------------------------------------------- lifecycle and stats

	/**
	 * Is a notify settle re-delivery of this entity still armed (a change already reported that will be
	 * delivered once more under a new Seq)?  Materializer.quiesce waits for it.  O(operations).
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	settling(pEntity)
	{
		for (let tmpPending of this._SettlePending.values())
		{
			if (tmpPending && tmpPending.First && (tmpPending.First.Entity === pEntity))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Clear the notify settle timers (service shutdown).  Wrappers stay installed (harmless); later
	 * notify() calls still deliver but arm no settle timer.
	 */
	shutdown()
	{
		this._ShutDown = true;
		this._SettleTimers.forEach((pTimer) => { clearTimeout(pTimer); });
		this._SettleTimers.clear();
		this._SettlePending.clear();
	}

	/**
	 * @return {Record<string, any>} internal-contracts §40.7
	 */
	stats()
	{
		return (
			{
				Source: this._Source,
				Entities: this._Entities.length,
				Events: this._Stats.Events,
				BySource: Object.assign({}, this._Stats.BySource),
				ByOperation: Object.assign({}, this._Stats.ByOperation),
				SubscriberErrors: this._Stats.SubscriberErrors,
				WrapperErrors: this._Stats.WrapperErrors,
				Invalid: this._Stats.Invalid,
				UnconfirmedWrites: this._Stats.UnconfirmedWrites,
				FailClosed: this._Stats.FailClosed,
				Rewraps: this._Stats.Rewraps,
				UnknownTenant: this._Stats.UnknownTenant,
				Capped: this._Stats.Capped,
				LastSeq: this.currentSeq()
			});
	}
}

module.exports = RetoldFacetingChangeIntake;
module.exports.serviceType = 'RetoldFacetingChangeIntake';
module.exports.OPERATIONS = OPERATIONS;
module.exports.SOURCES = SOURCES;
module.exports.INTERIM_SLOTS = INTERIM_SLOTS;
module.exports.INTAKE_MODES = INTAKE_MODES;
module.exports.AUDIT_COLUMNS = AUDIT_COLUMNS;
