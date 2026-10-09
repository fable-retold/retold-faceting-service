/**
 * Retold Faceting Service - Options
 *
 * The single configuration reference (design 07 §7): one `RetoldFaceting` key for every role.
 * Every service constructor resolves its options through `resolve()` so a service can be
 * constructed with nothing, a partial object, or an already-resolved object.
 *
 * Milestone 1 reads: Role, InstanceID, RoutePrefix, Catalog, Scope, Authorization, Limits, Time;
 * Milestone 2 adds Definitions, Execution.Cube / Execution.Staged and Cache.NowBucketMS ($Now binding).
 * Everything else is present so later milestones (and unknown-key warnings) have a home.
 *
 * Limits: the request / envelope limits come from the contract (Facet-Contract-Request
 * LIMIT_DEFAULTS, one owner); the rest are server-only.  Every key in DEFAULTS.Limits is ENFORCED
 * in this milestone.  The limits of later phases (LIMITS_NOT_ENFORCED) are deliberately absent:
 * configuring one changes nothing yet, and attach() logs a warning naming it.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const libFacetRequest = require('./contract/Facet-Contract-Request.js');
const libFacetUtil = require('./contract/Facet-Contract-Util.js');

const RESOLVED_MARKER = '__RetoldFacetingOptionsResolved';

// Limits of later phases: accepted in configuration, not enforced yet (07 §7).  MaxExistsDepth,
// MaxStagedKeys, MaxRecordsPage, MaxRecordsOffset and MaxKeys moved into DEFAULTS.Limits in M2
// (internal-contracts §19.4).
const LIMITS_NOT_ENFORCED = Object.freeze(
	[
		'InListChunk', 'MaxBindBytes', 'SharedMaxRowsPerStatement',
		'MaxLiveRows', 'MaxLiveRowScansPerRequest', 'HardMaxLiveRows', 'SQLiteMaxRows', 'ScanFoldMaxRows',
		'ScanFoldCPUMS', 'ExactDistinctMaxRows', 'ResponseBytes'
	]);

// Entity names that would collide with facet routes (D-17).
const ROUTE_RESERVED_NAMES = [ 'Facet', 'Describe', 'Agent', 'Admin', 'Changes', 'Status' ];

// Entities that can never be facetable (06 §5.1).
const NEVER_FACETABLE = [ 'Account', 'ApiKey', 'LoginChallenge', 'RetoldFacetChangeLog' ];

const DEFAULTS = (
	{
		Role: 'Embedded',
		InstanceID: 'main',
		RoutePrefix: '/1.0/Facet',
		Host: 'Auto',

		Catalog:
			{
				AutoDerive: true,
				MaxTermsStringSize: 128,
				AutoFKTermsMaxTargetRows: 10000,
				OverridesFile: false,
				HubEntities: [ 'User', 'Customer', 'DataSource' ],
				ListOneHop: false,
				// 'Default' = the built-in name-pattern denylist; an array adds explicit 'Entity.Column' entries to it.
				Sensitive: 'Default',
				GlobalEntities: [],
				NeverFacet: [],
				Controllerless: {}
			},

		// Definitions files (internal-contracts §20.1): every *.json directly under Path (a missing
		// directory loads nothing), then Files (relative to Path unless absolute), then Objects (parsed
		// definitions objects: tests, and hosts that build them in code).  Ad-hoc definitions stay
		// refused in M2 (403 FACET_ADHOC_FORBIDDEN).
		Definitions:
			{
				Path: 'facets/',
				Files: [],
				Objects: [],
				AllowAdHoc: false
			},

		Scope:
			{
				Behavior: 'Reads-QueryConfiguration',
				BehaviorOverrides: {},
				Guard: 'Strict',
				// 'Auto' on a plain RDS means no policy (ScopeAssurance 'Unscoped').
				// A policy object looks like { Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [], PersonalScopes: {} }.
				Policy: 'Auto',
				Required: {},
				UserRecordFields: [ 'IDUser', 'IDCustomer' ],
				UnsetValues: [ 0, '', null ],
				TrustedOpaque: [],
				DependsOn: {},
				TrustPostOperation: [],
				PostOperationSafeColumns: {},
				AllowHeaderSession: false
			},

		Authorization:
			{
				Strategy: 'Auto',
				RequireAction: false,
				EntitlementCacheMS: 10000,
				PrivilegedActions: [],
				PlatformActionsFromRoles: false
			},

		ServiceAuth:
			{
				KeysEnv: null,
				SkewMS: 30000,
				NonceStore: 'Auto'
			},

		Execution:
			{
				Pool:
					{
						Mode: 'Auto',
						AllowShared: false,
						Provider: null,
						ConnectionEnv: null,
						Max: 4,
						ApplicationName: 'retold-faceting',
						TreatReplicaAsExact: false,
						ReplicaMaxLagMS: 5000
					},
				MaxParallelStatements: 4,
				// M2 plan forms (internal-contracts §25, §26.3): 'Auto' | 'Always' | 'Never'.  Cube 'Auto'
				// answers the cube-eligible facets of one pivot with one GROUP BY when at least two are
				// eligible; Staged 'Auto' stages a hop only when its capture is Opaque and the entity is in
				// Scope.TrustedOpaque.  In-process callers override per request (pContext.PlanForm).
				Cube: 'Auto',
				Staged: 'Auto'
			},

		Limits: Object.assign({}, libFacetRequest.LIMIT_DEFAULTS,
			{
				// Steps per resolved path (after alias splicing), checked at definition load.
				MaxHops: 4,
				MaxRelationsPerRequest: 32,
				MaxBehaviorRunsPerRequest: 32,
				// Rows a Terms statement may return beyond Top + 1 when counts tie at the cut.
				MaxTermsGroups: 10000,
				// Cells a Pivot may have before it is 422 FACET_TOO_LARGE; also the grain-row cap of the
				// conditional disjunctive scan (over it the cube falls back to per-Variant statements).
				CubeMaxGroups: 100000,
				// Enforced from M2 (internal-contracts §19.4; MaxRecordsPage, MaxRecordsOffset and
				// MaxKeys are request limits, so the contract's LIMIT_DEFAULTS owns them):
				MaxExistsDepth: 4,
				MaxScopeDepth: 3,
				MaxScopesPerRequest: 16,
				MaxStagedKeys: 50000
			}),

		Admission:
			{
				PerPrincipal: 4,
				PerTenant: 16,
				Global: 64,
				QueueMS: 2000,
				PreAuth: { Global: 256, PerIPPer10s: 60, NegativeCacheMS: 5000 }
			},

		Time:
			{
				StorageTimeZone: 'UTC',
				AllowRequestTimeZone: false,
				DefaultInterval: 'month'
			},

		// M4 (internal-contracts §38.4): the result cache and the generation Version are opt-in
		// (Enabled: false) until the upstream DAL hook (M-1) lands: the interim intake sees only
		// endpoint writes, so a host that writes through DALs or raw SQL must call notify() first.
		// Generations and entries live in ONE process: Enabled is only correct when every writer of the
		// faceted tables runs in this same process (one node serving every write); with several
		// processes, process B never sees process A's writes until Cache.MaxAgeMS (§51.50).
		// ExposeStatus: the X-Retold-Facet-Cache / -Freshness headers and a truthful Cached flag on
		// another principal's entry (an operator / demo switch, S9).
		Cache:
			{
				Enabled: false,
				ExposeStatus: false,
				MaxConcurrentRefreshes: 4,
				MaxBytes: 67108864,
				MaxEntries: 5000,
				MaxEntryBytes: 4194304,
				MaxAgeMS: 600000,
				GenerationGranularity: 'Column',
				MaxGenerationKeys: 'Auto',
				MaxGenerationFloors: 50000,
				AgentlessTTLMS: 15000,
				OpaqueTTLMS: 0,
				NowBucketMS: 60000,
				AsOfBucketMS: 5000
			},

		Freshness:
			{
				DefaultMode: 'Exact',
				MaxLagMS: 5000,
				LagWarnMS: 2000,
				StatePollMS: 250,
				FeedMaxLagMS: 2000,
				MinSeqWaitMS: 1500,
				ReadYourWritesMS: 10000,
				ReadYourWritesMaxPrincipals: 10000,
				// true | false | 'Auto' (only on a host without a scope policy: the Seq is the node-wide
				// change counter, which on a multi-tenant host reveals other tenants' write volume)
				SeqHeader: 'Auto'
			},

		// M4 (internal-contracts §40.1): 'Auto' = the upstream MeadowChangeBus when fable has one, else
		// the interim intake (the wrapped behavior dispatcher and DAL write methods of each route-bound
		// controller); 'None' installs nothing.  NotifyManaged: true or [ 'Entity', … ] — entities whose
		// every write the host reports through notify() (else an entity no source sees is never cached).
		// RequireNotifyTenants: refuse a notify of a tenant-scoped entity that names no tenant.
		// MaxEventIDs / MaxEventOwners: beyond them an event's ids / owners become "unknown".
		ChangeCapture: { Intake: 'Auto', NotifySettleMS: 1000, NotifyManaged: [], RequireNotifyTenants: false, MaxEventIDs: 10000, MaxEventOwners: 1000 },
		Reconcile: {},
		Stores: { ClickHouse: false, Solr: false, OpenSearch: false },
		Materialize: {},
		Materializer: { Enabled: false },
		Agent: { PrivateListener: false },
		Upstream: { URL: false },
		Edge: { Role: 'Gateway' },
		// M4 (internal-contracts §46): GET <RoutePrefix>/Changes.  Enabled: true | false | 'Auto' (only
		// on a host with a scope policy: without one every write is visible to every stream).
		// IncludeSeq: true | false | 'Auto' (as Freshness.SeqHeader).  AllowedOrigins: cross-origin
		// pages allowed to open a stream ('*' = any; same-origin is always allowed).
		SSE:
			{
				Enabled: 'Auto',
				AllowedOrigins: [],
				CoalesceMS: 250,
				HeartbeatMS: 15000,
				GlobalTickMS: 60000,
				MaxPerPrincipal: 2,
				MaxPerTenant: 200,
				MaxConnections: 1000,
				RevalidateMS: 300000,
				RetryMS: 3000,
				IncludeSeq: 'Auto'
			},
		Admin: { RebuildCooldownMS: 600000 },
		Privacy: { MinBucketCount: 0 },
		Compat: { SluiceAggregate: false }
	});

const isPlainObject = libFacetUtil.isPlainObject;

/**
 * Deep merge: plain objects merge recursively, arrays and scalars from pOverride replace.
 * Neither input is mutated.
 *
 * @param {Record<string, any>} pBase
 * @param {Record<string, any>} pOverride
 * @return {Record<string, any>}
 */
