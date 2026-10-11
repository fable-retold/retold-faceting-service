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

// M5 (internal-contracts §53.4): the defaults of a store section's object form (a host that sets
// Stores.ClickHouse to an object gets these under its own keys; secrets only by value or by env-var name).
const STORE_DEFAULTS = Object.freeze(
	{
		ClickHouse: Object.freeze(
			{
				URL: null,
				URLEnv: null,
				User: 'default',
				UserEnv: null,
				Password: '',
				PasswordEnv: null,
				Database: null,
				TimeoutMS: 20000,
				PingTimeoutMS: 3000,
				RetryConnectMS: 60000,
				InsertRetries: 2,
				QuerySettings: Object.freeze({}),
				SourceStringOrder: 'Auto',
				ExposeReasons: false,
				// M5 review: per-facet freshness (LagMS, AsOf, Exact), freshness refusal reasons and Describe's
				// per-entity State / LagMS — a cross-tenant write-activity signal on a multi-tenant host.
				// 'Auto' = exposed only on a host without a scope policy; Admin.authorize principals always
				// see Describe's per-entity view.
				ExposeFreshness: 'Auto',
				// A separate least-privilege credential for request-path reads (SELECT on the database only);
				// unset → the writer's.  Every request read runs with readonly = 2 either way.
				ReaderUser: null,
				ReaderUserEnv: null,
				ReaderPassword: '',
				ReaderPasswordEnv: null,
				// Request reads in flight at once (their own socket pool; beyond it a facet answers Live,
				// 'StoreBusy'); the materializer has its own pool (WriterMaxSockets).
				MaxConcurrentReads: 32,
				WriterMaxSockets: 16,
				// Per request-read limits (0 = the server's own): memory, rows read, bytes read.
				ReadLimits: Object.freeze({ MaxMemoryBytes: 4294967296, MaxRowsToRead: 0, MaxBytesToRead: 0 }),
				// A store time-out counts toward the read breaker / unreachable detection only when the
				// statement had at least this long (a client asking a tiny TimeoutMS is not a store fault).
				HealthMinTimeoutMS: 1000,
				// Network failures / time-outs within BreakerWindowMS that mark the whole store unreachable
				// (every facet answers Live at once; a background ping every UnreachablePingMS restores it).
				UnreachableAfterFailures: 2,
				UnreachablePingMS: 2000,
				// Plain http:// to a host that is not loopback sends credentials and parameter values in clear
				// text: logged as a warning unless AllowInsecure is true.  TLS: CA / Cert / Key (PEM text),
				// RejectUnauthorized (default true).
				AllowInsecure: false,
				CA: null,
				Cert: null,
				Key: null,
				RejectUnauthorized: true,
				// The database's owner marker (InstanceID + the source fingerprint): 'Check' refuses a database
				// another deployment created ('Misconfigured'); 'Adopt' takes it over (rewrites the marker).
				Owner: 'Check'
			})
	});

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
				// RAFS host only: 0 resolves the action set on every request, as RAFS's own gate does; a positive
				// value caches it per persona in this process (internal-contracts §77.3).
				EntitlementCacheMS: 0,
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
				SeqHeader: 'Auto',
				// M5 (internal-contracts §61.4): the circuit breaker per (engine, entity)
				BreakerFailures: 5,
				BreakerWindowMS: 30000,
				BreakerOpenMS: 30000
			},

		// M4 (internal-contracts §40.1): 'Auto' = the upstream MeadowChangeBus when fable has one, else
		// the interim intake (the wrapped behavior dispatcher and DAL write methods of each route-bound
		// controller); 'None' installs nothing.  NotifyManaged: true or [ 'Entity', … ] — entities whose
		// every write the host reports through notify() (else an entity no source sees is never cached).
		// RequireNotifyTenants: refuse a notify of a tenant-scoped entity that names no tenant.
		// MaxEventIDs / MaxEventOwners: beyond them an event's ids / owners become "unknown".
		ChangeCapture: { Intake: 'Auto', NotifySettleMS: 1000, NotifyManaged: [], RequireNotifyTenants: false, MaxEventIDs: 10000, MaxEventOwners: 1000 },
		// M5 (internal-contracts §53.4, §60): reconcile cadence and limits per mirrored entity.
		Reconcile:
			{
				AutoStart: true,
				// 'Auto' = 600000 with an intake and the entity not in RawWriterEntities, else 60000
				SweepIntervalMS: 'Auto',
				RawWriterEntities: [],
				MaxTxnMS: 60000,
				SweepCap: 5000,
				LeafRange: 2000,
				BisectIntervalMS: 86400000,
				HardDeleteBisectIntervalMS: 3600000,
				RebuildDivergenceRatio: 0.01,
				ScrubPeriodMS: 86400000,
				ScrubRowsPerSecond: 2000,
				ScrubTickMS: 1000,
				// Rows per tick while the entity's row count is unknown (before the first wrap / Bisect and no
				// seed from the store): a conservative pace instead of the ScrubRowsPerSecond ceiling.
				ScrubUnknownTotalRowsPerTick: 256,
				// After a clean restart that followed more downtime than this, a Bisect (inserts and hard
				// deletes made meanwhile) runs before the entity serves Exact requests.
				BootBisectAfterMS: 300000,
				// Each entity's timers start at a random phase and run with a random period of ± this share.
				JitterRatio: 0.15
			},
		// M5 (internal-contracts §53.4, §54.2): false = on-the-fly only; an object registers the store.  The
		// object form's defaults are STORE_DEFAULTS.ClickHouse (merged by RetoldFacetingStoreClickHouse.configure).
		Stores: { ClickHouse: false, Solr: false, OpenSearch: false },
		// M5 (internal-contracts §55.1): { Entity: { Store: [ 'ClickHouse' ], Columns, IncludeColumns, … } }
		Materialize: {},
		// M5 (internal-contracts §53.4, §58): 'Auto' = on when a store is registered (one process materializes, D-28).
		Materializer:
			{
				Enabled: 'Auto',
				BatchIDs: 2000,
				ReadChunkIDs: 1000,
				FlushIntervalMS: 1000,
				FlushRows: 50000,
				RebuildPageSize: 25000,
				OverflowIDs: 100000,
				MaxBackoffMS: 30000,
				DrainOnStopMS: 5000,
				IdleTickMS: 50,
				// How long a stream hint waits for company before its read cycle: 'Auto' = FlushIntervalMS
				// (about one source read, one keymap read and one insert set per interval per entity); 0 = a
				// cycle per arrival (buffered until the flush interval).
				StreamDelayMS: 'Auto',
				// Range pages that flush as soon as nothing else is runnable; Scrub / Fill pages wait for the
				// flush interval (they are background work: no prompt insert per tick).
				PromptRangeKinds: [ 'Resync', 'RebuildPage' ],
				// Backfills / rebuilds / verifies running at once across the entities of a store (the rest queue).
				MaxConcurrentBuilds: 2,
				// The state row of an entity is written at most this often for AppliedSeq / cursor-only
				// changes (lifecycle transitions, Lossy and Filling changes are written at once), in one
				// multi-row INSERT for every entity of the store.
				StateWriteIntervalMS: 5000,
				// Above this many active parts in any table of the store the flush interval is stretched
				// (×4) until merges catch up (design 04 §6.1 step 7).
				PartsBackoffAbove: 150,
				HealthCheckMS: 30000,
				// One process materializes a store: the lease row (_rfs_lease) names it.  A process that does
				// not hold an unexpired lease never writes and leaves the store unused (Reason 'NotLeader').
				Lease: { Enabled: true, TTLMS: 30000, HeartbeatMS: 10000, SettleMS: 250 }
			},
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
		// M5 (internal-contracts §60.5): the admin routes mount only with Routes: true, and every request must pass
		// authorize(pRequest, pPrincipal) === true (a host function); in-process storeAdmin() is the supported trigger.
		Admin: { RebuildCooldownMS: 600000, Routes: false, authorize: null },
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
		STORE_DEFAULTS: STORE_DEFAULTS,
		resolve: resolve,
		deepMerge: deepMerge,
		hasScopePolicy: hasScopePolicy
	});