const deepMerge = (pBase, pOverride) =>
{
	let tmpResult = {};
	let tmpBaseKeys = Object.keys(pBase || {});
	for (let i = 0; i < tmpBaseKeys.length; i++)
	{
		let tmpValue = pBase[tmpBaseKeys[i]];
		tmpResult[tmpBaseKeys[i]] = isPlainObject(tmpValue) ? deepMerge(tmpValue, {})
			: Array.isArray(tmpValue) ? tmpValue.slice()
			: tmpValue;
	}
	if (!isPlainObject(pOverride))
	{
		return tmpResult;
	}
	let tmpOverrideKeys = Object.keys(pOverride);
	for (let i = 0; i < tmpOverrideKeys.length; i++)
	{
		let tmpKey = tmpOverrideKeys[i];
		let tmpValue = pOverride[tmpKey];
		if (isPlainObject(tmpValue) && isPlainObject(tmpResult[tmpKey]))
		{
			tmpResult[tmpKey] = deepMerge(tmpResult[tmpKey], tmpValue);
		}
		else if (isPlainObject(tmpValue))
		{
			tmpResult[tmpKey] = deepMerge(tmpValue, {});
		}
		else if (Array.isArray(tmpValue))
		{
			tmpResult[tmpKey] = tmpValue.slice();
		}
		else if (typeof(tmpValue) !== 'undefined')
		{
			tmpResult[tmpKey] = tmpValue;
		}
	}
	return tmpResult;
};

/**
 * Resolve a (possibly partial) RetoldFaceting options object against the defaults.
 *
 * Idempotent: passing an already-resolved object returns it unchanged, so every service
 * can call resolve() on whatever it was handed.
 *
 * @param {Record<string, any>} [pOptions] - partial RetoldFaceting options
 * @return {Record<string, any>} the resolved options (a new object unless already resolved)
 */
const resolve = (pOptions) =>
{
	if (isPlainObject(pOptions) && pOptions[RESOLVED_MARKER] === true)
	{
		return pOptions;
	}
	let tmpResolved = deepMerge(DEFAULTS, isPlainObject(pOptions) ? pOptions : {});
	Object.defineProperty(tmpResolved, RESOLVED_MARKER, { value: true, enumerable: false });
	return tmpResolved;
};

/**
 * Is the scope policy configured (an object with a Column)?
 *
 * @param {Record<string, any>} pResolvedOptions
 * @return {boolean}
 */
const hasScopePolicy = (pResolvedOptions) =>
{
	let tmpScope = (pResolvedOptions && pResolvedOptions.Scope) ? pResolvedOptions.Scope : {};
	if (isPlainObject(tmpScope.Policy) && (typeof(tmpScope.Policy.Column) === 'string') && (tmpScope.Policy.Column.length > 0))
	{
		return true;
	}
	return isPlainObject(tmpScope.Required) && (Object.keys(tmpScope.Required).length > 0);
};

module.exports = (
	{
		DEFAULTS: DEFAULTS,
		LIMITS_NOT_ENFORCED: LIMITS_NOT_ENFORCED,
		ROUTE_RESERVED_NAMES: ROUTE_RESERVED_NAMES,
		NEVER_FACETABLE: NEVER_FACETABLE,
		resolve: resolve,
		deepMerge: deepMerge,
		hasScopePolicy: hasScopePolicy
	});
