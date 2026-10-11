/**
 * Retold Faceting Service
 *
 * The main service (design 10 §3.2): registers every sub-service on fable, binds the host,
 * builds the catalog and loads the definitions, mounts the routes, and runs the request pipeline
 * (internal-contracts §2, §19.2): principal → shape → gate → bind → filter → plan → route/execute
 * → records → envelope, as a waterfall of named stage methods (a stage that throws is a logged
 * FACET_INTERNAL).  The Records / Count / Keys entry points (internal-contracts §28) share every
 * stage up to the filter, then plan the full-filter base (Planner.planBase) and always run Live.
 *
 * Milestone 2: Role 'Embedded' on a plain retold-data-service (HostDataService), Live engine
 * plus the Reference oracle; cross-entity folds, definitions files and named scopes.
 *
 * Milestone 4 (internal-contracts Part III): attach installs the change intake (the wrapped behavior
 * dispatcher and DAL write methods of every facetable entity's route-bound controller) and its synchronous
 * subscribers (Generations → ReadYourWrites; SSE listens to bumps); the Query pipeline gains a
 * Freshness stage, a Cache stage after Plan (the cache DepSet / DependsOn, scope probes, key,
 * GenVector, the generation Version, the 304 short-circuit, Hit / Stale serves with a single-flight
 * background refresh) and a Store stage; notify() / notifyByFilter() for raw writers; shutdown().
 *
 * Milestone 5 (internal-contracts Part IV): installStores() registers the ClickHouse store from
 * Stores.ClickHouse (feature-not-boot: a store that is down or misconfigured leaves every facet Live),
 * subscribes Freshness and the Materializer to the intake, puts the ClickHouse engine before Live in the
 * Router (per-Agg routing, same-request fallback, breaker) and starts materializing; envelopes carry
 * per-facet Engine / Exact / AsOf / LagMS and a Store block; store answers are never cached (digest
 * Version); Describe / status report the store; storeAdmin() and the guarded admin routes trigger
 * rebuilds and reconciles.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libCrypto = require('crypto');

const libOptions = require('./Retold-Faceting-Service-Options.js');
const libFacetErrors = require('./contract/Facet-Contract-Errors.js');
const libFacetRequest = require('./contract/Facet-Contract-Request.js');
const libFacetEnvelope = require('./contract/Facet-Contract-Envelope.js');
const libFacetClauses = require('./contract/Facet-Contract-Clauses.js');

const libRetoldFacetingHostDataService = require('./host/Retold-Faceting-Host-DataService.js');
const libRetoldFacetingHostApplicationServer = require('./host/Retold-Faceting-Host-ApplicationServer.js');
const libRetoldFacetingCatalog = require('./catalog/Retold-Faceting-Catalog.js');
const libRetoldFacetingGraph = require('./catalog/Retold-Faceting-Graph.js');
const libRetoldFacetingDefinitionRegistry = require('./catalog/Retold-Faceting-DefinitionRegistry.js');
const libRetoldFacetingLabelResolver = require('./catalog/Retold-Faceting-LabelResolver.js');
const libRetoldFacetingRequestNormalizer = require('./request/Retold-Faceting-RequestNormalizer.js');
const libRetoldFacetingFilterValidator = require('./request/Retold-Faceting-FilterValidator.js');
const libRetoldFacetingClauseCompiler = require('./request/Retold-Faceting-ClauseCompiler.js');
const libRetoldFacetingFilterAST = require('./request/Retold-Faceting-FilterAST.js');
const libRetoldFacetingDisjunctivePlanner = require('./request/Retold-Faceting-DisjunctivePlanner.js');
const libRetoldFacetingPlanner = require('./plan/Retold-Faceting-Planner.js');
const libRetoldFacetingFoldIR = require('./plan/Retold-Faceting-FoldIR.js');
const libRetoldFacetingBinder = require('./plan/Retold-Faceting-Binder.js');
const libRetoldFacetingPrincipalResolver = require('./security/Retold-Faceting-PrincipalResolver.js');
const libRetoldFacetingScopeCapture = require('./security/Retold-Faceting-ScopeCapture.js');
const libRetoldFacetingScopeGuard = require('./security/Retold-Faceting-ScopeGuard.js');
const libRetoldFacetingAuthorizer = require('./security/Retold-Faceting-Authorizer.js');
const libRetoldFacetingRouter = require('./engine/Retold-Faceting-Router.js');
const libRetoldFacetingEngineLive = require('./engine/Retold-Faceting-EngineLive.js');
const libRetoldFacetingEngineReference = require('./engine/Retold-Faceting-EngineReference.js');
const libRetoldFacetingScopedRelationBuilder = require('./engine/live/Retold-Faceting-ScopedRelationBuilder.js');
const libRetoldFacetingDialects = require('./engine/live/Retold-Faceting-Dialects.js');
const libRetoldFacetingShellTemplates = require('./engine/live/Retold-Faceting-ShellTemplates.js');
const libRetoldFacetingPredicateCompiler = require('./engine/live/Retold-Faceting-PredicateCompiler.js');
const libRetoldFacetingStagedKeys = require('./engine/live/Retold-Faceting-StagedKeys.js');
const libRetoldFacetingCubeExecutor = require('./engine/live/Retold-Faceting-CubeExecutor.js');
const libRetoldFacetingRoutes = require('./routes/Retold-Faceting-Routes.js');
// M4 (internal-contracts §38.3): skeletons registered; the wiring connects them into the pipeline.
const libRetoldFacetingCacheKey = require('./security/Retold-Faceting-CacheKey.js');
const libRetoldFacetingGenerations = require('./cache/Retold-Faceting-Generations.js');
const libRetoldFacetingResultCache = require('./cache/Retold-Faceting-ResultCache.js');
const libRetoldFacetingChangeIntake = require('./change/Retold-Faceting-ChangeIntake.js');
const libRetoldFacetingReadYourWrites = require('./change/Retold-Faceting-ReadYourWrites.js');
const libRetoldFacetingSSE = require('./routes/Retold-Faceting-SSE.js');
// M5 (internal-contracts §53.3): skeletons registered (inert until installStores(), §54.2); the wiring
// connects them into the pipeline (Router, envelope, Describe, shutdown).
const libRetoldFacetingMirrorSpec = require('./persistence/Retold-Faceting-MirrorSpec.js');
const libRetoldFacetingFreshness = require('./persistence/Retold-Faceting-Freshness.js');
const libRetoldFacetingMaterializeSourceInProcess = require('./persistence/MaterializeSource-InProcess.js');
const libRetoldFacetingStoreClickHouse = require('./store/clickhouse/Retold-Faceting-StoreClickHouse.js');
const libRetoldFacetingMaterializer = require('./persistence/Retold-Faceting-Materializer.js');
const libRetoldFacetingRebuilder = require('./persistence/Retold-Faceting-Rebuilder.js');
const libRetoldFacetingReconciler = require('./persistence/Retold-Faceting-Reconciler.js');
const libRetoldFacetingEngineClickHouse = require('./engine/Retold-Faceting-EngineClickHouse.js');
const libRetoldFacetingUtil = require('./Retold-Faceting-Util.js');

// Every sub-service, in registration order: [ serviceType, class ].
const SUB_SERVICES = (
	[
		[ 'RetoldFacetingHostDataService', libRetoldFacetingHostDataService ],
		// Part V (internal-contracts §71–§79): the RAFS host (attach selects it from { ApplicationServer, Phase })
		[ 'RetoldFacetingHostApplicationServer', libRetoldFacetingHostApplicationServer ],
		[ 'RetoldFacetingGraph', libRetoldFacetingGraph ],
		[ 'RetoldFacetingCatalog', libRetoldFacetingCatalog ],
		[ 'RetoldFacetingDefinitionRegistry', libRetoldFacetingDefinitionRegistry ],
		[ 'RetoldFacetingRequestNormalizer', libRetoldFacetingRequestNormalizer ],
		[ 'RetoldFacetingFilterValidator', libRetoldFacetingFilterValidator ],
		[ 'RetoldFacetingClauseCompiler', libRetoldFacetingClauseCompiler ],
		[ 'RetoldFacetingFilterAST', libRetoldFacetingFilterAST ],
		[ 'RetoldFacetingDisjunctivePlanner', libRetoldFacetingDisjunctivePlanner ],
		[ 'RetoldFacetingFoldIR', libRetoldFacetingFoldIR ],
		[ 'RetoldFacetingBinder', libRetoldFacetingBinder ],
		[ 'RetoldFacetingPlanner', libRetoldFacetingPlanner ],
		[ 'RetoldFacetingPrincipalResolver', libRetoldFacetingPrincipalResolver ],
		[ 'RetoldFacetingScopeGuard', libRetoldFacetingScopeGuard ],
		[ 'RetoldFacetingScopeCapture', libRetoldFacetingScopeCapture ],
		[ 'RetoldFacetingAuthorizer', libRetoldFacetingAuthorizer ],
		[ 'RetoldFacetingDialects', libRetoldFacetingDialects ],
		[ 'RetoldFacetingShellTemplates', libRetoldFacetingShellTemplates ],
		[ 'RetoldFacetingScopedRelationBuilder', libRetoldFacetingScopedRelationBuilder ],
		[ 'RetoldFacetingPredicateCompiler', libRetoldFacetingPredicateCompiler ],
		[ 'RetoldFacetingStagedKeys', libRetoldFacetingStagedKeys ],
		[ 'RetoldFacetingCubeExecutor', libRetoldFacetingCubeExecutor ],
		[ 'RetoldFacetingEngineLive', libRetoldFacetingEngineLive ],
		[ 'RetoldFacetingEngineReference', libRetoldFacetingEngineReference ],
		[ 'RetoldFacetingLabelResolver', libRetoldFacetingLabelResolver ],
		[ 'RetoldFacetingCacheKey', libRetoldFacetingCacheKey ],
		[ 'RetoldFacetingGenerations', libRetoldFacetingGenerations ],
		[ 'RetoldFacetingResultCache', libRetoldFacetingResultCache ],
		[ 'RetoldFacetingChangeIntake', libRetoldFacetingChangeIntake ],
		[ 'RetoldFacetingReadYourWrites', libRetoldFacetingReadYourWrites ],
		// M5 (internal-contracts §53.3)
		[ 'RetoldFacetingMirrorSpec', libRetoldFacetingMirrorSpec ],
		[ 'RetoldFacetingFreshness', libRetoldFacetingFreshness ],
		[ 'RetoldFacetingMaterializeSourceInProcess', libRetoldFacetingMaterializeSourceInProcess ],
		[ 'RetoldFacetingStoreClickHouse', libRetoldFacetingStoreClickHouse ],
		[ 'RetoldFacetingMaterializer', libRetoldFacetingMaterializer ],
		[ 'RetoldFacetingRebuilder', libRetoldFacetingRebuilder ],
		[ 'RetoldFacetingReconciler', libRetoldFacetingReconciler ],
		[ 'RetoldFacetingEngineClickHouse', libRetoldFacetingEngineClickHouse ],
		[ 'RetoldFacetingRouter', libRetoldFacetingRouter ],
		[ 'RetoldFacetingRoutes', libRetoldFacetingRoutes ],
		[ 'RetoldFacetingSSE', libRetoldFacetingSSE ]
	]);

// The Agg Key of the envelope Total (internal-contracts §5.1); the Planner owns it.
const TOTAL_KEY = libRetoldFacetingPlanner.TOTAL_KEY;

// The store refusal reason classes that reflect its (global) freshness: shown to a client as the neutral
// 'Freshness' unless Stores.ClickHouse.ExposeFreshness.
const FRESHNESS_REASON_CLASSES = Object.freeze([ 'State', 'Unverified', 'NotExact', 'Lagging', 'NoChangeSource', 'Breaker' ]);

// M4 (internal-contracts §44.10): the marker on a service server whose close() runs the faceting
// shutdown first (wrapped once per server object).
const SHUTDOWN_MARKER = Symbol.for('RetoldFaceting.Shutdown');

// M4 (internal-contracts §44.3): the Cache stage statuses a client may see in X-Retold-Facet-Cache
// ('Refresh' is the background refresh's own status; its answer is stored, never sent).
const CACHE_STATUSES = Object.freeze([ 'Off', 'Bypass', 'Miss', 'Hit', 'Stale', 'NotModified', 'Refresh' ]);

// Post-execution Bypass reasons a single-flight joiner never inherits (it computes its own answer).
// M5: 'Store' — an answer a store gave under the leader's freshness admission (a joiner may ask Exact).
const UNSHARED_REASONS = Object.freeze([ 'Errors', 'ScopeChanged', 'Store' ]);

// M5 (internal-contracts §60.5): storeAdmin actions, and the admin route's reconcile levels.
const ADMIN_ACTIONS = Object.freeze([ 'Rebuild', 'Sweep', 'Bisect', 'Scrub', 'Verify' ]);
const ADMIN_LEVELS = Object.freeze([ 'Sweep', 'Bisect', 'Scrub', 'Verify' ]);

// M5 (internal-contracts §54.2): the store names this milestone can register (one engine each).
const STORE_ENGINES = Object.freeze({ ClickHouse: 'RetoldFacetingEngineClickHouse' });

// The If-None-Match request header (read once into pContext.IfNoneMatch) and the MinSeq header (02 §10).
const IF_NONE_MATCH_HEADER = 'if-none-match';
const MIN_SEQ_HEADER = 'x-retold-facet-minseq';

class RetoldFacetingService extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (partial or resolved)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingService';

		// The active host adapter (set by attach)
		this.Host = null;
		this._ServicesRegistered = false;
		this._Attached = false;
		// Part V (internal-contracts §73.3): a RAFS hook-phase attach serves in-process queries before the
		// route phase mounts the facet routes; true once Routes.connect ran (the RDS attach does both at once).
		this._RoutesConnected = false;
		this._RequestCounter = 0;
		// M5 (internal-contracts §54.2): what installStores() did ({ Configured, Available, Reason }).
		this._StoreInstall = { Configured: false, Available: false, Reason: null };
		// M5: Materialize 'All' (tests, the demo): re-declared from the catalog at every install.
		this._MaterializeAll = false;
		// M5: storeAdmin calls in flight ('<Store>:<Entity>:<Action>').
		this._AdminInFlight = new Set();
	}

	/**
	 * Register every sub-service on fable (idempotent).  Each receives the resolved options.
	 *
	 * @return {RetoldFacetingService}
	 */
	registerServices()
	{
		if (this._ServicesRegistered)
		{
			return this;
		}
		for (let i = 0; i < SUB_SERVICES.length; i++)
		{
			let tmpServiceType = SUB_SERVICES[i][0];
			if (!this.fable.servicesMap || !libRetoldFacetingUtil.hasOwn(this.fable.servicesMap, tmpServiceType))
			{
				this.fable.addServiceType(tmpServiceType, SUB_SERVICES[i][1]);
			}
			this.fable.instantiateServiceProvider(tmpServiceType, this.options);
		}
		this.fable.RetoldFacetingRouter.register(this.fable.RetoldFacetingEngineLive);
		this.fable.RetoldFacetingRouter.register(this.fable.RetoldFacetingEngineReference);
		this._ServicesRegistered = true;
		return this;
	}

	/**
	 * Attach to a host (design 07 §2.2 / §3): register services, bind the host, refuse reserved entity
	 * names, build the catalog, mount the routes.
	 *
	 *   { RetoldDataService }                       the plain retold-data-service host, one phase
	 *   { ApplicationServer: pServer, Phase }       the RAFS host (internal-contracts §73.3–§73.4):
	 *       Phase 'Hook'    everything except the routes (in-process queries work; nothing is served)
	 *       Phase 'Routes'  the hook phase first when it did not run, then Host.captureLateMounts(),
	 *                       the facet routes and the shutdown hook (the default when Phase is omitted)
	 *
	 * Options.Host ('Auto' | 'DataService' | 'ApplicationServer') must agree with the attach key.
	 *
	 * @param {{ RetoldDataService?: any, ApplicationServer?: any, Phase?: string }} pAttachOptions
	 * @param {(pError?: Error) => void} fCallback
	 */
	attach(pAttachOptions, fCallback)
	{
		let tmpAttachOptions = libRetoldFacetingUtil.isPlainObject(pAttachOptions) ? pAttachOptions : {};
		if (tmpAttachOptions.ApplicationServer)
		{
			if (tmpAttachOptions.RetoldDataService)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'attach takes one host: a RetoldDataService or an ApplicationServer, not both.'));
			}
			return this.attachApplicationServer(tmpAttachOptions.ApplicationServer, tmpAttachOptions.Phase, fCallback);
		}
		if (this._Attached)
		{
			return fCallback();
		}
		let tmpHostRefusal = this.hostKindRefusal('DataService');
		if (tmpHostRefusal)
		{
			return fCallback(tmpHostRefusal);
		}
		this.registerServices();
		this.Host = this.fable.RetoldFacetingHostDataService;
		let tmpRetoldDataService = tmpAttachOptions.RetoldDataService ? tmpAttachOptions.RetoldDataService : this.fable.RetoldDataService;

		this.Host.bind(tmpRetoldDataService,
			(pBindError) =>
			{
				if (pBindError)
				{
					return fCallback(pBindError);
				}
				return this.attachBoundHost(
					(pAttachError) =>
					{
						if (pAttachError)
						{
							return fCallback(pAttachError);
						}
						this.fable.RetoldFacetingRoutes.connect(this.Host.getServiceServer());
						this.installShutdownHook();
						this._RoutesConnected = true;
						this._Attached = true;
						return fCallback();
					});
			});
	}

	/**
	 * Does Options.Host allow this host kind (internal-contracts §71.2)?  A FacetError when it does not.
	 *
	 * @param {string} pKind - 'DataService' | 'ApplicationServer'
	 * @return {Error|null}
	 */
	hostKindRefusal(pKind)
	{
		let tmpOption = (typeof(this.options.Host) === 'string') ? this.options.Host : 'Auto';
		if ((tmpOption === 'Auto') || (tmpOption === pKind))
		{
			return null;
		}
		if ((tmpOption !== 'DataService') && (tmpOption !== 'ApplicationServer'))
		{
			return libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting Options.Host must be 'Auto', 'DataService' or 'ApplicationServer' (got ${libRetoldFacetingUtil.logSafe(tmpOption)}).`);
		}
		return libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting Options.Host is '${tmpOption}' but it is being attached to a ${pKind} host.`);
	}

	/**
	 * The attach steps after a host bound (shared by both hosts): D-17, the unenforced-limit warning,
	 * the shell-template check, the catalog, change capture, the stores and the model-change listener.
	 * Mounts no routes.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	attachBoundHost(fCallback)
	{
		// D-17: an entity named like a facet route segment would shadow the routes (the one check).
		let tmpReserved = this.Host.reservedEntityNames();
		if (tmpReserved.length > 0)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `Faceting refuses to mount: entity name(s) [${tmpReserved.join(', ')}] collide with facet routes (D-17).`));
		}
		let tmpUnenforced = libOptions.LIMITS_NOT_ENFORCED.filter((pLimit) => { return libRetoldFacetingUtil.hasOwn(this.options.Limits, pLimit); });
		if (tmpUnenforced.length > 0)
		{
			this.fable.log.warn(`RetoldFaceting: Limits [${tmpUnenforced.join(', ')}] are configured but not enforced in this milestone.`);
		}
		// Boot check (O9): every shell template passes the tag scan and dry-builds on every dialect.
		let tmpShellCheck = this.fable.RetoldFacetingShellTemplates.validateAll();
		if (tmpShellCheck.Errors.length > 0)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `Faceting shell templates failed validation: ${tmpShellCheck.Errors.map((pError) => { return `${pError.Dialect}.${pError.Template} ${pError.Tag}`; }).join('; ')}`));
		}
		try
		{
			this.rebuildCatalog(this.Host.getModelSync());
		}
		catch (pCatalogError)
		{
			return fCallback(pCatalogError);
		}
		// M4 (internal-contracts §44.10): the change intake on every facetable entity's route-bound
		// controller, then the subscriptions (Generations, ReadYourWrites, the host's own, SSE).
		this.installChangeCapture();
		// M5 (internal-contracts §54.2): the stores (never fails attach: a store that is down or
		// misconfigured is logged and retried while Live answers).
		this.installStores();
		// D-31: a host model reload rebuilds the graph, the catalog and the definitions (same sources;
		// the previous catalog stays on failure); M4: the intake then wraps the new controllers, every
		// cached answer goes (its ModelVersion changed) and open change streams are told.  On RAFS the
		// only "reload" is the route phase capturing late mounts (internal-contracts §73.4).
		this.Host.onModelChanged(
			(pModel) =>
			{
				try
				{
					this.rebuildCatalog(pModel, true);
				}
				catch (pRebuildError)
				{
					this.fable.log.error(`RetoldFaceting: the catalog rebuild after a model reload failed; keeping the previous catalog: ${pRebuildError.message}`);
					return;
				}
				this.afterModelReload();
			});
		return fCallback();
	}

	/**
	 * Attach to a retold-application-foundation-server (internal-contracts §73.3–§73.4).  Idempotent per
	 * phase; a service attached to another host (or another server) refuses.
	 *
	 * @param {any} pServer - the RetoldApplicationServer
	 * @param {string} [pPhase] - 'Hook' | 'Routes' (default 'Routes': both phases at once)
	 * @param {(pError?: Error) => void} fCallback
	 */
	attachApplicationServer(pServer, pPhase, fCallback)
	{
		let tmpPhase = (typeof(pPhase) === 'undefined') ? 'Routes' : pPhase;
		if ((tmpPhase !== 'Hook') && (tmpPhase !== 'Routes'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `attach({ ApplicationServer, Phase }) takes Phase 'Hook' or 'Routes' (got ${libRetoldFacetingUtil.logSafe(String(tmpPhase))}).`));
		}
		let tmpHostRefusal = this.hostKindRefusal('ApplicationServer');
		if (tmpHostRefusal)
		{
			return fCallback(tmpHostRefusal);
		}
		if (this._Attached)
		{
			let tmpSameHost = !!this.Host && (this.Host === this.fable.RetoldFacetingHostApplicationServer)
				&& (typeof(this.Host.getApplicationServer) === 'function') && (this.Host.getApplicationServer() === pServer);
			if (!tmpSameHost)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service on this fable is already attached to a different host.'));
			}
			if (tmpPhase === 'Hook')
			{
				return fCallback();
			}
			return this.connectApplicationServerRoutes(fCallback);
		}
		if (tmpPhase === 'Routes')
		{
			this.fable.log.info('RetoldFaceting: the hook phase did not run (foundationHookInstaller missing from hookInstallers()); running it now from the route phase, so endpoints mounted after tenancy are classified Unguarded.');
		}
		this.registerServices();
		this.Host = this.fable.RetoldFacetingHostApplicationServer;
		this.Host.setCapturePhase(tmpPhase);
		this.Host.bind(pServer,
			(pBindError) =>
			{
				if (pBindError)
				{
					this.Host = null;
					return fCallback(pBindError);
				}
				return this.attachBoundHost(
					(pAttachError) =>
					{
						if (pAttachError)
						{
							return fCallback(pAttachError);
						}
						this._Attached = true;
						this._RoutesConnected = false;
						// From the hook phase on (internal-contracts §73.3): the stores and timers started here
						// stop with fable.Orator.stopService even when the route phase never runs (in-process
						// use only, a forgotten route installer, a boot that fails after this step).
						this.installShutdownHook();
						if (tmpPhase === 'Hook')
						{
							this.fable.log.info('RetoldFaceting: hook phase done (in-process queries work); the facet routes mount only when foundationRouteInstaller runs from routeInstallers().');
							return fCallback();
						}
						return this.connectApplicationServerRoutes(fCallback);
					});
			});
	}

	/**
	 * The RAFS route phase after the hook phase (internal-contracts §73.4 steps 2–3): capture late mounts
	 * (the catalog, the intake and the cache follow through onModelChanged), mount the facet routes on
	 * fable.Orator.serviceServer and wrap its close() (so fable.Orator.stopService runs shutdown() first).
	 * Idempotent.
	 *
	 * @param {(pError?: Error) => void} fCallback
	 */
	connectApplicationServerRoutes(fCallback)
	{
		if (this._RoutesConnected)
		{
			return fCallback();
		}
		this.Host.captureLateMounts();
		// A check that needs the final coverage failed (header sessions on a late controller, a
		// PersonalScopes conflict on a newly guarded entity): the boot fails, the host already serves nothing.
		let tmpRouteRefusal = (typeof(this.Host.routePhaseRefusal) === 'function') ? this.Host.routePhaseRefusal() : null;
		if (tmpRouteRefusal)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting cannot mount its routes on this RetoldApplicationServer: ${tmpRouteRefusal}`));
		}
		let tmpServiceServer = this.Host.getServiceServer();
		if (!tmpServiceServer || (typeof(tmpServiceServer.post) !== 'function') || (typeof(tmpServiceServer.get) !== 'function'))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The RetoldApplicationServer has no Orator service server to mount the facet routes on.'));
		}
		this.fable.RetoldFacetingRoutes.connect(tmpServiceServer);
		this.installShutdownHook();
		this._RoutesConnected = true;
		return fCallback();
	}

	/**
	 * Rebuild the graph, then the catalog, then (re)load the definitions against them, then refresh
	 * ModelVersion so it covers the definitions (internal-contracts §20.1 boot order).  At attach the
	 * definitions come from Options.Definitions; a model reload re-reads the same sources.  Invalid
	 * definitions are disabled (and logged by the registry), never partially loaded; a load that
	 * throws keeps the previous registry.
	 *
	 * @param {Record<string, any>} pModel
	 * @param {boolean} [pReload] - true on a host model reload
	 * @return {Record<string, any>|null} the registry load result (null without a registry)
	 */
	rebuildCatalog(pModel, pReload)
	{
		this.fable.RetoldFacetingGraph.rebuild(pModel);
		this.fable.RetoldFacetingCatalog.rebuild(pModel, this.Host);
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		let tmpLoad = null;
		if (tmpRegistry && (typeof(tmpRegistry.load) === 'function'))
		{
			tmpLoad = (pReload === true) ? tmpRegistry.load() : tmpRegistry.load(this.options.Definitions);
			if (tmpLoad && ((tmpLoad.Loaded.Facets + tmpLoad.Loaded.Scopes + tmpLoad.Loaded.Aliases + tmpLoad.Disabled.length) > 0))
			{
				this.fable.log.info(`RetoldFaceting definitions: ${tmpLoad.Loaded.Facets} facet(s), ${tmpLoad.Loaded.Scopes} scope(s), ${tmpLoad.Loaded.Aliases} alias(es) loaded; ${tmpLoad.Disabled.length} disabled (${tmpLoad.DefinitionsHash}).`);
			}
		}
		if (typeof(this.fable.RetoldFacetingCatalog.refreshModelVersion) === 'function')
		{
			this.fable.RetoldFacetingCatalog.refreshModelVersion();
		}
		return tmpLoad;
	}

	/**
	 * Mount the routes on a service server.  attach() does this itself; this is public API for a
	 * host that builds its own service server and mounts the facet routes on it (idempotent).
	 *
	 * @param {any} pServiceServer
	 * @return {boolean}
	 */
	connectRoutes(pServiceServer)
	{
		this.registerServices();
		return this.fable.RetoldFacetingRoutes.connect(pServiceServer);
	}

	// ------------------------------------------------------------ M4: change capture, lifecycle (internal-contracts §44.10)

	/**
	 * Install the change intake (idempotent: wraps only controllers it has not wrapped) and the
	 * synchronous subscriptions, in order: the intake delivers each ChangeEvent to Generations first
	 * (so a write's bump is in place before anything else looks), then ReadYourWrites; SSE listens to
	 * Generations bumps.  Subscriptions replace by name, so a re-install never doubles a listener.
	 * Never throws (a failure is logged: writes keep working, generations just stop moving).
	 *
	 * @return {{ Source: string, Entities: Array<string> }|null} the intake's install result
	 */
	installChangeCapture()
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		let tmpReadYourWrites = this.fable.RetoldFacetingReadYourWrites;
		let tmpSSE = this.fable.RetoldFacetingSSE;
		if (!tmpIntake || !tmpGenerations)
		{
			return null;
		}
		let tmpResult = null;
		try
		{
			tmpResult = tmpIntake.install();
		}
		catch (pInstallError)
		{
			this.fable.log.error(`RetoldFaceting: the change intake could not be installed: ${pInstallError.message}`);
		}
		tmpIntake.subscribe('Generations', (pEvent) => { tmpGenerations.applyChange(pEvent); });
		if (tmpReadYourWrites)
		{
			tmpIntake.subscribe('ReadYourWrites', (pEvent) => { tmpReadYourWrites.onChange(pEvent); });
		}
		// Part V (internal-contracts §71.2, §79.3): the host's own subscribers, after the two above (the
		// RAFS host drops cached entitlement sets on role-table writes; the DataService host has none).
		if (this.Host && (typeof(this.Host.installChangeIntake) === 'function'))
		{
			try
			{
				this.Host.installChangeIntake(tmpIntake);
			}
			catch (pHostIntakeError)
			{
				this.fable.log.error(`RetoldFaceting: the host change-intake hook failed: ${pHostIntakeError.message}`);
			}
		}
		if (tmpSSE)
		{
			tmpGenerations.subscribe('SSE', (pBump) => { tmpSSE.onBump(pBump); });
		}
		if (tmpResult && (tmpResult.Source === 'None') && this.cacheEnabled())
		{
			this.fable.log.warn('RetoldFaceting: Cache.Enabled is on but no change source is installed (ChangeCapture.Intake); only notify() moves generations, so every write must call it.');
		}
		return tmpResult;
	}

	/**
	 * After a successful model reload (catalog rebuilt): the intake wraps the new controllers, the
	 * result cache is cleared (every key carries the old ModelVersion) and open streams get 'model'.
	 */
	afterModelReload()
	{
		this.installChangeCapture();
		// M5 (internal-contracts §54.2 step 5): re-install the stores (idempotent), then recompile the
		// mirror specs (additive ALTER or a rebuild per entity, §55.4).
		this.installStores();
		if (this.fable.RetoldFacetingMaterializer && this._StoreInstall.Configured)
		{
			try
			{
				this.fable.RetoldFacetingMaterializer.reload();
			}
			catch (pReloadError)
			{
				this.fable.log.error(`RetoldFaceting: the materializer reload failed: ${pReloadError.message}`);
			}
		}
		if (this.fable.RetoldFacetingResultCache)
		{
			this.fable.RetoldFacetingResultCache.clear();
		}
		if (this.fable.RetoldFacetingSSE)
		{
			try
			{
				this.fable.RetoldFacetingSSE.broadcastModelChanged();
			}
			catch (pBroadcastError)
			{
				this.fable.log.warn(`RetoldFaceting: the model-changed broadcast failed: ${pBroadcastError.message}`);
			}
		}
	}

	/**
	 * Wrap the host service server's close() once (internal-contracts §44.10), so fable.Orator's
	 * stopWebServer (which closes fable.Orator.serviceServer, normally the same object as
	 * Host.getServiceServer()) runs shutdown() first: open change streams end (they would otherwise
	 * hold the server's close() until their sockets time out) and no M4 timer survives.
	 *
	 * @return {boolean} true when the hook is (already) installed
	 */
	installShutdownHook()
	{
		let tmpServer = (this.fable.Orator && this.fable.Orator.serviceServer) ? this.fable.Orator.serviceServer
			: (this.Host ? this.Host.getServiceServer() : null);
		if (!tmpServer || (typeof(tmpServer.close) !== 'function'))
		{
			return false;
		}
		if (tmpServer[SHUTDOWN_MARKER])
		{
			return true;
		}
		let fClose = tmpServer.close;
		let tmpService = this;
		Object.defineProperty(tmpServer, SHUTDOWN_MARKER, { value: true, enumerable: false, configurable: true });
		tmpServer.close = function (...pArguments)
		{
			let tmpServerThis = this;
			tmpService.shutdown(() => { return fClose.apply(tmpServerThis, pArguments); });
		};
		return true;
	}

	/**
	 * Stop every M4 / M5 activity (internal-contracts §44.10, §54.2 step 6): first the materializer
	 * (drain ≤ Materializer.DrainOnStopMS, final flush, clean-shutdown flags; its entities go Absent so
	 * nothing is served from mirrors no longer maintained), then end open change streams (closed {
	 * Reason: 'Shutdown' }), clear the notify settle timers and the cache's in-flight bookkeeping, and
	 * drop the ClickHouse client's keep-alive sockets.  The intake wrappers stay (harmless).  Idempotent;
	 * never throws.
	 *
	 * @param {() => void} [fCallback]
	 */
	shutdown(fCallback)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		let fAfterStores = () =>
		{
			this.shutdownM4();
			if (this.fable.RetoldFacetingStoreClickHouse && (typeof(this.fable.RetoldFacetingStoreClickHouse.close) === 'function'))
			{
				try
				{
					this.fable.RetoldFacetingStoreClickHouse.close();
				}
				catch (pCloseError)
				{
					this.fable.log.warn(`RetoldFaceting shutdown: the ClickHouse client failed to close: ${pCloseError.message}`);
				}
			}
			if (typeof(fCallback) === 'function')
			{
				return fCallback();
			}
		};
		if (!tmpMaterializer || (typeof(tmpMaterializer.started) !== 'function') || !tmpMaterializer.started())
		{
			return fAfterStores();
		}
		let tmpCalledBack = false;
		try
		{
			tmpMaterializer.stop(
				() =>
				{
					if (!tmpCalledBack)
					{
						tmpCalledBack = true;
						return fAfterStores();
					}
				});
		}
		catch (pStopError)
		{
			this.fable.log.warn(`RetoldFaceting shutdown: the materializer failed to stop: ${pStopError.message}`);
			if (!tmpCalledBack)
			{
				tmpCalledBack = true;
				return fAfterStores();
			}
		}
	}

	/**
	 * The M4 shutdown steps (SSE streams, intake timers, the result cache).  Never throws.
	 */
	shutdownM4()
	{
		let fStep = (pName, fStop) =>
		{
			try
			{
				fStop();
			}
			catch (pStopError)
			{
				this.fable.log.warn(`RetoldFaceting shutdown: ${pName} failed: ${pStopError.message}`);
			}
		};
		if (this.fable.RetoldFacetingSSE)
		{
			fStep('SSE', () => { this.fable.RetoldFacetingSSE.closeAll('Shutdown'); });
		}
		if (this.fable.RetoldFacetingChangeIntake)
		{
			fStep('ChangeIntake', () => { this.fable.RetoldFacetingChangeIntake.shutdown(); });
		}
		if (this.fable.RetoldFacetingResultCache)
		{
			fStep('ResultCache', () => { this.fable.RetoldFacetingResultCache.shutdown(); });
		}
	}

	// ------------------------------------------------------------ M5: stores (internal-contracts §54.2, §60.5)

	/**
	 * Register the stores from the options (internal-contracts §54.2; public, idempotent, also after
	 * every model reload).  Stores.ClickHouse an object → StoreClickHouse.configure (never throws: a
	 * missing URL or a bad database name is 'Misconfigured', logged without secrets), the intake
	 * subscribers 'Freshness' then 'Materializer' (after the M4 two), the ClickHouse engine registered
	 * with the Router BEFORE Live, then Materializer.start — which never fails attach: a store that is
	 * down is retried every RetryConnectMS (unref'd) while every facet answers Live.  Materializer.Enabled
	 * false → the store is not used (Reason 'NoMaterializer').  Materialize 'All' declares every facetable
	 * entity (tests and the demo).
	 *
	 * @param {(pError?: Error) => void} [fCallback] - called when Materializer.start called back (never an error)
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	installStores(fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		this.registerServices();
		let tmpSection = (this.options.Stores && libRetoldFacetingUtil.isPlainObject(this.options.Stores.ClickHouse)) ? this.options.Stores.ClickHouse : null;
		let tmpRouter = this.fable.RetoldFacetingRouter;
		let tmpEngine = this.fable[STORE_ENGINES.ClickHouse];
		if (!tmpSection)
		{
			if (tmpRouter && tmpEngine && (typeof(tmpRouter.unregister) === 'function'))
			{
				tmpRouter.unregister(tmpEngine);
			}
			this._StoreInstall = { Configured: false, Available: false, Reason: null };
			fDone();
			return Object.assign({}, this._StoreInstall);
		}
		if (this.options.Materializer && (this.options.Materializer.Enabled === false))
		{
			// A reader-only process (polling the state rows) is a seam (§70): without a materializer
			// nothing proves a mirror current, so the store is not used.
			if (this._StoreInstall.Reason !== 'NoMaterializer')
			{
				this.fable.log.info('RetoldFaceting: Stores.ClickHouse is configured but Materializer.Enabled is false; the store is not used (every facet answers Live).');
			}
			this._StoreInstall = { Configured: true, Available: false, Reason: 'NoMaterializer' };
			fDone();
			return Object.assign({}, this._StoreInstall);
		}
		// Materialize 'All': every facetable entity of the catalog (re-declared after a model reload).
		if ((this.options.Materialize === 'All') || this._MaterializeAll)
		{
			this._MaterializeAll = true;
			let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
			this.options.Materialize = (tmpMirrorSpec && (typeof(tmpMirrorSpec.declareAll) === 'function'))
				? tmpMirrorSpec.declareAll([ 'ClickHouse' ], { Catalog: this.fable.RetoldFacetingCatalog, Host: this.Host, Registry: this.fable.RetoldFacetingDefinitionRegistry, Options: this.options })
				: {};
		}
		let tmpStore = this.fable.RetoldFacetingStoreClickHouse;
		let tmpConfigured = { Configured: false, Available: false, Reason: 'NoStore' };
		try
		{
			tmpConfigured = tmpStore.configure(tmpSection);
		}
		catch (pConfigureError)
		{
			// configure never throws by contract; a bug here must still not fail attach.
			this.fable.log.error(`RetoldFaceting: the ClickHouse store could not be configured: ${pConfigureError.message}`);
			tmpConfigured = { Configured: true, Available: false, Reason: 'Misconfigured' };
		}
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpFreshness = this.fable.RetoldFacetingFreshness;
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (tmpIntake && tmpFreshness && tmpMaterializer)
		{
			// After the M4 two ('Generations', 'ReadYourWrites'): a write is never judged applied before it is observed.
			tmpIntake.subscribe('Freshness', (pEvent) => { tmpFreshness.observe(pEvent); });
			tmpIntake.subscribe('Materializer', (pEvent) => { tmpMaterializer.onChange(pEvent); });
		}
		if (tmpRouter && tmpEngine)
		{
			tmpRouter.register(tmpEngine, { Store: true });
		}
		this._StoreInstall = { Configured: true, Available: false, Reason: tmpConfigured.Reason || null };
		if (!tmpMaterializer || (typeof(tmpMaterializer.start) !== 'function'))
		{
			fDone();
			return Object.assign({}, this._StoreInstall);
		}
		try
		{
			tmpMaterializer.start(
				() =>
				{
					return fDone();
				});
		}
		catch (pStartError)
		{
			this.fable.log.error(`RetoldFaceting: the materializer failed to start (facets answer Live): ${pStartError.message}`);
			fDone();
		}
		return Object.assign({}, this._StoreInstall);
	}

	/**
	 * Is a store engine registered (a Query gets a Store block and per-Agg routing)?
	 *
	 * @return {boolean}
	 */
	storeRegistered()
	{
		return !!(this._StoreInstall && this._StoreInstall.Configured && (this._StoreInstall.Reason !== 'NoMaterializer'));
	}

	/**
	 * The store's availability for Describe / the envelope: { Configured, Available, Reason }.
	 *
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	storeAvailability()
	{
		let tmpInstall = this._StoreInstall || { Configured: false };
		if (!tmpInstall.Configured)
		{
			return { Configured: false, Available: false, Reason: null };
		}
		if (tmpInstall.Reason === 'NoMaterializer')
		{
			return { Configured: true, Available: false, Reason: 'NoMaterializer' };
		}
		let tmpEngine = this.fable[STORE_ENGINES.ClickHouse];
		let tmpReady = (tmpEngine && (typeof(tmpEngine.storeReady) === 'function')) ? tmpEngine.storeReady() : { Ready: false, Reason: 'StoreUnavailable' };
		if (tmpReady.Ready)
		{
			return { Configured: true, Available: true, Reason: null };
		}
		let tmpStatus = this.fable.RetoldFacetingStoreClickHouse ? this.fable.RetoldFacetingStoreClickHouse.status() : null;
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		let tmpMaterialized = (tmpMaterializer && (typeof(tmpMaterializer.status) === 'function')) ? tmpMaterializer.status() : null;
		let tmpStoreState = (tmpMaterialized && tmpMaterialized.Stores && tmpMaterialized.Stores.ClickHouse) ? tmpMaterialized.Stores.ClickHouse : null;
		let tmpReason = (tmpStatus && !tmpStatus.Available && tmpStatus.Reason) ? tmpStatus.Reason
			: ((tmpStoreState && tmpStoreState.Reason) ? tmpStoreState.Reason : (tmpReady.Reason || 'StoreUnavailable'));
		return { Configured: true, Available: false, Reason: tmpReason };
	}

	/**
	 * Why storeAdmin() refuses an action now (internal-contracts §60.5), or null: unknown action / Level
	 * → 400; unknown store or an entity it does not materialize → 404 FACET_UNKNOWN_ENTITY; store or
	 * materializer unavailable → 503 FACET_ENGINE_UNAVAILABLE; the same action in flight for (store,
	 * entity) → 429 { Limit: 'Admin.InFlight' }; a rebuild within Admin.RebuildCooldownMS of the last
	 * completed one → 429 { Limit: 'Admin.RebuildCooldownMS' }.
	 *
	 * @param {string} pAction
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Error|null}
	 */
	storeAdminRefusal(pAction, pStore, pEntity)
	{
		if (ADMIN_ACTIONS.indexOf(pAction) < 0)
		{
			return libFacetErrors.create('FACET_REQUEST_INVALID', `An admin action is one of ${ADMIN_ACTIONS.join(' | ')}.`, { Field: 'Action' });
		}
		if ((typeof(pStore) !== 'string') || !libRetoldFacetingUtil.hasOwn(STORE_ENGINES, pStore) || !this.storeRegistered())
		{
			return libFacetErrors.create('FACET_UNKNOWN_ENTITY', 'Unknown store.', { Store: libRetoldFacetingUtil.logSafe(String(pStore)).substring(0, 64) });
		}
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || !tmpMaterializer.started())
		{
			return libFacetErrors.create('FACET_ENGINE_UNAVAILABLE', 'The store is not materializing.', { Store: pStore });
		}
		if ((typeof(pEntity) !== 'string') || !tmpMaterializer.loop(pStore, pEntity))
		{
			return libFacetErrors.create('FACET_UNKNOWN_ENTITY', 'The store does not materialize this entity.', { Store: pStore });
		}
		let tmpStatus = tmpMaterializer.status();
		if (!tmpStatus.Stores[pStore] || !tmpStatus.Stores[pStore].Available)
		{
			return libFacetErrors.create('FACET_ENGINE_UNAVAILABLE', 'The store is unavailable.', { Store: pStore });
		}
		let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		let tmpBusy = this._AdminInFlight.has(`${pStore}:${pEntity}:${pAction}`);
		if (pAction === 'Rebuild')
		{
			tmpBusy = tmpBusy || !!(tmpRebuilder && tmpRebuilder.status(pStore, pEntity));
		}
		else if (tmpReconciler && (typeof(tmpReconciler.isRunning) === 'function'))
		{
			tmpBusy = tmpBusy || tmpReconciler.isRunning(pStore, pEntity, pAction);
		}
		if (tmpBusy)
		{
			return libFacetErrors.create('FACET_RATE_LIMITED', 'This action is already running for the entity.', { Limit: 'Admin.InFlight' });
		}
		if (pAction === 'Rebuild')
		{
			let tmpCooldown = (this.options.Admin && Number.isFinite(this.options.Admin.RebuildCooldownMS)) ? this.options.Admin.RebuildCooldownMS : 600000;
			let tmpLast = tmpRebuilder ? tmpRebuilder.lastCompleted(pStore, pEntity) : null;
			// Between rebuilds: a first-enable build (the boot backfill, a wipe recovery) never blocks one.
			if (tmpLast && (tmpLast.FirstEnable !== true) && (tmpLast.Reason !== libRetoldFacetingRebuilder.BACKFILL_REASON) && (typeof(tmpLast.AtMS) === 'number') && ((Date.now() - tmpLast.AtMS) < tmpCooldown))
			{
				return libFacetErrors.create('FACET_RATE_LIMITED', 'The entity was rebuilt recently.', { Limit: 'Admin.RebuildCooldownMS', RetryAfterMS: Math.max(0, tmpCooldown - (Date.now() - tmpLast.AtMS)) });
			}
		}
		return null;
	}

	/**
	 * The in-process admin trigger (internal-contracts §60.5): pAction ∈ Rebuild | Sweep | Bisect | Scrub
	 * | Verify on (store, entity) → the Rebuilder / Reconciler call (Rebuild Reason 'Admin'; Scrub takes
	 * pOptions.Full).  Refusals per storeAdminRefusal; the Rebuilder's / Reconciler's own errors pass
	 * through unchanged.  Never throws.
	 *
	 * @param {string} pAction
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pOptions]
	 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
	 */
	storeAdmin(pAction, pStore, pEntity, pOptions, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : ((typeof(pOptions) === 'function') ? pOptions : () => {});
		let tmpOptions = libRetoldFacetingUtil.isPlainObject(pOptions) ? pOptions : {};
		let tmpRefusal = this.storeAdminRefusal(pAction, pStore, pEntity);
		if (tmpRefusal)
		{
			return fDone(tmpRefusal);
		}
		let tmpKey = `${pStore}:${pEntity}:${pAction}`;
		this._AdminInFlight.add(tmpKey);
		let tmpCalledBack = false;
		let fFinish = (pError, pResult) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			this._AdminInFlight.delete(tmpKey);
			return fDone(pError || null, pResult);
		};
		let tmpRebuilder = this.fable.RetoldFacetingRebuilder;
		let tmpReconciler = this.fable.RetoldFacetingReconciler;
		this.fable.log.info(`RetoldFaceting admin: ${pAction} ${pStore}.${libRetoldFacetingUtil.logSafe(pEntity)}.`);
		try
		{
			switch (pAction)
			{
				case 'Rebuild':
					return tmpRebuilder.rebuild(pStore, pEntity, { Reason: 'Admin' }, fFinish);
				case 'Sweep':
					return tmpReconciler.sweep(pStore, pEntity, tmpOptions, fFinish);
				case 'Bisect':
					return tmpReconciler.bisect(pStore, pEntity, tmpOptions, fFinish);
				case 'Scrub':
					return tmpReconciler.scrub(pStore, pEntity, Object.assign({}, tmpOptions, { Full: (tmpOptions.Full !== false) }), fFinish);
				default:
					return tmpReconciler.verify(pStore, pEntity, fFinish);
			}
		}
		catch (pAdminError)
		{
			this.fable.log.error(`RetoldFaceting admin ${pAction} failed: ${pAdminError.message}`);
			return fFinish(libFacetErrors.create('FACET_INTERNAL'));
		}
	}

	/**
	 * An admin route request (internal-contracts §60.5; mounted only with Admin.Routes): resolve the
	 * principal (the M1 401 rules), then Admin.authorize(pRequest, pPrincipal) must return exactly true
	 * (a host function; absent or anything else → 403 FACET_FORBIDDEN without Detail), then the
	 * storeAdmin refusals; a started action calls back { Started: true, Action, Store, Entity } at once
	 * (202) and runs on (its outcome is logged).
	 *
	 * @param {string} pRoute - 'Rebuild' | 'Reconcile'
	 * @param {any} pRequest - restify request (params Store, Entity; body { Level } for Reconcile)
	 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
	 */
	adminRequest(pRoute, pRequest, fCallback)
	{
		if (!this._Attached || !this.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service is not attached to a host.'));
		}
		let tmpRequest = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? pRequest : { params: {}, headers: {}, query: {} };
		let tmpParams = tmpRequest.params || {};
		let tmpContext = this.newContext(null, tmpRequest, {});
		this.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext,
			(pPrincipalError, pPrincipal) =>
			{
				if (pPrincipalError)
				{
					return fCallback(pPrincipalError);
				}
				let tmpAuthorize = (this.options.Admin && (typeof(this.options.Admin.authorize) === 'function')) ? this.options.Admin.authorize : null;
				let tmpAllowed = false;
				try
				{
					tmpAllowed = !!tmpAuthorize && (tmpAuthorize(tmpRequest, pPrincipal) === true);
				}
				catch (pAuthorizeError)
				{
					this.fable.log.warn(`RetoldFaceting admin: Admin.authorize threw: ${pAuthorizeError.message}`);
					tmpAllowed = false;
				}
				if (!tmpAllowed)
				{
					return fCallback(libFacetErrors.create('FACET_FORBIDDEN'));
				}
				let tmpBody = libRetoldFacetingUtil.isPlainObject(tmpRequest.body) ? tmpRequest.body : {};
				let tmpAction = 'Rebuild';
				if (pRoute === 'Reconcile')
				{
					tmpAction = (ADMIN_LEVELS.indexOf(tmpBody.Level) >= 0) ? tmpBody.Level : null;
					if (!tmpAction)
					{
						return fCallback(libFacetErrors.create('FACET_REQUEST_INVALID', `Level is one of ${ADMIN_LEVELS.join(' | ')}.`, { Field: 'Level' }));
					}
				}
				let tmpStore = (typeof(tmpParams.Store) === 'string') ? tmpParams.Store : '';
				let tmpEntity = (typeof(tmpParams.Entity) === 'string') ? tmpParams.Entity : '';
				let tmpRefusal = this.storeAdminRefusal(tmpAction, tmpStore, tmpEntity);
				if (tmpRefusal)
				{
					return fCallback(tmpRefusal);
				}
				this.storeAdmin(tmpAction, tmpStore, tmpEntity, (tmpAction === 'Scrub') ? { Full: true } : {},
					(pError) =>
					{
						if (pError)
						{
							this.fable.log.warn(`RetoldFaceting admin ${tmpAction} ${tmpStore}.${libRetoldFacetingUtil.logSafe(tmpEntity)} failed: ${pError.message}`);
						}
					});
				return fCallback(null, { Started: true, Action: tmpAction, Store: tmpStore, Entity: tmpEntity });
			});
	}

	/**
	 * A raw writer's change, after COMMIT (internal-contracts §40.5): DAL-direct writes, importers,
	 * raw SQL — anything the interim intake cannot see.  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pChange] - { Operation, IDs, Records, Before, Tenants, Owners, ChangedColumns, Principal | PrincipalKey }
	 * @return {string|null} the Seq of the change, or null when refused (logged)
	 */
	notify(pEntity, pChange)
	{
		this.registerServices();
		return this.fable.RetoldFacetingChangeIntake.notify(pEntity, pChange);
	}

	/**
	 * Alias of notify (05 §5).
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
	 * "Anything matching this PRE-write filter changed" (internal-contracts §40.5): an EntityDirty
	 * change (the filter is carried, never executed in M4).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string|Array<Record<string, any>>} pFilter
	 * @param {Record<string, any>} [pOptions] - { Tenants, Owners, Principal | PrincipalKey }
	 * @return {string|null}
	 */
	notifyByFilter(pEntity, pFilter, pOptions)
	{
		this.registerServices();
		return this.fable.RetoldFacetingChangeIntake.notifyByFilter(pEntity, pFilter, pOptions);
	}

	/**
	 * @return {boolean} Cache.Enabled (the result cache, the generation Version and the 304 short-circuit)
	 */
	cacheEnabled()
	{
		return !!(this.options.Cache && (this.options.Cache.Enabled === true));
	}

	/**
	 * The node's current change Seq (the intake's), or null without an intake.
	 *
	 * @return {string|null}
	 */
	currentSeq()
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		return (tmpIntake && (typeof(tmpIntake.currentSeq) === 'function')) ? tmpIntake.currentSeq() : null;
	}

	/**
	 * Does the host run a scope policy (Kind 'Policy': a multi-tenant host)?
	 *
	 * @return {boolean}
	 */
	hasScopePolicy()
	{
		let tmpPolicy = null;
		try
		{
			tmpPolicy = (this.Host && (typeof(this.Host.getScopePolicy) === 'function')) ? this.Host.getScopePolicy() : null;
		}
		catch (pPolicyError)
		{
			tmpPolicy = null;
		}
		return !!tmpPolicy && (tmpPolicy.Kind === 'Policy');
	}

	/**
	 * Is X-Retold-Facet-Seq sent (internal-contracts §44.8)?  Freshness.SeqHeader true / false, or
	 * 'Auto' (the default): only on a host without a scope policy — the Seq is the node-wide change
	 * counter, so on a multi-tenant host consecutive values would reveal other tenants' write volume
	 * (§51.10).  Never when no change source is installed (the Seq would never move with the data).
	 *
	 * @return {boolean}
	 */
	seqHeaderEnabled()
	{
		let tmpSetting = this.options.Freshness ? this.options.Freshness.SeqHeader : 'Auto';
		if (tmpSetting === false)
		{
			return false;
		}
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		if (!tmpIntake || (tmpIntake._Source === 'None'))
		{
			return false;
		}
		return (tmpSetting === true) || !this.hasScopePolicy();
	}

	/**
	 * Cache.ExposeStatus: the X-Retold-Facet-Cache / -Freshness headers, and a truthful Cached flag on
	 * a hit computed by another principal (§51.57).  Off by default: an operator / demo switch.
	 *
	 * @return {boolean}
	 */
	exposeCacheStatus()
	{
		return !!(this.options.Cache && (this.options.Cache.ExposeStatus === true));
	}

	/**
	 * The public query entry point (HTTP route and in-process callers).
	 *
	 * @param {string} pEntity
	 * @param {any} pBody - FacetRequest body (02 §3)
	 * @param {any} pRequest - restify request or synthetic { params, headers, query, UserSession }
	 * @param {(pError?: Error, pEnvelope?: Record<string, any>, pMeta?: Record<string, any>) => void} fCallback - pMeta is in-process only (internal-contracts §18.1)
	 */
	query(pEntity, pBody, pRequest, fCallback)
	{
		return this.queryInternal(pEntity, pBody, pRequest, {}, fCallback);
	}

	/**
	 * The pipeline (internal-contracts §2, §19.2, §44.1), as a waterfall of the stage methods below:
	 *
	 *   Principal → Shape → Freshness → Gate → Bind → Filter → Plan → Cache
	 *     → (304 / Hit / Stale served by the Cache stage)  or  Execute → Records → Post → Store
	 *
	 * Everything before the Cache stage runs no SQL, so authorization always precedes any cache read
	 * and any 304 (06 §7).  A cacheable miss computes through ResultCache.flight (concurrent requests
	 * with the same key and GenVector share one execution).
	 *
	 * In-process-only options (never reachable from a client): ForceEngine === 'Reference' runs the O1
	 * oracle (never cached); Now / PlanForm (newContext); CacheRefresh (the background refresh of a
	 * Stale serve: skips the lookup, computes and stores).
	 *
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @param {any} pRequest
	 * @param {{ ForceEngine?: string, Now?: string|number, PlanForm?: Record<string, any>, CacheRefresh?: boolean }} pInternalOptions
	 * @param {(pError?: Error, pEnvelope?: Record<string, any>|null, pMeta?: Record<string, any>) => void} fCallback - pEnvelope is null on the 304 path (pMeta.NotModified)
	 */
	queryInternal(pEntity, pBody, pRequest, pInternalOptions, fCallback)
	{
		let tmpStart = Date.now();
		if (!this._Attached || !this.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service is not attached to a host.'));
		}
		let tmpEntity = (typeof(pEntity) === 'string') ? pEntity : '';
		let tmpRequest = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? pRequest : { params: {}, headers: {}, query: {} };
		let tmpContext = this.newContext(tmpEntity, tmpRequest, pInternalOptions);
		// Kept for the background refresh of a Stale serve only (never key material).
		tmpContext.RequestBody = pBody;
		let fGuard = this.stageGuard(tmpContext);

		this.fable.Utility.waterfall(
			[
				fGuard('Principal', (fNext) => { return this.stagePrincipal(tmpContext, fNext); }),
				fGuard('Shape', (fNext) => { return this.stageShape(tmpContext, pBody, tmpStart, fNext); }),
				fGuard('Freshness', (fNext) => { return this.stageFreshness(tmpContext, fNext); }),
				fGuard('Gate', (fNext) => { return this.stageGate(tmpContext, fNext); }),
				fGuard('Bind', (fNext) => { return this.stageBind(tmpContext, fNext); }),
				fGuard('Filter', (fNext) => { return this.stageFilter(tmpContext, fNext); }),
				fGuard('Plan', (fNext) => { return this.stagePlan(tmpContext, fNext); }),
				fGuard('Cache', (pPlan, fNext) => { return this.stageCache(tmpContext, pPlan, tmpStart, fNext); })
			],
			(pError, pPlan, pServed) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pServed)
				{
					// 304, Hit or Stale: nothing executed.
					return fCallback(null, pServed.Envelope, pServed.Meta);
				}
				return this.computeQuery(tmpContext, pPlan, tmpStart, fCallback);
			});
	}

	/**
	 * Execute → Records → Post → Store for a Query the Cache stage did not answer.  A cacheable
	 * request computes through ResultCache.flight keyed by its cache Key, its GenVector and its
	 * timeout (a joiner never inherits a leader's shorter or longer deadline, §51.55): concurrent misses
	 * of one answer share one execution, each caller gets its own copy of the envelope (the joiners:
	 * Cache.Coalesced true, Statements 0).  The background refresh computes through the same flight,
	 * so a concurrent Exact miss of the same key and vector joins it instead of executing again.  A
	 * leader whose answer ended uncacheable for a reason that may not hold for the joiner — 'Errors'
	 * (e.g. a per-facet timeout at the leader's deadline) or 'ScopeChanged' (the leader's execution
	 * ran under a scope its probes did not see) — is never shared: each joiner then computes its own.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {number} pStart
	 * @param {(pError?: Error, pEnvelope?: Record<string, any>, pMeta?: Record<string, any>) => void} fCallback
	 */
	computeQuery(pContext, pPlan, pStart, fCallback)
	{
		let fGuard = this.stageGuard(pContext);
		let fWork = (fDone) =>
		{
			this.fable.Utility.waterfall(
				[
					fGuard('Execute', (fNext) => { return this.stageExecute(pContext, pPlan, fNext); }),
					fGuard('Records', (pExecutedPlan, pExecution, fNext) => { return this.stageRecords(pContext, pExecutedPlan, pExecution, fNext); }),
					fGuard('Post', (pExecutedPlan, pExecution, fNext) => { return this.postProcess(pContext, pExecutedPlan, pExecution, pStart, fNext); }),
					fGuard('Store', (pEnvelope, pMeta, fNext) => { return this.stageStore(pContext, pEnvelope, pMeta, fNext); })
				],
				(pError, pResult) =>
				{
					return fDone(pError || null, pResult);
				});
		};
		let fAnswer = (pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			return fCallback(null, pResult.Envelope, pResult.Meta);
		};
		let tmpCache = pContext.Cache || {};
		if (!tmpCache.Cacheable || tmpCache.SkipFlight || !this.fable.RetoldFacetingResultCache)
		{
			return fWork(fAnswer);
		}
		let tmpTimeoutMS = (typeof(pContext.Deadline) === 'number') ? (pContext.Deadline - pStart) : 0;
		this.fable.RetoldFacetingResultCache.flight(`${tmpCache.Key}|${tmpCache.GenVector.Hash}|${tmpTimeoutMS}`, fWork,
			(pError, pResult, pCoalesced) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pCoalesced)
				{
					return fCallback(null, pResult.Envelope, pResult.Meta);
				}
				let tmpLeaderCache = (pResult.Meta && pResult.Meta.Cache) ? pResult.Meta.Cache : null;
				if ((tmpLeaderCache && UNSHARED_REASONS.indexOf(tmpLeaderCache.Reason) >= 0) || (typeof(pResult.Body) !== 'string'))
				{
					// Not this joiner's answer to take: compute its own (outside the flight).
					return fWork(fAnswer);
				}
				if (pContext.CacheRefresh)
				{
					// A background refresh that joined a foreground computation: that one stores the answer.
					return fCallback(null, null, pResult.Meta);
				}
				// A joiner: its own copy of the answer (the stored form), this request's ElapsedMS.
				let tmpEnvelope = JSON.parse(pResult.Body);
				tmpEnvelope.Version = pResult.Meta.Version;
				tmpEnvelope.ElapsedMS = Date.now() - pStart;
				if (pContext.Store)
				{
					tmpEnvelope.Store = this.cachedStoreBlock(tmpEnvelope);
				}
				pContext.Cache.Coalesced = true;
				// The leader's post-execution verdict holds for the shared answer (Staged / TooLarge).
				if (tmpLeaderCache && tmpLeaderCache.Reason)
				{
					pContext.Cache.Reason = tmpLeaderCache.Reason;
					if (tmpLeaderCache.Status === 'Bypass')
					{
						pContext.Cache.Status = 'Bypass';
						pContext.Cache.Cacheable = false;
					}
				}
				let tmpMeta = Object.assign({}, pResult.Meta,
					{
						Statements: 0,
						Labels: 0,
						Relations: 0,
						BehaviorRuns: 0,
						CubeFallbacks: [],
						Cache: this.cacheMeta(pContext),
						Freshness: this.freshnessMeta(pContext),
						ProbeRuns: pContext.Cache.ProbeRuns || 0
					});
				return fCallback(null, tmpEnvelope, tmpMeta);
			});
	}

	/**
	 * The stage wrapper of a pipeline: an exception (a bug, never a client error) becomes a logged
	 * FACET_INTERNAL; an exception thrown after the stage called back belongs to its continuation
	 * and is rethrown.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {(pStage: string, fStage: Function) => Function}
	 */
	stageGuard(pContext)
	{
		return (pStage, fStage) =>
		{
			return (...pArguments) =>
			{
				let fNext = pArguments.pop();
				let tmpCalledBack = false;
				let fStageNext = (...pResults) =>
				{
					tmpCalledBack = true;
					return fNext(...pResults);
				};
				try
				{
					return fStage(...pArguments, fStageNext);
				}
				catch (pStageError)
				{
					if (tmpCalledBack)
					{
						throw pStageError;
					}
					return fNext(this.stageError(pContext, pStage, pStageError));
				}
			};
		};
	}

	/**
	 * Stage 1, Principal: resolve it (401 before anything else runs).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error) => void} fNext
	 */
	stagePrincipal(pContext, fNext)
	{
		this.fable.RetoldFacetingPrincipalResolver.resolve(pContext,
			(pError, pPrincipal) =>
			{
				if (pError)
				{
					return fNext(pError);
				}
				pContext.Principal = pPrincipal;
				return fNext();
			});
	}

	/**
	 * Stage 2, Shape: normalize the body and fix the deadline.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {any} pBody
	 * @param {number} pStart
	 * @param {(pError?: Error) => void} fNext
	 */
	stageShape(pContext, pBody, pStart, fNext)
	{
		pContext.NormalizedRequest = this.fable.RetoldFacetingRequestNormalizer.normalize(pContext.Entity, pBody, pContext.Mode);
		// M4 (internal-contracts §44.2): X-Retold-Facet-MinSeq stands in for a body without a MinSeq.
		let tmpFreshness = pContext.NormalizedRequest.Freshness;
		let tmpHeaders = (pContext.Request && pContext.Request.headers && (typeof(pContext.Request.headers) === 'object')) ? pContext.Request.headers : {};
		let tmpMinSeqHeader = tmpHeaders[MIN_SEQ_HEADER];
		if (tmpFreshness && (tmpFreshness.MinSeq === null) && (typeof(tmpMinSeqHeader) === 'string') && (tmpMinSeqHeader.length > 0))
		{
			if (!libRetoldFacetingUtil.SEQ_PATTERN.test(tmpMinSeqHeader.trim()))
			{
				throw libFacetErrors.create('FACET_REQUEST_INVALID', 'X-Retold-Facet-MinSeq must be a change sequence (\'e:<8 hex>:<n>\').', { Field: 'Freshness.MinSeq' });
			}
			pContext.NormalizedRequest.Freshness = Object.assign({}, tmpFreshness, { MinSeq: tmpMinSeqHeader.trim() });
		}
		let tmpTimeoutMS = this.options.Limits.TimeoutMS;
		if ((typeof(pContext.NormalizedRequest.TimeoutMS) === 'number') && (pContext.NormalizedRequest.TimeoutMS > 0))
		{
			tmpTimeoutMS = Math.min(tmpTimeoutMS, pContext.NormalizedRequest.TimeoutMS);
		}
		pContext.Deadline = pStart + tmpTimeoutMS;
		return fNext();
	}

	/**
	 * M4 stage, Freshness (internal-contracts §45): the effective mode of this request — the
	 * requested one, upgraded to Exact by an explicit MinSeq or by the principal's own write within
	 * Freshness.ReadYourWritesMS.  The background refresh of a Stale serve is always Exact.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error) => void} fNext
	 */
	stageFreshness(pContext, fNext)
	{
		let tmpRequested = (pContext.NormalizedRequest && pContext.NormalizedRequest.Freshness) ? pContext.NormalizedRequest.Freshness : { Mode: 'Exact', MaxLagMS: 0, MinSeq: null };
		let tmpReadYourWrites = this.fable.RetoldFacetingReadYourWrites;
		if (pContext.CacheRefresh || !tmpReadYourWrites)
		{
			pContext.Freshness = { Mode: 'Exact', MaxLagMS: tmpRequested.MaxLagMS, MinSeq: null, Requested: pContext.CacheRefresh ? 'Exact' : tmpRequested.Mode, Upgrade: null };
			return fNext();
		}
		pContext.Freshness = tmpReadYourWrites.effectiveFreshness(pContext.Principal, tmpRequested, Date.now());
		return fNext();
	}

	/**
	 * Stage 3, Gate: the root entity (before field validation, so errors never reveal an
	 * unreadable schema).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error) => void} fNext
	 */
	stageGate(pContext, fNext)
	{
		this.fable.RetoldFacetingAuthorizer.check(pContext, [ pContext.Entity ],
			(pError) =>
			{
				return fNext(pError || null);
			});
	}

	/**
	 * Stage 4, Bind (internal-contracts §22.6): the BindContext every scope, join clause and
	 * definition predicate binds against ($CurrentUser.* from the Principal only, $Now floored).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error) => void} fNext
	 */
	stageBind(pContext, fNext)
	{
		pContext.Bind = this.fable.RetoldFacetingBinder.context(pContext);
		return fNext();
	}

	/**
	 * Stage 5, Filter: pin the dialect, build the FilterAST (with the BindContext and the per-entity
	 * gate, so every entity a scope or join clause reads is gated before its fields are validated,
	 * internal-contracts §19.6), then check the Records sort fields (filterable pivot columns).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error) => void} fNext
	 */
	stageFilter(pContext, fNext)
	{
		let tmpProfile = this.Host.getDialectProfile(pContext.Entity);
		pContext.Dialect = (tmpProfile && tmpProfile.Name) ? tmpProfile.Name : null;
		let tmpRequest = pContext.NormalizedRequest;
		pContext.FilterAST = this.fable.RetoldFacetingFilterAST.build(pContext.Entity,
			{
				Clauses: tmpRequest.Clauses,
				FilterString: tmpRequest.FilterString,
				Scopes: tmpRequest.Scopes,
				Bind: pContext.Bind,
				CanFacet: (pTarget) => { return this.fable.RetoldFacetingAuthorizer.canFacet(pContext, pTarget); }
			});
		let tmpSort = (tmpRequest.Records && Array.isArray(tmpRequest.Records.Sort)) ? tmpRequest.Records.Sort : [];
		for (let i = 0; i < tmpSort.length; i++)
		{
			if (!this.fable.RetoldFacetingCatalog.column(pContext.Entity, tmpSort[i].Field))
			{
				return fNext(libFacetErrors.create('FACET_UNKNOWN_FIELD', 'A sort field is not a filterable column.', { Field: tmpSort[i].Field.substring(0, 64), Entity: pContext.Entity }));
			}
		}
		return fNext();
	}

	/**
	 * Stage 6, Plan: plan every facet; the plan (and its cube plans) go on the context for the
	 * engines (internal-contracts §25.2: the Live engine reads pContext.Cubes).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error, pPlan?: Record<string, any>) => void} fNext
	 */
	stagePlan(pContext, fNext)
	{
		this.fable.RetoldFacetingPlanner.plan(pContext,
			(pError, pPlan) =>
			{
				if (pError)
				{
					return fNext(pError);
				}
				pContext.Plan = pPlan;
				pContext.Cubes = Array.isArray(pPlan.Cubes) ? pPlan.Cubes : [];
				return fNext(null, pPlan);
			});
	}

	/**
	 * M4 stage, Cache (internal-contracts §44.3).  Always: the cache DepSet (the envelope's DependsOn)
	 * and the Seq the answer will cover (read before anything executes).  With Cache.Enabled:
	 *
	 *   1. the quick pre-checks (Mode, ForceEngine, PlanErrors, NoChangeSource, ModelReload) → Bypass;
	 *   2. one scope probe per DepSet entity, then cacheability → Bypass with its Reason;
	 *   3. Key, Dependencies, GenVector (read now, before execution), the generation Version; the
	 *      execution's scope log is armed (the post check compares it with the probes, §42.8);
	 *   4. a MinSeq this process cannot prove applied (another epoch, or beyond the local counter):
	 *      no 304 and no lookup — computed Live (and stored), never joined to a flight (§51.50);
	 *   5. If-None-Match matching that Version → 304 without executing (NotModified);
	 *   6. the background refresh skips the lookup (Status 'Refresh');
	 *   7. ResultCache.lookup with the effective Freshness: Hit / Stale are served here, Miss computes.
	 *
	 * Calls back (null, pPlan, pServed): pServed = { Envelope, Meta } when the stage answered (304,
	 * Hit, Stale), else null.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {number} pStart
	 * @param {(pError?: Error, pPlan?: Record<string, any>, pServed?: Record<string, any>|null) => void} fNext
	 */
	stageCache(pContext, pPlan, pStart, fNext)
	{
		let tmpCacheKey = this.fable.RetoldFacetingCacheKey;
		pContext.CacheDeps = tmpCacheKey.depSet(pContext, pPlan);
		pContext.SeqAtCompute = this.currentSeq();
		if (!this.cacheEnabled())
		{
			pContext.Cache = this.newCacheState('Off', null);
			return fNext(null, pPlan, null);
		}
		let tmpPrecheck = tmpCacheKey.precheck(pContext, pPlan);
		if (tmpPrecheck.Cacheable && (typeof(pContext.PreferEngine) === 'string') && (pContext.PreferEngine !== 'Live'))
		{
			// M5: an in-process engine preference (tests) is never looked up or stored, like ForceEngine.
			tmpPrecheck = { Cacheable: false, Reason: 'ForceEngine' };
		}
		if (!tmpPrecheck.Cacheable)
		{
			return fNext(null, pPlan, this.cacheBypass(pContext, tmpPrecheck.Reason, null));
		}
		tmpCacheKey.captureScopes(pContext, pContext.CacheDeps,
			(pProbeError, pProbe) =>
			{
				let tmpProbe = pProbe || { Captures: {}, Uncacheable: [ { Entity: pContext.Entity, Reason: 'ProbeError' } ], ProbeRuns: 0, ScopeRepaired: false };
				let tmpCacheability = tmpCacheKey.cacheability(pContext, pPlan, pContext.CacheDeps, tmpProbe);
				if (!tmpCacheability.Cacheable)
				{
					return fNext(null, pPlan, this.cacheBypass(pContext, tmpCacheability.Reason, tmpProbe));
				}
				let tmpKey = tmpCacheKey.key(pContext, pPlan, tmpProbe);
				let tmpDependencies = tmpCacheKey.dependencies(pContext, pContext.CacheDeps, tmpProbe);
				let tmpVectorAt = Date.now();
				let tmpGenVector = this.fable.RetoldFacetingGenerations.vector(tmpDependencies);
				pContext.Cache = Object.assign(this.newCacheState('Miss', null),
					{
						Cacheable: true,
						Key: tmpKey.Key,
						Short: tmpKey.Short,
						Version: tmpCacheKey.version(tmpKey.Key, tmpGenVector.Hash),
						Deps: pContext.CacheDeps,
						Probe: tmpProbe,
						ProbeRuns: tmpProbe.ProbeRuns || 0,
						Dependencies: tmpDependencies,
						GenVector: tmpGenVector,
						VectorAt: tmpVectorAt,
						SeqAtCompute: pContext.SeqAtCompute
					});
				// Every scope capture the execution runs is compared with these probes (§42.8).
				pContext.ScopeLog = [];
				if (this.minSeqUnproven(pContext))
				{
					// Nothing local proves the MinSeq's write is in any entry or in this vector: computed Live,
					// stored, and answered with the digest Version (a generation Version names this process's
					// vector, which may not move for that write, so it could 304 a changed answer).
					pContext.Cache.Reason = 'MinSeq';
					pContext.Cache.SkipFlight = true;
					pContext.Cache.DigestVersion = true;
					if (pContext.CacheRefresh)
					{
						pContext.Cache.Status = 'Refresh';
					}
					return fNext(null, pPlan, null);
				}
				if (!pContext.CacheRefresh && this.ifNoneMatchMatches(pContext, pContext.Cache.Version))
				{
					// 304 without executing: the vector this ETag names is the current one.
					pContext.Cache.Status = 'NotModified';
					this.fable.RetoldFacetingResultCache.note('NotModified');
					return fNext(null, pPlan,
						{
							Envelope: null,
							Meta: this.servedMeta(pContext, pPlan,
								{
									NotModified: true,
									Version: pContext.Cache.Version,
									Engine: 'Live',
									ScopeRepaired: !!tmpProbe.ScopeRepaired,
									RecordsDropped: 0,
									Seq: this.currentSeq()
								})
						});
				}
				if (pContext.CacheRefresh)
				{
					pContext.Cache.Status = 'Refresh';
					return fNext(null, pPlan, null);
				}
				let tmpLookup = this.fable.RetoldFacetingResultCache.lookup(tmpKey.Key, tmpGenVector, pContext.Freshness, Date.now());
				if ((tmpLookup.Status === 'Hit') || (tmpLookup.Status === 'Stale'))
				{
					return fNext(null, pPlan, this.serveCached(pContext, pPlan, tmpLookup, pStart));
				}
				return fNext(null, pPlan, null);
			});
	}

	/**
	 * Does the request carry a MinSeq that this process cannot prove is applied (C6, 04 §8.3)?  A
	 * MinSeq of another epoch (another process, a restart) or beyond the local counter names a write
	 * whose bump never reached this process's Generations, so no local entry (and no 304) may claim to
	 * cover it.  A malformed in-process MinSeq proves nothing either.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {boolean}
	 */
	minSeqUnproven(pContext)
	{
		let tmpRequested = (pContext.NormalizedRequest && pContext.NormalizedRequest.Freshness) ? pContext.NormalizedRequest.Freshness.MinSeq : null;
		if ((typeof(tmpRequested) !== 'string') || (tmpRequested.length < 1))
		{
			return false;
		}
		let tmpSeq = libRetoldFacetingUtil.parseSeq(tmpRequested);
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		if (!tmpSeq || !tmpIntake)
		{
			return true;
		}
		return (tmpSeq.Epoch !== tmpIntake.NodeEpoch) || (tmpSeq.N > tmpIntake._SeqCounter);
	}

	/**
	 * A fresh pContext.Cache (internal-contracts §38.6).
	 *
	 * @param {string} pStatus
	 * @param {string|null} pReason
	 * @return {Record<string, any>}
	 */
	newCacheState(pStatus, pReason)
	{
		return (
			{
				Status: pStatus,
				Reason: pReason,
				Cacheable: false,
				Key: null,
				Short: null,
				Version: null,
				Deps: null,
				Probe: null,
				ProbeRuns: 0,
				Dependencies: null,
				GenVector: null,
				VectorAt: null,
				SeqAtCompute: null,
				Entry: null,
				LagMS: 0,
				Coalesced: false,
				SkipFlight: false,
				DigestVersion: false
			});
	}

	/**
	 * Mark the request uncacheable (Bypass with a Reason, counted): it runs exactly as in M2.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pReason - internal-contracts §42.3
	 * @param {Record<string, any>|null} pProbe
	 * @return {null} (nothing served)
	 */
	cacheBypass(pContext, pReason, pProbe)
	{
		pContext.Cache = this.newCacheState('Bypass', pReason);
		if (pProbe)
		{
			pContext.Cache.Probe = pProbe;
			pContext.Cache.ProbeRuns = pProbe.ProbeRuns || 0;
		}
		this.fable.RetoldFacetingResultCache.note('Bypass', pReason);
		return null;
	}

	/**
	 * Does the request's If-None-Match (weak comparison, a list, '*') name this Version?
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pVersion
	 * @return {boolean}
	 */
	ifNoneMatchMatches(pContext, pVersion)
	{
		if ((typeof(pContext.IfNoneMatch) !== 'string') || (pContext.IfNoneMatch.length < 1))
		{
			return false;
		}
		let tmpHeaders = {};
		tmpHeaders[IF_NONE_MATCH_HEADER] = pContext.IfNoneMatch;
		return this.fable.RetoldFacetingRoutes.matchesETag({ headers: tmpHeaders }, pVersion);
	}

	/**
	 * Serve a cached entry (internal-contracts §44.4): a fresh copy of the stored envelope, the
	 * Version of the representation served (Key + the entry's vector), this request's ElapsedMS, and —
	 * on the envelope and every FacetResult — Cached true, Stale, LagMS and Exact = !Stale.  AsOf and
	 * Engine stay the entry's.  A Stale serve starts the single-flight background refresh.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {{ Status: string, Entry: Record<string, any>, LagMS: number }} pLookup
	 * @param {number} pStart
	 * @return {{ Envelope: Record<string, any>, Meta: Record<string, any> }}
	 */
	serveCached(pContext, pPlan, pLookup, pStart)
	{
		let tmpEntry = pLookup.Entry;
		let tmpStale = (pLookup.Status === 'Stale');
		let tmpLagMS = tmpStale ? Math.max(0, pLookup.LagMS || 0) : 0;
		let tmpEnvelope = JSON.parse(tmpEntry.Body);
		let tmpVersion = this.fable.RetoldFacetingCacheKey.version(pContext.Cache.Key, tmpEntry.GenVectorHash);
		tmpEnvelope.Version = tmpVersion;
		tmpEnvelope.ElapsedMS = Date.now() - pStart;
		// A Hit is exactly the current answer; telling a principal it came from an entry another
		// principal computed would say that a colleague ran the same query (S9), so unless
		// Cache.ExposeStatus only the computing principal's hits say Cached.  Stale is always truthful.
		let tmpCached = tmpStale || this.exposeCacheStatus() || !tmpEntry.By
			|| (!!pContext.Principal && (libRetoldFacetingUtil.principalKey(pContext.Principal) === tmpEntry.By));
		let fMark = (pTarget) =>
		{
			pTarget.Cached = tmpCached;
			pTarget.Stale = tmpStale;
			pTarget.LagMS = tmpLagMS;
			pTarget.Exact = (pTarget.Exact !== false) && !tmpStale;
		};
		fMark(tmpEnvelope);
		let tmpFacets = (tmpEnvelope.Facets && (typeof(tmpEnvelope.Facets) === 'object')) ? tmpEnvelope.Facets : {};
		Object.keys(tmpFacets).forEach((pKey) => { if (tmpFacets[pKey] && (typeof(tmpFacets[pKey]) === 'object')) { fMark(tmpFacets[pKey]); } });
		if (pContext.Store)
		{
			tmpEnvelope.Store = this.cachedStoreBlock(tmpEnvelope);
		}
		pContext.Cache.Status = pLookup.Status;
		pContext.Cache.Entry = tmpEntry;
		pContext.Cache.LagMS = tmpLagMS;
		if (tmpStale)
		{
			this.startRefresh(pContext);
		}
		let tmpEntryMeta = (tmpEntry.Meta && (typeof(tmpEntry.Meta) === 'object')) ? tmpEntry.Meta : {};
		let tmpProbe = pContext.Cache.Probe || {};
		return (
			{
				Envelope: tmpEnvelope,
				Meta: this.servedMeta(pContext, pPlan,
					{
						Version: tmpVersion,
						Engine: tmpEntry.Engine || tmpEnvelope.Engine || 'Live',
						ScopeRepaired: !!(tmpEntryMeta.ScopeRepaired || tmpProbe.ScopeRepaired),
						RecordsDropped: (typeof(tmpEntryMeta.RecordsDropped) === 'number') ? tmpEntryMeta.RecordsDropped : 0,
						// A Hit covers every change so far (its vector is the current one); a Stale answer
						// covers what it covered when it was computed.
						Seq: tmpStale ? (tmpEntry.SeqAtCompute || null) : this.currentSeq()
					})
			});
	}

	/**
	 * The pMeta of an answer the Cache stage served (304, Hit, Stale): nothing executed.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pParts - { Version, Engine, ScopeRepaired, RecordsDropped, Seq, NotModified? }
	 * @return {Record<string, any>}
	 */
	servedMeta(pContext, pPlan, pParts)
	{
		return Object.assign(
			{
				Version: pParts.Version,
				Engine: pParts.Engine,
				ScopeRepaired: pParts.ScopeRepaired,
				Statements: 0,
				Labels: 0,
				Relations: 0,
				BehaviorRuns: 0,
				Variants: Object.keys(pContext.Variants || {}).length,
				Cubes: (pPlan && Array.isArray(pPlan.Cubes)) ? pPlan.Cubes.length : 0,
				CubeFallbacks: [],
				Staged: { Relations: 0, Keys: 0 },
				BindHash: (pPlan && pPlan.BindHash) ? pPlan.BindHash : null,
				RecordsDropped: pParts.RecordsDropped || 0,
				Cache: this.cacheMeta(pContext),
				Seq: pParts.Seq || null,
				Freshness: this.freshnessMeta(pContext),
				ProbeRuns: pContext.Cache ? (pContext.Cache.ProbeRuns || 0) : 0
			}, (pParts.NotModified === true) ? { NotModified: true } : {});
	}

	/**
	 * pMeta.Cache (internal-contracts §44.9).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {{ Status: string, Reason: string|null, Key: string|null, GenVector: string|null, LagMS: number, Coalesced: boolean }}
	 */
	cacheMeta(pContext)
	{
		let tmpCache = pContext.Cache || this.newCacheState('Off', null);
		return (
			{
				Status: tmpCache.Status,
				Reason: tmpCache.Reason || null,
				Key: tmpCache.Short || null,
				GenVector: tmpCache.GenVector ? tmpCache.GenVector.Hash : null,
				LagMS: tmpCache.LagMS || 0,
				Coalesced: (tmpCache.Coalesced === true)
			});
	}

	/**
	 * pMeta.Freshness (internal-contracts §44.9).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {{ Mode: string, Requested: string, Upgrade: string|null }}
	 */
	freshnessMeta(pContext)
	{
		let tmpFreshness = pContext.Freshness || { Mode: 'Exact', Requested: 'Exact', Upgrade: null };
		return { Mode: tmpFreshness.Mode, Requested: tmpFreshness.Requested || tmpFreshness.Mode, Upgrade: tmpFreshness.Upgrade || null };
	}

	/**
	 * Start the background refresh of a Stale-served key (single flight per key, ResultCache.refresh):
	 * the same body through queryInternal as the same principal with CacheRefresh, whose answer is
	 * stored, never sent.  The refresh request copies params, query, the headers minus If-None-Match,
	 * and UserSession (same principal → same key).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {boolean} true when a refresh started
	 */
	startRefresh(pContext)
	{
		let tmpEntity = pContext.Entity;
		let tmpBody = pContext.RequestBody;
		let tmpRequest = this.refreshRequest(pContext.Request);
		// M5: the refresh exists to store an entry, and only a Live answer is ever stored (§62.4): it asks Live.
		let tmpInternal = Object.assign({}, pContext.InternalOptions || {}, { CacheRefresh: true, PreferEngine: 'Live' });
		return this.fable.RetoldFacetingResultCache.refresh(pContext.Cache.Key,
			(fDone) =>
			{
				this.queryInternal(tmpEntity, tmpBody, tmpRequest, tmpInternal,
					(pError) =>
					{
						return fDone(pError || null);
					});
			});
	}

	/**
	 * The synthetic request of a background refresh.
	 *
	 * @param {any} pRequest
	 * @return {{ params: Record<string, any>, query: Record<string, any>, headers: Record<string, any>, UserSession?: any }}
	 */
	refreshRequest(pRequest)
	{
		let tmpRequest = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? pRequest : {};
		let tmpHeaders = Object.assign({}, (tmpRequest.headers && (typeof(tmpRequest.headers) === 'object')) ? tmpRequest.headers : {});
		delete tmpHeaders[IF_NONE_MATCH_HEADER];
		let tmpRefresh = (
			{
				params: Object.assign({}, (tmpRequest.params && (typeof(tmpRequest.params) === 'object')) ? tmpRequest.params : {}),
				query: Object.assign({}, (tmpRequest.query && (typeof(tmpRequest.query) === 'object')) ? tmpRequest.query : {}),
				headers: tmpHeaders
			});
		if (typeof(tmpRequest.UserSession) !== 'undefined')
		{
			tmpRefresh.UserSession = tmpRequest.UserSession;
		}
		return tmpRefresh;
	}

	/**
	 * M4 stage, Store (internal-contracts §44.6): a cacheable answer (pre and post checks passed) is
	 * stored with the vector read BEFORE execution, so a write that committed meanwhile leaves it
	 * stale from birth.  The stored Body is the envelope with Version null and ElapsedMS 0 (also what
	 * single-flight joiners are served from).  Never fails the request.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pEnvelope
	 * @param {Record<string, any>} pMeta
	 * @param {(pError?: Error, pResult?: { Envelope: Record<string, any>, Meta: Record<string, any>, Body: string|null }) => void} fNext
	 */
	stageStore(pContext, pEnvelope, pMeta, fNext)
	{
		let tmpCache = pContext.Cache || {};
		let tmpBody = null;
		if ((typeof(tmpCache.Key) === 'string') && (tmpCache.Cacheable || (UNSHARED_REASONS.indexOf(tmpCache.Reason) < 0)))
		{
			// Keyed at the Cache stage: stored when still cacheable, and the form single-flight joiners
			// get (never built for an answer no joiner may take).
			// (M5: without the Store block — a served entry is a Live answer and gets its own, cachedStoreBlock.)
			tmpBody = JSON.stringify(Object.assign({}, pEnvelope, { Version: null, ElapsedMS: 0, Store: undefined }));
		}
		if (tmpCache.Cacheable && (tmpBody !== null))
		{
			let tmpResultCache = this.fable.RetoldFacetingResultCache;
			let tmpStored = tmpResultCache.set(tmpCache.Key,
				{
					Key: tmpCache.Key,
					GenVectorHash: tmpCache.GenVector.Hash,
					MaxTick: tmpCache.GenVector.MaxTick,
					SeqAtCompute: tmpCache.SeqAtCompute,
					Body: tmpBody,
					// The age of an answer counts from the moment its vector was read (before execution), so
					// a Stale LagMS is never less than its true staleness (internal-contracts §51).
					CreatedAt: tmpCache.VectorAt || Date.now(),
					AsOf: pEnvelope.AsOf,
					Engine: pEnvelope.Engine,
					// The principal that computed it (only its own hits say Cached unless Cache.ExposeStatus).
					By: pContext.Principal ? libRetoldFacetingUtil.principalKey(pContext.Principal) : null,
					Meta:
						{
							DependsOn: Array.isArray(pEnvelope.DependsOn) ? pEnvelope.DependsOn.slice() : [],
							ScopeRepaired: !!pMeta.ScopeRepaired,
							RecordsDropped: pMeta.RecordsDropped || 0,
							Statements: pMeta.Statements || 0,
							BindHash: pMeta.BindHash || null
						}
				});
			let tmpMaxEntryBytes = (this.options.Cache && Number.isSafeInteger(this.options.Cache.MaxEntryBytes)) ? this.options.Cache.MaxEntryBytes : 4194304;
			if (!tmpStored && ((Buffer.byteLength(tmpBody, 'utf8') + libRetoldFacetingResultCache.ENTRY_OVERHEAD_BYTES) > tmpMaxEntryBytes))
			{
				// Still the generation Version (it is valid without an entry); just not kept.
				tmpCache.Reason = 'TooLarge';
				tmpResultCache.note('Bypass', 'TooLarge');
				pMeta.Cache = this.cacheMeta(pContext);
			}
		}
		return fNext(null, { Envelope: pEnvelope, Meta: pMeta, Body: tmpBody });
	}

	/**
	 * Stages 7–8, Execute: route and execute, handing the plan on with the execution.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {(pError?: Error, pPlan?: Record<string, any>, pExecution?: Record<string, any>) => void} fNext
	 */
	stageExecute(pContext, pPlan, fNext)
	{
		this.execute(pContext, pPlan,
			(pError, pExecution) =>
			{
				if (pError)
				{
					return fNext(pError);
				}
				return fNext(null, pPlan, pExecution);
			});
	}

	/**
	 * Stage 8, Records (internal-contracts §28.3, §28.4): when the Query body asks for Records, one
	 * page of the full filter's rows (v0, no exclusions) through the same compiler — always Live and
	 * Exact, whatever engine answered the facets — hydrated through the entity's list waterfall.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pExecution
	 * @param {(pError?: Error, pPlan?: Record<string, any>, pExecution?: Record<string, any>) => void} fNext
	 */
	stageRecords(pContext, pPlan, pExecution, fNext)
	{
		let tmpPage = pContext.NormalizedRequest.Records;
		if (!tmpPage)
		{
			return fNext(null, pPlan, pExecution);
		}
		this.fable.RetoldFacetingPlanner.planBase(pContext,
			(pPlanError, pBasePlan) =>
			{
				if (pPlanError)
				{
					return fNext(pPlanError);
				}
				this.recordsPage(pContext, pBasePlan, tmpPage,
					(pError, pPageResult) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						pContext.RecordsResult = pPageResult;
						return fNext(null, pPlan, pExecution);
					});
			});
	}

	/**
	 * Map an unexpected stage exception to a logged FACET_INTERNAL (facet errors pass through).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pStage
	 * @param {any} pError
	 * @return {Error}
	 */
	stageError(pContext, pStage, pError)
	{
		if (libFacetErrors.isFacetError(pError))
		{
			return pError;
		}
		this.fable.log.error(`RetoldFaceting request ${pContext.RequestID} failed in ${pStage} (plan ${this.planHash(pContext)}): ${(pError && pError.message) ? pError.message : pError}`);
		return libFacetErrors.create('FACET_INTERNAL');
	}

	/**
	 * A short hash of the plan inputs, for logs only (never values).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {string}
	 */
	planHash(pContext)
	{
		let tmpMaterial = [ pContext.Entity, libFacetClauses.canonicalJSON(pContext.NormalizedRequest ? pContext.NormalizedRequest.Facets : null) ].join('|');
		return libCrypto.createHash('sha256').update(tmpMaterial).digest('hex').slice(0, 12);
	}

	/**
	 * Steps 7–8: route the planned Aggs to an engine and execute them.  With no Aggs (every facet
	 * failed planning and no Total) nothing runs.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan - Planner.plan result
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	execute(pContext, pPlan, fCallback)
	{
		if (!Array.isArray(pPlan.Aggs) || (pPlan.Aggs.length < 1))
		{
			return fCallback(null,
				{
					Engine: pContext.ForceEngine || 'Live',
					AsOf: pContext.Now,
					Exact: true,
					Results: {},
					Errors: {},
					Captures: {},
					Statements: 0
				});
		}
		if (!pContext.Plan)
		{
			pContext.Plan = pPlan;
			pContext.Cubes = Array.isArray(pPlan.Cubes) ? pPlan.Cubes : [];
		}
		return this.fable.RetoldFacetingRouter.route(pPlan.Aggs, pContext, fCallback);
	}

	/**
	 * Step 9: RawFacetResults → FacetResults (contract post-processing), FK labels, Version, envelope.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pPlan
	 * @param {Record<string, any>} pExecution
	 * @param {number} pStart - Date.now() at request start
	 * @param {(pError?: Error, pEnvelope?: Record<string, any>, pMeta?: Record<string, any>) => void} fCallback
	 */
	postProcess(pContext, pPlan, pExecution, pStart, fCallback)
	{
		let tmpRequest = pContext.NormalizedRequest;
		let tmpResults = pExecution.Results || {};
		let tmpExecutionErrors = pExecution.Errors || {};
		let tmpAggsByKey = {};
		pPlan.Aggs.forEach((pAgg) => { tmpAggsByKey[pAgg.Key] = pAgg; });
		let tmpConjunctsById = {};
		(pContext.FilterAST.Conjuncts || []).forEach((pConjunct) => { tmpConjunctsById[pConjunct.Id] = pConjunct; });
		let tmpPostBase =
			{
				Engine: pExecution.Engine,
				AsOf: pExecution.AsOf || pContext.Now,
				Exact: (pExecution.Exact !== false),
				Limits: this.options.Limits,
				StorageTimeZone: this.options.Time.StorageTimeZone
			};
		// M5 (internal-contracts §62.3): each facet's Engine / Exact / AsOf / LagMS from the engine that
		// answered its Agg (a store's freshness was read before its statements ran).
		let tmpEngineFields = {};
		let fEngineFields = (pKey) =>
		{
			if (!libRetoldFacetingUtil.hasOwn(tmpEngineFields, pKey))
			{
				tmpEngineFields[pKey] = this.engineFields(pContext, pExecution, pKey);
			}
			return tmpEngineFields[pKey];
		};

		let tmpFacets = {};
		let tmpErrors = {};
		let tmpLabelWork = [];
		for (let i = 0; i < tmpRequest.Facets.length; i++)
		{
			let tmpKey = tmpRequest.Facets[i].Key;
			if (pPlan.Errors && libRetoldFacetingUtil.hasOwn(pPlan.Errors, tmpKey))
			{
				tmpErrors[tmpKey] = pPlan.Errors[tmpKey];
				continue;
			}
			if (libRetoldFacetingUtil.hasOwn(tmpExecutionErrors, tmpKey))
			{
				tmpErrors[tmpKey] = tmpExecutionErrors[tmpKey];
				continue;
			}
			let tmpAgg = tmpAggsByKey[tmpKey];
			let tmpRaw = tmpResults[tmpKey];
			if (!tmpAgg || !tmpRaw)
			{
				this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: facet ${libRetoldFacetingUtil.logSafe(tmpKey)} has no result (plan ${this.planHash(pContext)}).`);
				tmpErrors[tmpKey] = libFacetErrors.toEntry(libFacetErrors.create('FACET_INTERNAL'));
				continue;
			}
			let tmpOwned = (tmpAgg.Disjunctive && Array.isArray(tmpAgg.Disjunctive.Owned) ? tmpAgg.Disjunctive.Owned : [])
				.map((pId) => { return tmpConjunctsById[pId]; })
				.filter((pConjunct) => { return !!pConjunct; });
			let tmpFields = fEngineFields(tmpKey);
			try
			{
				tmpFacets[tmpKey] = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, Object.assign({}, tmpPostBase, { Engine: tmpFields.Engine, AsOf: tmpFields.AsOf, Exact: tmpFields.Exact, OwnedConjuncts: tmpOwned, DisplayName: tmpAgg.DisplayName }));
				tmpFacets[tmpKey].LagMS = tmpFields.LagMS;
			}
			catch (pBuildError)
			{
				if (!libFacetErrors.isFacetError(pBuildError))
				{
					this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: post-processing of facet ${libRetoldFacetingUtil.logSafe(tmpKey)} failed (plan ${this.planHash(pContext)}): ${pBuildError.message}`);
				}
				tmpErrors[tmpKey] = libFacetErrors.toEntry(pBuildError);
				continue;
			}
			if (tmpAgg.LabelLookup && (tmpFacets[tmpKey].Buckets.length > 0))
			{
				tmpLabelWork.push({ Agg: tmpAgg, Result: tmpFacets[tmpKey] });
			}
		}

		let tmpTotal = null;
		if (tmpRequest.Total !== false)
		{
			if (libRetoldFacetingUtil.hasOwn(tmpExecutionErrors, TOTAL_KEY))
			{
				tmpErrors[TOTAL_KEY] = tmpExecutionErrors[TOTAL_KEY];
			}
			else if (tmpResults[TOTAL_KEY])
			{
				tmpTotal = Number(tmpResults[TOTAL_KEY].Total) || 0;
			}
			else
			{
				tmpErrors[TOTAL_KEY] = libFacetErrors.toEntry(libFacetErrors.create('FACET_INTERNAL'));
			}
		}

		let tmpRecords = pContext.RecordsResult || null;
		this.fable.RetoldFacetingLabelResolver.resolve(pContext, tmpLabelWork,
			() =>
			{
				let tmpSummary = this.envelopeEngineFields(pContext, pExecution, tmpRequest, tmpFacets, (tmpTotal === null) ? null : fEngineFields(TOTAL_KEY));
				let tmpEnvelope = libFacetEnvelope.buildEnvelope(
					{
						Records: tmpRecords ? tmpRecords.Records : undefined,
						RecordShape: tmpRecords ? 'Entity' : undefined,
						RecordsDropped: tmpRecords ? tmpRecords.Dropped : undefined,
						// M4 (internal-contracts §44.7): every Query envelope, cache on or off, either engine.
						DependsOn: (pContext.CacheDeps && Array.isArray(pContext.CacheDeps.Entities)) ? pContext.CacheDeps.Entities : [],
						Entity: pContext.Entity,
						Version: null,
						ModelVersion: this.fable.RetoldFacetingCatalog.modelVersion(),
						Engine: tmpSummary.Engine,
						Exact: tmpSummary.Exact,
						AsOf: tmpSummary.AsOf,
						LagMS: tmpSummary.LagMS,
						ElapsedMS: Date.now() - pStart,
						Total: (tmpTotal === null) ? undefined : tmpTotal,
						IncludesDeleted: (pContext.FilterAST.IncludesDeleted === true),
						FilterAST: pContext.FilterAST,
						Facets: tmpFacets,
						Errors: tmpErrors,
						Warnings: pContext.Warnings.concat(Array.isArray(tmpRequest.Warnings) ? tmpRequest.Warnings : [])
					});
				if (tmpSummary.LagMS === null)
				{
					// A store answer whose lag is unknown (an entity still building, under PreferEngine).
					tmpEnvelope.LagMS = null;
				}
				// M5 (internal-contracts §62.3): the Store block, only when a store is registered.
				if (pContext.Store)
				{
					tmpEnvelope.Store = this.storeBlock(pContext);
				}
				let tmpFailure = libFacetEnvelope.requestFailure(tmpEnvelope, tmpRequest.Total !== false);
				if (tmpFailure)
				{
					return fCallback(libFacetErrors.create(tmpFailure.Code, tmpFailure.Message, tmpFailure.Detail));
				}
				// M4 (internal-contracts §44.5): the generation Version for an answer cacheable end to end;
				// the representation digest (M2) for everything else.
				this.cachePostCheck(pContext, pExecution, tmpEnvelope);
				let tmpVersion = (pContext.Cache && pContext.Cache.Cacheable && !pContext.Cache.DigestVersion) ? pContext.Cache.Version : this.version(pContext, pExecution, tmpEnvelope);
				tmpEnvelope.Version = tmpVersion;
				let tmpCaptures = pExecution.Captures || {};
				let tmpRepaired = Object.keys(tmpCaptures).some((pEntity) => { return !!(tmpCaptures[pEntity] && tmpCaptures[pEntity].Repaired); });
				let tmpMeta =
					{
						Version: tmpVersion,
						Engine: tmpEnvelope.Engine,
						ScopeRepaired: tmpRepaired,
						// Every SQL statement the request ran (facets, staged key sets, label reads, the Records
						// keys and hydration; M5: and the store's statements, also in Store.Statements); Labels
						// counts the label reads among them.
						Statements: (pContext.Counters.Statements || 0) + (pContext.Counters.StoreStatements || 0),
						Labels: pContext.Counters.Labels || 0,
						Relations: pContext.Counters.Relations,
						BehaviorRuns: pContext.Counters.BehaviorRuns,
						Variants: Object.keys(pContext.Variants || {}).length,
						Cubes: Array.isArray(pPlan.Cubes) ? pPlan.Cubes.length : 0,
						CubeFallbacks: Array.isArray(pExecution.CubeFallbacks) ? pExecution.CubeFallbacks.slice() : [],
						Staged: pExecution.Staged || { Relations: 0, Keys: 0 },
						BindHash: pPlan.BindHash || null,
						RecordsDropped: tmpRecords ? tmpRecords.Dropped : 0,
						// M4 (internal-contracts §44.9)
						Cache: this.cacheMeta(pContext),
						Seq: pContext.SeqAtCompute || null,
						Freshness: this.freshnessMeta(pContext),
						ProbeRuns: pContext.Cache ? (pContext.Cache.ProbeRuns || 0) : 0
					};
				if (pContext.Store)
				{
					// M5 (internal-contracts §53.5): in-process only; full reasons.
					tmpMeta.Store = this.storeMeta(pContext, pExecution);
				}
				return fCallback(null, tmpEnvelope, tmpMeta);
			});
	}

	/**
	 * One facet's (or the Total's) Engine / Exact / AsOf / LagMS (internal-contracts §62.3): Live →
	 * Exact, LagMS 0, AsOf the request clock; a store → its freshness for the Agg's DepSet read before
	 * its statements ran (AsOf = the request clock when LagMS is 0; LagMS null when unbounded).  An
	 * execution without per-Agg engines (one engine answered everything: M4, ForceEngine) keeps the
	 * execution-level fields.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {string} pKey - an Agg Key ('#Total' for the Total)
	 * @return {{ Engine: string, Exact: boolean, AsOf: string, LagMS: number|null }}
	 */
	engineFields(pContext, pExecution, pKey)
	{
		let tmpEngines = (pExecution.Engines && (typeof(pExecution.Engines) === 'object')) ? pExecution.Engines : null;
		if (!tmpEngines)
		{
			return { Engine: pExecution.Engine, Exact: (pExecution.Exact !== false), AsOf: pExecution.AsOf || pContext.Now, LagMS: 0 };
		}
		let tmpEngine = libRetoldFacetingUtil.hasOwn(tmpEngines, pKey) ? tmpEngines[pKey] : 'Live';
		let tmpFreshness = (pExecution.Freshness && libRetoldFacetingUtil.hasOwn(pExecution.Freshness, pKey)) ? pExecution.Freshness[pKey] : null;
		if ((tmpEngine === 'Live') || !tmpFreshness)
		{
			return { Engine: tmpEngine, Exact: true, AsOf: pContext.Now, LagMS: 0 };
		}
		let tmpLag = ((typeof(tmpFreshness.LagMS) === 'number') && Number.isFinite(tmpFreshness.LagMS)) ? Math.max(0, Math.round(tmpFreshness.LagMS)) : null;
		if (!this.storeExposeFreshness())
		{
			// The store's lag is global across tenants (another tenant's write makes it lag): on a host
			// that does not expose freshness only a coarse Exact goes out — no LagMS, no AsOf of it.
			let tmpExact = (tmpFreshness.Exact === true);
			return { Engine: tmpEngine, Exact: tmpExact, AsOf: tmpExact ? pContext.Now : null, LagMS: tmpExact ? 0 : null };
		}
		return (
			{
				Engine: tmpEngine,
				Exact: (tmpFreshness.Exact === true),
				AsOf: (tmpLag === 0) ? pContext.Now : (tmpFreshness.AsOf || pContext.Now),
				LagMS: tmpLag
			});
	}

	/**
	 * The envelope-level Engine / Exact / AsOf / LagMS (internal-contracts §62.3): Engine = the Total's
	 * engine when the Total was computed, else the first facet's in request order; Exact = every facet
	 * and the Total Exact; LagMS = the max (null when any is unbounded); AsOf = the oldest.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pRequest - the NormalizedRequest
	 * @param {Record<string, any>} pFacets - the built FacetResults
	 * @param {Record<string, any>|null} pTotalFields - engineFields of the Total (null: no Total)
	 * @return {{ Engine: string, Exact: boolean, AsOf: string, LagMS: number|null }}
	 */
	envelopeEngineFields(pContext, pExecution, pRequest, pFacets, pTotalFields)
	{
		if (!pExecution.Engines || (typeof(pExecution.Engines) !== 'object'))
		{
			return { Engine: pExecution.Engine, Exact: (pExecution.Exact !== false), AsOf: pExecution.AsOf || pContext.Now, LagMS: 0 };
		}
		let tmpParts = [];
		if (pTotalFields)
		{
			tmpParts.push(pTotalFields);
		}
		(Array.isArray(pRequest.Facets) ? pRequest.Facets : []).forEach(
			(pSpec) =>
			{
				let tmpFacet = pFacets[pSpec.Key];
				if (tmpFacet && (typeof(tmpFacet) === 'object'))
				{
					tmpParts.push({ Engine: tmpFacet.Engine, Exact: (tmpFacet.Exact !== false), AsOf: tmpFacet.AsOf, LagMS: tmpFacet.LagMS });
				}
			});
		if (tmpParts.length < 1)
		{
			return { Engine: 'Live', Exact: true, AsOf: pContext.Now, LagMS: 0 };
		}
		let tmpSummary = { Engine: tmpParts[0].Engine || 'Live', Exact: true, AsOf: tmpParts[0].AsOf || pContext.Now, LagMS: 0 };
		for (let i = 0; i < tmpParts.length; i++)
		{
			tmpSummary.Exact = tmpSummary.Exact && (tmpParts[i].Exact !== false);
			if ((tmpParts[i].LagMS === null) || (tmpSummary.LagMS === null))
			{
				tmpSummary.LagMS = null;
			}
			else if (tmpParts[i].LagMS > tmpSummary.LagMS)
			{
				tmpSummary.LagMS = tmpParts[i].LagMS;
			}
			if ((typeof(tmpParts[i].AsOf) === 'string') && (Date.parse(tmpParts[i].AsOf) < Date.parse(tmpSummary.AsOf)))
			{
				tmpSummary.AsOf = tmpParts[i].AsOf;
			}
		}
		return tmpSummary;
	}

	/**
	 * Does the envelope's Store block carry full reasons (Stores.ClickHouse.ExposeReasons, the demo) or
	 * only their classes?
	 *
	 * @return {boolean}
	 */
	storeExposeReasons()
	{
		let tmpStore = this.fable.RetoldFacetingStoreClickHouse;
		let tmpResolved = (tmpStore && (typeof(tmpStore.resolvedOptions) === 'function')) ? tmpStore.resolvedOptions() : null;
		if (tmpResolved && (typeof(tmpResolved.ExposeReasons) === 'boolean'))
		{
			return tmpResolved.ExposeReasons;
		}
		let tmpSection = (this.options.Stores && libRetoldFacetingUtil.isPlainObject(this.options.Stores.ClickHouse)) ? this.options.Stores.ClickHouse : {};
		return (tmpSection.ExposeReasons === true);
	}

	/**
	 * Does the envelope carry the store's freshness (per-facet LagMS / AsOf, the freshness refusal
	 * reasons) — Stores.ClickHouse.ExposeFreshness, 'Auto' = only on a host without a scope policy (the
	 * store's lag is global: on a multi-tenant host it is a signal of other tenants' write activity)?
	 *
	 * @return {boolean}
	 */
	storeExposeFreshness()
	{
		let tmpStore = this.fable.RetoldFacetingStoreClickHouse;
		let tmpResolved = (tmpStore && (typeof(tmpStore.resolvedOptions) === 'function')) ? tmpStore.resolvedOptions() : null;
		if (tmpResolved && (typeof(tmpResolved.ExposeFreshness) === 'boolean'))
		{
			return tmpResolved.ExposeFreshness;
		}
		let tmpSection = (this.options.Stores && libRetoldFacetingUtil.isPlainObject(this.options.Stores.ClickHouse)) ? this.options.Stores.ClickHouse : {};
		if ((tmpSection.ExposeFreshness === true) || (tmpSection.ExposeFreshness === false))
		{
			return tmpSection.ExposeFreshness;
		}
		return !libOptions.hasScopePolicy(this.options);
	}

	/**
	 * A refusal reason as a client may see it: the full §65 reason with ExposeReasons, else its class; a
	 * freshness reason (State / Unverified / NotExact / Lagging / NoChangeSource / Breaker: they reflect
	 * the store's global lag, i.e. other tenants' writes) as the neutral 'Freshness' unless
	 * ExposeFreshness.
	 *
	 * @param {string|null} pReason
	 * @return {string|null}
	 */
	clientStoreReason(pReason)
	{
		if (typeof(pReason) !== 'string')
		{
			return null;
		}
		let tmpClass = pReason.split(':')[0];
		if ((FRESHNESS_REASON_CLASSES.indexOf(tmpClass) >= 0) && !this.storeExposeFreshness())
		{
			return 'Freshness';
		}
		return this.storeExposeReasons() ? pReason : tmpClass;
	}

	/**
	 * The envelope Store block (internal-contracts §62.3): { Name, Available, Facets: { Key: { Engine,
	 * Reason } } ('#Total' included), Fallback: null | { Reason } }.  A Reason is the full §65 reason
	 * with Stores.ClickHouse.ExposeReasons, else its class (entity and column names of other tables stay
	 * in the logs and pMeta.Store); a freshness reason is 'Freshness' unless ExposeFreshness.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {Record<string, any>}
	 */
	storeBlock(pContext)
	{
		let tmpState = pContext.Store || {};
		let tmpDecisions = tmpState.Decisions || {};
		let tmpFacets = {};
		Object.keys(tmpDecisions).forEach(
			(pKey) =>
			{
				let tmpDecision = tmpDecisions[pKey] || {};
				tmpFacets[pKey] = { Engine: tmpDecision.Engine || 'Live', Reason: this.clientStoreReason(tmpDecision.Reason) };
			});
		return (
			{
				Name: tmpState.Name || 'ClickHouse',
				Available: this.storeAvailability().Available,
				Facets: tmpFacets,
				Fallback: tmpState.Fallback ? { Reason: tmpState.Fallback.Reason } : null
			});
	}

	/**
	 * The Store block of an answer served from the result cache (or shared by a single-flight leader):
	 * entries only ever hold Live answers (§62.4), so every facet and the Total say Live.
	 *
	 * @param {Record<string, any>} pEnvelope
	 * @return {Record<string, any>}
	 */
	cachedStoreBlock(pEnvelope)
	{
		let tmpFacets = {};
		Object.keys((pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets : {}).forEach((pKey) => { tmpFacets[pKey] = { Engine: 'Live', Reason: null }; });
		if (pEnvelope && (typeof(pEnvelope.Total) === 'number'))
		{
			tmpFacets[TOTAL_KEY] = { Engine: 'Live', Reason: null };
		}
		return { Name: 'ClickHouse', Available: this.storeAvailability().Available, Facets: tmpFacets, Fallback: null };
	}

	/**
	 * pMeta.Store (internal-contracts §53.5): { Used: [ AggKey … ], Refused: { AggKey: Reason }, Fallback,
	 * Statements, ElapsedMS } — full reasons, in-process only.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @return {Record<string, any>}
	 */
	storeMeta(pContext, pExecution)
	{
		let tmpState = pContext.Store || {};
		let tmpDecisions = tmpState.Decisions || {};
		let tmpRefused = {};
		Object.keys(tmpDecisions).forEach(
			(pKey) =>
			{
				if ((tmpDecisions[pKey].Engine === 'Live') && (typeof(tmpDecisions[pKey].Reason) === 'string'))
				{
					tmpRefused[pKey] = tmpDecisions[pKey].Reason;
				}
			});
		return (
			{
				Used: Array.isArray(tmpState.Used) ? tmpState.Used.slice() : [],
				Refused: tmpRefused,
				Fallback: tmpState.Fallback || null,
				Statements: tmpState.Statements || 0,
				ElapsedMS: tmpState.ElapsedMS || 0,
				Prefer: tmpState.Prefer || 'Auto',
				Engines: (pExecution && pExecution.Engines) ? Object.assign({}, pExecution.Engines) : {}
			});
	}

	/**
	 * The post-execution cacheability checks (internal-contracts §42.3): an execution whose scope
	 * captures drifted from its probes ('ScopeChanged', §42.8), an envelope with any Errors entry, or
	 * an execution that staged key sets, is neither stored nor given a generation Version (Status
	 * Bypass with the Reason; the answer still goes out).  'TooLarge' is the Store stage's.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pEnvelope
	 */
	cachePostCheck(pContext, pExecution, pEnvelope)
	{
		let tmpCache = pContext.Cache;
		if (!tmpCache || !tmpCache.Cacheable)
		{
			return;
		}
		let tmpReason = null;
		let tmpDrift = this.fable.RetoldFacetingCacheKey.scopeDrift(pContext);
		if (tmpDrift.Drift)
		{
			// The key names the probes' scope; this answer was computed under another one (S1 / C4).
			tmpReason = 'ScopeChanged';
			this.fable.log.warn(`RetoldFaceting request ${pContext.RequestID}: the scope of ${libRetoldFacetingUtil.logSafe(tmpDrift.Entity)} changed between the cache probe and the execution; the answer is not cached or shared.`);
		}
		else if (this.storeAnswered(pExecution))
		{
			// M5 (internal-contracts §62.4): a store answer is never stored, shared or given a generation
			// Version (binding an ApplyToken into entries is a seam, §70).
			tmpReason = 'Store';
		}
		else if (pEnvelope && pEnvelope.Errors && (Object.keys(pEnvelope.Errors).length > 0))
		{
			tmpReason = 'Errors';
		}
		else if (pExecution && pExecution.Staged && (pExecution.Staged.Relations > 0))
		{
			tmpReason = 'Staged';
		}
		if (tmpReason)
		{
			tmpCache.Cacheable = false;
			tmpCache.Reason = tmpReason;
			if (tmpCache.Status !== 'Refresh')
			{
				tmpCache.Status = 'Bypass';
			}
			this.fable.RetoldFacetingResultCache.note('Bypass', tmpReason);
		}
	}

	/**
	 * Did a store answer any facet (or the Total) of this execution?
	 *
	 * @param {Record<string, any>} pExecution
	 * @return {boolean}
	 */
	storeAnswered(pExecution)
	{
		let tmpEngines = (pExecution && pExecution.Engines && (typeof(pExecution.Engines) === 'object')) ? pExecution.Engines : null;
		if (!tmpEngines)
		{
			return !!pExecution && (typeof(pExecution.Engine) === 'string') && libRetoldFacetingUtil.hasOwn(STORE_ENGINES, pExecution.Engine);
		}
		return Object.keys(tmpEngines).some((pKey) => { return tmpEngines[pKey] !== 'Live'; });
	}

	/**
	 * The weak ETag value (internal-contracts §10.5): a hash of the plan, the captured scope, the
	 * bound values, the principal's scope values, the engine and — while there are no generations
	 * (P3) — a digest of the computed representation itself (the envelope without its volatile
	 * fields: every count, key, label, Excluded and Filter.Applied).  So any write that changes a
	 * count, or a request that differs only in its clause Hashes, gets a different ETag, and an
	 * If-None-Match 304 is never a stale answer.  The statements have already run when this is
	 * computed, so it costs one hash.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pExecution
	 * @param {Record<string, any>} pEnvelope - the built envelope (Version not yet set)
	 * @return {string} 'fv1:' + 16 hex
	 */
	version(pContext, pExecution, pEnvelope)
	{
		let tmpCaptures = pExecution.Captures || {};
		let tmpFingerprints = Object.keys(tmpCaptures).sort().map(
			(pEntity) =>
			{
				return `${pEntity}=${(tmpCaptures[pEntity] && tmpCaptures[pEntity].Fingerprint) ? tmpCaptures[pEntity].Fingerprint : ''}`;
			});
		let tmpConjuncts = (pContext.FilterAST.Conjuncts || []).map((pConjunct) => { return { Id: pConjunct.Id, Pred: pConjunct.Pred }; });
		let tmpPrincipalScope = (pContext.Principal && pContext.Principal.ScopeValues) ? pContext.Principal.ScopeValues : {};
		let tmpMaterial = (
			[
				this.fable.RetoldFacetingCatalog.modelVersion(),
				pContext.Entity,
				libFacetClauses.canonicalJSON({ Facets: pContext.NormalizedRequest.Facets, Total: pContext.NormalizedRequest.Total }),
				// M2 (internal-contracts §30.2): the named scopes and parameters, and the bound values.
				libFacetClauses.canonicalJSON({ Scopes: pContext.NormalizedRequest.Scopes || [], Params: pContext.NormalizedRequest.Params || {}, Records: pContext.NormalizedRequest.Records || null }),
				(pContext.Plan && pContext.Plan.BindHash) ? pContext.Plan.BindHash : this.bindHash(pContext),
				libFacetClauses.canonicalJSON(tmpConjuncts),
				tmpFingerprints.join(';'),
				libFacetClauses.canonicalJSON(tmpPrincipalScope),
				pExecution.Engine,
				libFacetClauses.canonicalJSON(pEnvelope ? libFacetEnvelope.normalizeForComparison(pEnvelope) : null)
			]).join('|');
		return `fv1:${libCrypto.createHash('sha256').update(tmpMaterial).digest('hex').slice(0, 16)}`;
	}

	/**
	 * BindHash of a request (internal-contracts §22.5): the Planner computes it with the plan; this
	 * covers requests that never planned (the hash of what the filter bound).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {string|null}
	 */
	bindHash(pContext)
	{
		let tmpBinder = this.fable.RetoldFacetingBinder;
		return (tmpBinder && pContext && pContext.Bind) ? tmpBinder.bindHash(pContext.Bind) : null;
	}

	// ------------------------------------------------------------ Records, Count, Keys (internal-contracts §28)

	/**
	 * A body with a path scope (the /Scope/:Scope/ route forms, internal-contracts §28.1): the scope
	 * is prepended to Scopes with the parameters that scope declares taken from the top-level Params
	 * (§22.3; the other top-level names stay where they are).  An unknown scope gets no parameters
	 * and is refused by the FilterAST (400 FACET_UNKNOWN_SCOPE).
	 *
	 * @param {string} pScope - the route :Scope
	 * @param {any} pBody
	 * @return {any} a new body (a non-object body is returned unchanged: the normalizer refuses it)
	 */
	withPathScope(pScope, pBody)
	{
		if (!libRetoldFacetingUtil.isPlainObject(pBody))
		{
			return pBody;
		}
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		let tmpScope = (tmpRegistry && (typeof(pScope) === 'string')) ? tmpRegistry.scope(pScope) : null;
		let tmpDeclared = (tmpScope && libRetoldFacetingUtil.isPlainObject(tmpScope.Params)) ? Object.keys(tmpScope.Params) : [];
		let tmpTop = libRetoldFacetingUtil.isPlainObject(pBody.Params) ? pBody.Params : {};
		let tmpParams = {};
		tmpDeclared.forEach(
			(pName) =>
			{
				if (libRetoldFacetingUtil.hasOwn(tmpTop, pName))
				{
					tmpParams[pName] = tmpTop[pName];
				}
			});
		let tmpReference = { Scope: (typeof(pScope) === 'string') ? pScope : '', Params: tmpParams };
		let tmpScopes = Array.isArray(pBody.Scopes) ? [ tmpReference ].concat(pBody.Scopes)
			: ((pBody.Scopes === null) || (typeof(pBody.Scopes) === 'undefined')) ? [ tmpReference ]
			: pBody.Scopes;
		return Object.assign({}, pBody, { Scopes: tmpScopes });
	}

	/**
	 * POST /1.0/Facet/:Entity/Records: one page of the full filter's rows (Live, Exact), hydrated
	 * through the entity's list waterfall, in plan order.
	 *
	 * @param {string} pEntity
	 * @param {any} pBody - Query filter inputs + Records: { Begin, Cap, Sort }
	 * @param {any} pRequest
	 * @param {(pError?: Error, pRecords?: Array<Record<string, any>>, pMeta?: { Dropped: number, Version: string, Keys: Array<any> }) => void} fCallback
	 */
	records(pEntity, pBody, pRequest, fCallback)
	{
		return this.baseInternal('Records', pEntity, pBody, pRequest, {}, fCallback);
	}

	/**
	 * POST /1.0/Facet/:Entity/Records/Count: the row count of the full filter (Live, Exact).
	 *
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @param {any} pRequest
	 * @param {(pError?: Error, pResult?: { Count: number }, pMeta?: { Version: string }) => void} fCallback
	 */
	count(pEntity, pBody, pRequest, fCallback)
	{
		return this.baseInternal('Count', pEntity, pBody, pRequest, {}, fCallback);
	}

	/**
	 * POST /1.0/Facet/:Entity/Keys: every primary key of the full filter (ordered by the key, at most
	 * Cap), with the full Count (Live, Exact).  The in-process form is what bulk operations call
	 * with the user's request (design 02 §6.3): they never trust posted keys.
	 *
	 * @param {string} pEntity
	 * @param {any} pBody - Query filter inputs + { Cap }
	 * @param {any} pRequest
	 * @param {(pError?: Error, pResult?: { Entity: string, Keys: Array<any>, Count: number, Truncated: boolean, Version: string }) => void} fCallback
	 */
	keys(pEntity, pBody, pRequest, fCallback)
	{
		return this.baseInternal('Keys', pEntity, pBody, pRequest, {}, fCallback);
	}

	/**
	 * The Records / Count / Keys pipeline (internal-contracts §28.3): Principal → Shape → Gate →
	 * Bind → Filter → Params → Planner.planBase (v0) → EngineLive.recordKeys / countBase / keys —
	 * always the Live engine (D-38) whatever pInternalOptions.ForceEngine says — then hydration and
	 * the Version.  pInternalOptions: Now / PlanForm as for queryInternal (in-process only).
	 *
	 * @param {string} pMode - 'Records' | 'Count' | 'Keys'
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @param {any} pRequest
	 * @param {{ Now?: string|number, PlanForm?: Record<string, any> }} pInternalOptions
	 * @param {Function} fCallback - per mode, see records() / count() / keys()
	 */
	baseInternal(pMode, pEntity, pBody, pRequest, pInternalOptions, fCallback)
	{
		let tmpStart = Date.now();
		if (!this._Attached || !this.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service is not attached to a host.'));
		}
		if ([ 'Records', 'Count', 'Keys' ].indexOf(pMode) < 0)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'Unknown base request mode.'));
		}
		let tmpEntity = (typeof(pEntity) === 'string') ? pEntity : '';
		let tmpRequest = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? pRequest : { params: {}, headers: {}, query: {} };
		let tmpInternal = Object.assign({}, ((typeof(pInternalOptions) === 'object') && (pInternalOptions !== null)) ? pInternalOptions : {});
		// Always Live (D-38): a lagging or oracle key list must never hand out rows.
		delete tmpInternal.ForceEngine;
		let tmpContext = this.newContext(tmpEntity, tmpRequest, tmpInternal, pMode);
		let fGuard = this.stageGuard(tmpContext);

		this.fable.Utility.waterfall(
			[
				fGuard('Principal', (fNext) => { return this.stagePrincipal(tmpContext, fNext); }),
				fGuard('Shape', (fNext) => { return this.stageShape(tmpContext, pBody, tmpStart, fNext); }),
				fGuard('Gate', (fNext) => { return this.stageGate(tmpContext, fNext); }),
				fGuard('Bind', (fNext) => { return this.stageBind(tmpContext, fNext); }),
				fGuard('Filter', (fNext) => { return this.stageFilter(tmpContext, fNext); }),
				fGuard('Params', (fNext) =>
				{
					// Top-level Params must be declared by a scope the request names (§22.3).
					this.fable.RetoldFacetingPlanner.checkRequestParams(tmpContext, []);
					return fNext();
				}),
				fGuard('Plan', (fNext) => { return this.fable.RetoldFacetingPlanner.planBase(tmpContext, fNext); }),
				fGuard('Execute', (pBasePlan, fNext) => { return this.stageBase(tmpContext, pBasePlan, fNext); })
			],
			(pError, pResult, pMeta) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, pResult, pMeta);
			});
	}

	/**
	 * Run a base plan for the context's Mode and compute its Version.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan - Planner.planBase result
	 * @param {(pError?: Error, pResult?: any, pMeta?: Record<string, any>) => void} fNext
	 */
	stageBase(pContext, pBasePlan, fNext)
	{
		let tmpLive = this.fable.RetoldFacetingEngineLive;
		pContext.Plan = pBasePlan;
		pContext.Cubes = [];
		let fRepaired = (pCaptures) =>
		{
			let tmpCaptures = pCaptures || {};
			return Object.keys(tmpCaptures).some((pEntity) => { return !!(tmpCaptures[pEntity] && tmpCaptures[pEntity].Repaired); });
		};
		switch (pContext.Mode)
		{
			case 'Count':
				return tmpLive.countBase(pContext, pBasePlan,
					(pError, pCount, pCountMeta) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						let tmpVersion = this.baseVersion(pContext, pBasePlan, (pCountMeta && pCountMeta.Captures) ? pCountMeta.Captures : {}, { Count: pCount });
						return fNext(null, { Count: pCount }, { Version: tmpVersion, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pCountMeta && pCountMeta.Captures), Seq: pContext.SeqAtCompute || null });
					});
			case 'Keys':
				return tmpLive.keys(pContext, pBasePlan, { Cap: pContext.NormalizedRequest.Cap },
					(pError, pKeys) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						let tmpVersion = this.baseVersion(pContext, pBasePlan, pKeys.Captures || {}, { Keys: pKeys.Keys, Count: pKeys.Count, Truncated: pKeys.Truncated });
						return fNext(null, { Entity: pContext.Entity, Keys: pKeys.Keys, Count: pKeys.Count, Truncated: (pKeys.Truncated === true), Version: tmpVersion },
							{ Version: tmpVersion, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pKeys.Captures), Seq: pContext.SeqAtCompute || null });
					});
			default:
				return this.recordsPage(pContext, pBasePlan, pContext.NormalizedRequest.Records,
					(pError, pPage) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						// The hydrated content is part of the answer: a record that changed (or was re-decorated
						// by Reads-PostOperation) without its key set changing gets a new ETag, never a stale 304.
						let tmpRecordsDigest = libCrypto.createHash('sha256').update(libFacetClauses.canonicalJSON(Array.isArray(pPage.Records) ? pPage.Records : [])).digest('hex');
						let tmpVersion = this.baseVersion(pContext, pBasePlan, pPage.Captures, { Keys: pPage.Keys, Dropped: pPage.Dropped, Page: pContext.NormalizedRequest.Records, Records: tmpRecordsDigest });
						return fNext(null, pPage.Records, { Dropped: pPage.Dropped, Version: tmpVersion, Keys: pPage.Keys, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pPage.Captures), Seq: pContext.SeqAtCompute || null });
					});
		}
	}

	/**
	 * One Records page: the ordered keys (EngineLive.recordKeys), then hydration.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {{ Begin: number, Cap: number, Sort: Array<{ Field: string, Dir: string }> }} pPage
	 * @param {(pError?: Error, pResult?: { Records: Array<Record<string, any>>, Dropped: number, Keys: Array<any>, Captures: Record<string, any> }) => void} fCallback
	 */
	recordsPage(pContext, pBasePlan, pPage, fCallback)
	{
		let tmpPage = pPage || { Begin: 0, Cap: this.options.Limits.MaxRecordsPage, Sort: [] };
		this.fable.RetoldFacetingEngineLive.recordKeys(pContext, pBasePlan, { Sort: tmpPage.Sort || [], Begin: tmpPage.Begin, Cap: tmpPage.Cap },
			(pError, pKeys) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpKeys = Array.isArray(pKeys.Keys) ? pKeys.Keys : [];
				this.hydrate(pContext, pBasePlan, tmpKeys,
					(pHydrateError, pHydrated) =>
					{
						if (pHydrateError)
						{
							return fCallback(pHydrateError);
						}
						let tmpCaptures = Object.assign({}, pKeys.Captures || {});
						if (pHydrated.Capture)
						{
							// The hydration read is captured too (its fingerprint joins the pivot's).
							let tmpExisting = tmpCaptures[pBasePlan.Pivot];
							let tmpFingerprint = (tmpExisting && tmpExisting.Fingerprint) ? `${tmpExisting.Fingerprint}+${pHydrated.Capture.Fingerprint || ''}` : (pHydrated.Capture.Fingerprint || '');
							tmpCaptures[pBasePlan.Pivot] = Object.assign({}, tmpExisting || {}, { Fingerprint: tmpFingerprint, Repaired: !!((tmpExisting && tmpExisting.Repaired) || pHydrated.Capture.Repaired) });
						}
						return fCallback(null, { Records: pHydrated.Records, Dropped: pHydrated.Dropped, Keys: tmpKeys, Captures: tmpCaptures });
					});
			});
	}

	/**
	 * Hydrate keys into records by replaying the entity's list waterfall (internal-contracts §28.3,
	 * 03 §3.8): a fresh query on the execution DAL with the Variant's column conjuncts and
	 * 'pk IN (keys)' inside the client fence, the explicit soft delete (unless the client names the
	 * delete column), the entity's own Reads-QueryConfiguration (ScopeCapture 'Inherit' + ScopeGuard;
	 * an Opaque capture is refused), doReads, then Reads-PostOperation on the route-bound controller.
	 * Records come back in key order; keys that no longer hydrate (deleted, moved tenant, changed
	 * owner since the key statement) are dropped and counted.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan - { Pivot, Variant }
	 * @param {Array<any>} pKeys
	 * @param {(pError?: Error, pResult?: { Records: Array<Record<string, any>>, Dropped: number, Capture: Record<string, any>|null }) => void} fCallback
	 */
	hydrate(pContext, pBasePlan, pKeys, fCallback)
	{
		let tmpKeys = Array.isArray(pKeys) ? pKeys : [];
		if (tmpKeys.length < 1)
		{
			return fCallback(null, { Records: [], Dropped: 0, Capture: null });
		}
		let tmpEntity = pBasePlan.Pivot;
		let tmpHost = pContext.Host;
		let tmpController = tmpHost.getRouteBoundController(tmpEntity);
		let tmpDAL = tmpHost.getExecutionDAL(tmpEntity);
		let tmpPrimaryKey = tmpHost.getPrimaryKey(tmpEntity);
		let tmpProfile = tmpHost.getDialectProfile(tmpEntity);
		if (!tmpController || !tmpController.BehaviorInjection || !tmpDAL || !tmpPrimaryKey || !tmpProfile || !tmpProfile.Name)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The records of this entity cannot be hydrated through its list.'));
		}
		let tmpVariant = pBasePlan.Variant || {};
		let tmpColumnConjuncts = Array.isArray(tmpVariant.ColumnConjuncts) ? tmpVariant.ColumnConjuncts
			: (Array.isArray(tmpVariant.Conjuncts) ? tmpVariant.Conjuncts.filter((pConjunct) => { return pConjunct.Shape !== 'Path'; }) : []);
		let tmpQuery;
		try
		{
			tmpQuery = tmpDAL.query;
			tmpQuery.setCap(0).setBegin(0);
			tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
			this.fable.RetoldFacetingFilterAST.applyToQuery(
				tmpColumnConjuncts.concat([ { Id: 'k', Shape: 'Column', Pred: { Field: tmpPrimaryKey, Op: 'IN', Value: tmpKeys } } ]),
				tmpQuery, { Dialect: tmpProfile.Name, ParameterPrefix: 'c' });
			tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			let tmpClientNamesDeleted = tmpColumnConjuncts.some((pConjunct) => { return pConjunct && (pConjunct.NamesDeleted === true); });
			if (!tmpClientNamesDeleted && tmpHost.hasDeleteColumn(tmpEntity))
			{
				tmpQuery.addFilter(tmpHost.getDeleteColumn(tmpEntity), 0, '=', 'AND', 'FacetSoftDelete');
			}
		}
		catch (pQueryError)
		{
			if (!libFacetErrors.isFacetError(pQueryError))
			{
				this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: the hydration query for ${tmpEntity} could not be built: ${pQueryError.message}`);
			}
			return fCallback(libFacetErrors.isFacetError(pQueryError) ? pQueryError : libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpCalledBack = false;
		let fDone = (pError, pResult) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			return fCallback(pError, pResult);
		};
		this.fable.RetoldFacetingScopeCapture.capture(pContext, tmpEntity, tmpQuery, 'Inherit', { Columns: [ tmpPrimaryKey ], Fresh: true },
			(pCaptureError, pCapture) =>
			{
				if (pCaptureError)
				{
					return fDone(pCaptureError);
				}
				if (!pCapture || pCapture.Opaque)
				{
					this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: refused an opaque scope capture while hydrating ${tmpEntity}.`);
					return fDone(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: tmpEntity, Reason: 'OpaqueUntrusted' }));
				}
				pContext.Counters.Statements++;
				try
				{
					tmpDAL.doReads(tmpQuery,
						(pReadError, pReadQuery, pRecords) =>
						{
							if (pReadError)
							{
								this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: the hydration read of ${tmpEntity} failed: ${(pReadError && pReadError.message) ? pReadError.message : pReadError}`);
								return fDone(libFacetErrors.create('FACET_INTERNAL'));
							}
							// The list waterfall shares ONE request state between Reads-QueryConfiguration and
							// Reads-PostOperation (meadow-endpoints Meadow-Endpoint-Reads): the capture's own
							// state (Fresh, so it is this query's), else a fresh one.
							let tmpState = pCapture.RequestState || null;
							if (!tmpState)
							{
								try
								{
									tmpState = tmpController.initializeRequestState(pContext.Request, 'Reads');
								}
								catch (pStateError)
								{
									this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: no request state for ${tmpEntity}: ${pStateError.message}`);
									return fDone(libFacetErrors.create('FACET_INTERNAL'));
								}
							}
							tmpState.Query = tmpQuery;
							tmpState.Records = Array.isArray(pRecords) ? pRecords : [];
							tmpController.BehaviorInjection.runBehavior('Reads-PostOperation', tmpController, pContext.Request, tmpState,
								(pPostError) =>
								{
									if (pPostError)
									{
										return fDone(libFacetErrors.fromBehaviorError(pPostError));
									}
									let tmpByKey = new Map();
									(Array.isArray(tmpState.Records) ? tmpState.Records : []).forEach(
										(pRecord) =>
										{
											if (pRecord && (typeof(pRecord) === 'object'))
											{
												tmpByKey.set(String(pRecord[tmpPrimaryKey]), pRecord);
											}
										});
									let tmpOrdered = [];
									tmpKeys.forEach(
										(pKey) =>
										{
											let tmpRecord = tmpByKey.get(String(pKey));
											if (tmpRecord)
											{
												tmpOrdered.push(tmpRecord);
												tmpByKey.delete(String(pKey));
											}
										});
									return fDone(null, { Records: tmpOrdered, Dropped: tmpKeys.length - tmpOrdered.length, Capture: pCapture });
								});
						});
				}
				catch (pReadThrow)
				{
					if (tmpCalledBack)
					{
						throw pReadThrow;
					}
					this.fable.log.error(`RetoldFaceting request ${pContext.RequestID}: the hydration read of ${tmpEntity} threw: ${pReadThrow.message}`);
					return fDone(libFacetErrors.create('FACET_INTERNAL'));
				}
			});
	}

	/**
	 * The weak ETag value of a Records / Count / Keys answer (internal-contracts §30.2): ModelVersion,
	 * entity, mode, the bound conjuncts, every capture fingerprint, the principal's scope values,
	 * BindHash and the answer itself (the keys or the count).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBasePlan
	 * @param {Record<string, any>} pCaptures - Entity → { Fingerprint }
	 * @param {any} pAnswer
	 * @return {string} 'fv1:' + 16 hex
	 */
	baseVersion(pContext, pBasePlan, pCaptures, pAnswer)
	{
		let tmpCaptures = pCaptures || {};
		let tmpFingerprints = Object.keys(tmpCaptures).sort().map(
			(pEntity) =>
			{
				return `${pEntity}=${(tmpCaptures[pEntity] && tmpCaptures[pEntity].Fingerprint) ? tmpCaptures[pEntity].Fingerprint : ''}`;
			});
		let tmpConjuncts = (pContext.FilterAST.Conjuncts || []).map((pConjunct) => { return { Id: pConjunct.Id, Pred: pConjunct.Pred }; });
		let tmpPrincipalScope = (pContext.Principal && pContext.Principal.ScopeValues) ? pContext.Principal.ScopeValues : {};
		let tmpMaterial = (
			[
				this.fable.RetoldFacetingCatalog.modelVersion(),
				pContext.Entity,
				pContext.Mode,
				libFacetClauses.canonicalJSON({ Scopes: pContext.NormalizedRequest.Scopes || [], Params: pContext.NormalizedRequest.Params || {} }),
				libFacetClauses.canonicalJSON(tmpConjuncts),
				tmpFingerprints.join(';'),
				libFacetClauses.canonicalJSON(tmpPrincipalScope),
				(pBasePlan && pBasePlan.BindHash) ? pBasePlan.BindHash : this.bindHash(pContext),
				libFacetClauses.canonicalJSON(pAnswer)
			]).join('|');
		return `fv1:${libCrypto.createHash('sha256').update(tmpMaterial).digest('hex').slice(0, 16)}`;
	}

	/**
	 * A fresh request context (internal-contracts §2.2, M2 additions §19.5).
	 *
	 * In-process-only overrides (never reachable from a client): ForceEngine ('Reference'),
	 * PlanForm ({ Cube, Staged }: 'Auto' | 'Always' | 'Never', defaults Execution.Cube / .Staged; the
	 * O5 tests), Now (an ISO timestamp or epoch ms pinning the request clock, so $Now / $Today bind
	 * deterministically in tests).
	 *
	 * @param {string} pEntity
	 * @param {any} pRequest
	 * @param {{ ForceEngine?: string, PlanForm?: { Cube?: string, Staged?: string }, Now?: string|number }} [pInternalOptions]
	 * @param {string} [pMode] - 'Query' (default) | 'Records' | 'Count' | 'Keys' (set by the entry point)
	 * @return {Record<string, any>}
	 */
	newContext(pEntity, pRequest, pInternalOptions, pMode)
	{
		this._RequestCounter++;
		let tmpInternal = ((typeof(pInternalOptions) === 'object') && (pInternalOptions !== null)) ? pInternalOptions : {};
		let tmpNow = Date.now();
		let tmpPinned = (typeof(tmpInternal.Now) === 'number') ? tmpInternal.Now
			: (typeof(tmpInternal.Now) === 'string') ? Date.parse(tmpInternal.Now)
			: NaN;
		let tmpClock = Number.isFinite(tmpPinned) ? tmpPinned : tmpNow;
		let tmpExecution = this.options.Execution || {};
		let fPlanForm = (pValue, pDefault) =>
		{
			return ([ 'Auto', 'Always', 'Never' ].indexOf(pValue) >= 0) ? pValue : pDefault;
		};
		let tmpPlanFormIn = ((typeof(tmpInternal.PlanForm) === 'object') && (tmpInternal.PlanForm !== null)) ? tmpInternal.PlanForm : {};
		let tmpPlanForm = (
			{
				Cube: fPlanForm(tmpPlanFormIn.Cube, fPlanForm(tmpExecution.Cube, 'Auto')),
				Staged: fPlanForm(tmpPlanFormIn.Staged, fPlanForm(tmpExecution.Staged, 'Auto'))
			});
		let tmpHeaders = (pRequest && pRequest.headers && (typeof(pRequest.headers) === 'object')) ? pRequest.headers : {};
		let tmpIfNoneMatch = tmpHeaders[IF_NONE_MATCH_HEADER];
		let tmpMode = ([ 'Records', 'Count', 'Keys' ].indexOf(pMode) >= 0) ? pMode : 'Query';
		let tmpForceEngine = (typeof(tmpInternal.ForceEngine) === 'string') ? tmpInternal.ForceEngine : null;
		// What a background refresh repeats (in-process options only; ForceEngine is never cached).
		let tmpRepeat = {};
		if ((typeof(tmpInternal.Now) === 'string') || (typeof(tmpInternal.Now) === 'number'))
		{
			tmpRepeat.Now = tmpInternal.Now;
		}
		if ((typeof(tmpInternal.PlanForm) === 'object') && (tmpInternal.PlanForm !== null))
		{
			tmpRepeat.PlanForm = Object.assign({}, tmpInternal.PlanForm);
		}
		return (
			{
				RequestID: `rfq-${String(this._RequestCounter).padStart(6, '0')}`,
				Entity: pEntity,
				Request: pRequest,
				Host: this.Host,
				Options: this.options,
				Principal: null,
				NormalizedRequest: null,
				FilterAST: null,
				Variants: null,
				Dialect: null,
				Now: new Date(tmpClock).toISOString(),
				Deadline: tmpNow + this.options.Limits.TimeoutMS,
				ForceEngine: tmpForceEngine,
				// M5 (internal-contracts §53.5): 'ClickHouse' routes every capable Agg to the store without the
				// freshness admission (tests, O3); 'Live' keeps every Agg on Live.  In-process only.
				PreferEngine: (typeof(tmpInternal.PreferEngine) === 'string') ? tmpInternal.PreferEngine : null,
				PlanForm: tmpPlanForm,
				Bind: null,
				Mode: tmpMode,
				Plan: null,
				Cubes: [],
				RecordsResult: null,
				Memo: { Relations: {}, Captures: {}, VariantRows: {} },
				Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
				Warnings: [],
				// M4 (internal-contracts §38.6)
				Freshness: null,
				IfNoneMatch: ((typeof(tmpIfNoneMatch) === 'string') && (tmpIfNoneMatch.length > 0)) ? tmpIfNoneMatch : null,
				CacheRefresh: (tmpInternal.CacheRefresh === true),
				Cache: this.newCacheState('Off', null),
				CacheDeps: null,
				// The request clock when an in-process caller pinned it (cache key material, §42.4).
				PinnedNow: Number.isFinite(tmpPinned) ? new Date(tmpPinned).toISOString() : null,
				InternalOptions: tmpRepeat,
				// The Seq an answer covers: read before anything executes (Records / Count / Keys here; a
				// Query re-reads it at its Cache stage, §44.8).
				SeqAtCompute: this.currentSeq(),
				RequestBody: null,
				// The ModelVersion this request is planned under (cache key material; a reload before
				// the Cache stage makes the answer uncacheable, 'ModelReload').
				ModelVersion: this.fable.RetoldFacetingCatalog ? this.fable.RetoldFacetingCatalog.modelVersion() : null,
				// Armed by the Cache stage of a cacheable request: every execution scope capture (§42.8).
				ScopeLog: null,
				// M5 (internal-contracts §53.5): the store routing of a Query once a store is registered (the
				// Router fills Prefer / Decisions / Fallback / Statements); null otherwise.
				Store: (this.storeRegistered() && (tmpMode === 'Query') && !tmpForceEngine)
					? { Name: 'ClickHouse', Prefer: 'Auto', Decisions: {}, Fallback: null, Statements: 0 }
					: null
			});
	}

	/**
	 * Describe (02 §7) for a principal: every facetable entity it can read, or one.  Entities (and
	 * FK Targets) the Authorizer would refuse are omitted (06 §5.2 / §11).
	 *
	 * @param {string|null} pEntity
	 * @param {Record<string, any>} pPrincipal
	 * @param {Record<string, any>} [pContext] - request context (Host, Principal, Options) for canRead
	 * @return {Record<string, any>}
	 */
	describe(pEntity, pPrincipal, pContext)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpContext = pContext || { Host: this.Host, Principal: pPrincipal, Options: this.options };
		let fCanRead = (pTarget) =>
		{
			return !!this.Host && this.fable.RetoldFacetingAuthorizer.canRead(tmpContext, pTarget);
		};
		let tmpEntities = tmpCatalog.entities();
		let tmpDialectEntity = ((typeof(pEntity) === 'string') && (pEntity.length > 0)) ? pEntity : (tmpEntities.length > 0 ? tmpEntities[0] : null);
		let tmpProfile = (tmpDialectEntity && this.Host) ? this.Host.getDialectProfile(tmpDialectEntity) : null;
		let tmpLimits = this.options.Limits;
		let tmpDescribe = (
			{
				ContractVersion: libFacetRequest.CONTRACT_VERSION,
				ModelVersion: tmpCatalog.modelVersion(),
				Role: this.options.Role,
				ScopeAssurance: this.Host ? this.Host.scopeAssurance() : 'Unscoped',
				TimeZones: [ this.options.Time.StorageTimeZone ],
				Limits:
					{
						MaxFacets: tmpLimits.MaxFacets,
						MaxTop: tmpLimits.MaxTop,
						MaxBuckets: tmpLimits.MaxBuckets,
						MaxDateBuckets: tmpLimits.MaxDateBuckets,
						MaxHops: tmpLimits.MaxHops,
						TimeoutMS: tmpLimits.TimeoutMS
					},
				Freshness: { DefaultMode: this.options.Freshness.DefaultMode, MaxLagMS: this.options.Freshness.MaxLagMS, ReadYourWritesMS: this.options.Freshness.ReadYourWritesMS },
				Engines: { Live: { Available: this._Attached, Dialect: (tmpProfile && tmpProfile.Name) ? tmpProfile.Name : null }, ClickHouse: this.describeStoreEngine(fCanRead, this.describeStoreDetail(tmpContext)) },
				// M4 (internal-contracts §44.9): whether answers are cached (and 304 without executing), the
				// change source, and the change stream a client subscribes to.
				Cache: { Enabled: this.cacheEnabled() },
				Changes: this.changesDescribe(),
				Entities: {}
			});
		// 06 §3.5: an entity whose read-side Pre/PostOperation behavior is not vouched for
		// (Scope.TrustPostOperation) is Opaque for facets; Describe says why, and which columns
		// (Scope.PostOperationSafeColumns) a facet may still read.
		let fOpaque = (pTarget, pBlock) =>
		{
			let tmpCapture = this.fable.RetoldFacetingScopeCapture;
			let tmpController = (this.Host && (typeof(this.Host.getRouteBoundController) === 'function')) ? this.Host.getRouteBoundController(pTarget) : null;
			let tmpAudit = (tmpCapture && tmpController) ? tmpCapture.postOperationAudit(tmpContext, pTarget, tmpController, null) : null;
			if (tmpAudit && tmpAudit.Opaque)
			{
				pBlock.Opaque = { Reason: libRetoldFacetingScopeCapture.POST_OPERATION_REASON, SafeColumns: Array.isArray(tmpAudit.SafeColumns) ? tmpAudit.SafeColumns.slice() : null };
			}
			return pBlock;
		};
		if ((typeof(pEntity) === 'string') && (pEntity.length > 0))
		{
			let tmpBlock = fCanRead(pEntity) ? tmpCatalog.describe(pEntity, pPrincipal, fCanRead) : null;
			if (!tmpBlock)
			{
				throw libFacetErrors.create('FACET_UNKNOWN_ENTITY');
			}
			tmpDescribe.Entity = pEntity;
			tmpDescribe.Entities[pEntity] = this.describeEntityStore(pEntity, fOpaque(pEntity, tmpBlock), this.describeStoreDetail(tmpContext));
			return tmpDescribe;
		}
		let tmpDetail = this.describeStoreDetail(tmpContext);
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpBlock = fCanRead(tmpEntities[i]) ? tmpCatalog.describe(tmpEntities[i], pPrincipal, fCanRead) : null;
			if (tmpBlock)
			{
				tmpDescribe.Entities[tmpEntities[i]] = this.describeEntityStore(tmpEntities[i], fOpaque(tmpEntities[i], tmpBlock), tmpDetail);
			}
		}
		return tmpDescribe;
	}

	/**
	 * Describe's Engines.ClickHouse (internal-contracts §62.5): { Configured, Available, Reason, Entities:
	 * { E: { State, LagMS, Exact } } } over the mirrored entities the principal can read; { Available:
	 * false, Configured: false } without a store section.
	 *
	 * @param {(pEntity: string) => boolean} fCanRead
	 * @return {Record<string, any>}
	 */
	describeStoreEngine(fCanRead, pDetail)
	{
		let tmpAvailability = this.storeAvailability();
		if (!tmpAvailability.Configured)
		{
			return { Available: false, Configured: false };
		}
		if (pDetail !== true)
		{
			// Per-entity State / LagMS (other tenants' write activity) and the infrastructure reason
			// (Unreachable, AuthenticationFailed, SchemaError, …) go to admins and freshness-exposing hosts only.
			return { Configured: true, Available: tmpAvailability.Available };
		}
		let tmpEntities = {};
		let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
		let tmpFreshness = this.fable.RetoldFacetingFreshness;
		let tmpMirrored = (tmpMirrorSpec && (typeof(tmpMirrorSpec.entities) === 'function')) ? tmpMirrorSpec.entities('ClickHouse') : [];
		let tmpNow = Date.now();
		(Array.isArray(tmpMirrored) ? tmpMirrored : []).forEach(
			(pEntity) =>
			{
				if (!fCanRead(pEntity) || !tmpFreshness)
				{
					return;
				}
				let tmpEntity = tmpFreshness.entityFreshness('ClickHouse', pEntity, tmpNow);
				tmpEntities[pEntity] = { State: tmpEntity.State, LagMS: Number.isFinite(tmpEntity.LagMS) ? tmpEntity.LagMS : null, Exact: (tmpEntity.Exact === true) };
			});
		return { Configured: true, Available: tmpAvailability.Available, Reason: tmpAvailability.Reason, Entities: tmpEntities };
	}

	/**
	 * Add the store view to an entity's Describe block (internal-contracts §62.5), only when a store is
	 * configured: Store.ClickHouse = { Materialized, State, Reason: null | 'NotDeclared' | 'Disabled' |
	 * 'LossyColumn:<C>', Watermark }, and Engines [ 'Live', 'ClickHouse' ] on every facet descriptor whose
	 * entities (and, for an entity's own column facet, that column) are mirrored.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBlock - the Catalog's Describe block
	 * @return {Record<string, any>} pBlock
	 */
	describeEntityStore(pEntity, pBlock, pDetail)
	{
		if (!this.storeAvailability().Configured || !pBlock)
		{
			return pBlock;
		}
		let tmpDetail = (pDetail === true);
		let tmpMirrorSpec = this.fable.RetoldFacetingMirrorSpec;
		let fSpec = (pTarget) =>
		{
			return (tmpMirrorSpec && (typeof(tmpMirrorSpec.spec) === 'function')) ? tmpMirrorSpec.spec('ClickHouse', pTarget) : null;
		};
		let tmpSpec = fSpec(pEntity);
		let tmpReason = null;
		let tmpState = 'Absent';
		if (!tmpSpec)
		{
			let tmpDisabled = (tmpMirrorSpec && (typeof(tmpMirrorSpec.disabled) === 'function')) ? tmpMirrorSpec.disabled() : [];
			tmpReason = (Array.isArray(tmpDisabled) && tmpDisabled.some((pEntry) => { return pEntry && (pEntry.Entity === pEntity) && ((pEntry.Store === 'ClickHouse') || !pEntry.Store); })) ? 'Disabled' : 'NotDeclared';
		}
		else
		{
			let tmpFreshness = this.fable.RetoldFacetingFreshness;
			tmpState = tmpFreshness ? tmpFreshness.entityFreshness('ClickHouse', pEntity, Date.now()).State : 'Absent';
			let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
			let tmpInfo = (tmpMaterializer && (typeof(tmpMaterializer.entityInfo) === 'function')) ? tmpMaterializer.entityInfo('ClickHouse', pEntity) : null;
			let tmpLossy = (tmpInfo && tmpInfo.Lossy && (typeof(tmpInfo.Lossy) === 'object')) ? tmpInfo.Lossy : {};
			let tmpLossyColumn = Object.keys(tmpLossy).sort().find((pColumn) => { return tmpLossy[pColumn] === 'Value'; });
			if (tmpLossyColumn)
			{
				// The column name says another tenant holds such a value: the class only, unless detailed.
				tmpReason = (tmpDetail && this.storeExposeReasons()) ? `LossyColumn:${tmpLossyColumn}` : 'LossyColumn';
			}
		}
		pBlock.Store = { ClickHouse: { Materialized: !!tmpSpec, Reason: tmpReason, Watermark: (tmpSpec && tmpSpec.Watermark) ? tmpSpec.Watermark : null } };
		if (tmpDetail)
		{
			pBlock.Store.ClickHouse.State = tmpState;
		}
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		(Array.isArray(pBlock.Facets) ? pBlock.Facets : []).forEach(
			(pDescriptor) =>
			{
				let tmpMirrored = false;
				if ((pDescriptor.Auto === true) && !Array.isArray(pDescriptor.Path) && (typeof(pDescriptor.Field) === 'string'))
				{
					tmpMirrored = !!tmpSpec && Array.isArray(tmpSpec.ColumnNames) && (tmpSpec.ColumnNames.indexOf(pDescriptor.Field) >= 0);
				}
				else if (tmpRegistry && (typeof(tmpRegistry.resolveFacet) === 'function'))
				{
					let tmpFacet = null;
					try
					{
						tmpFacet = tmpRegistry.resolveFacet(pDescriptor.Facet);
					}
					catch (pResolveError)
					{
						tmpFacet = null;
					}
					let tmpEntities = (tmpFacet && Array.isArray(tmpFacet.Entities)) ? tmpFacet.Entities : [];
					tmpMirrored = (tmpEntities.length > 0) && tmpEntities.every((pTarget) => { return !!fSpec(pTarget); });
				}
				if (tmpMirrored)
				{
					pDescriptor.Engines = [ 'Live', 'ClickHouse' ];
				}
			});
		return pBlock;
	}

	/**
	 * May this Describe see the store's per-entity state (State, LagMS, Exact) and infrastructure
	 * reasons?  On a host that exposes freshness, everyone; otherwise only a principal that passes
	 * Admin.authorize(pRequest, pPrincipal) === true.
	 *
	 * @param {Record<string, any>} pContext
	 * @return {boolean}
	 */
	describeStoreDetail(pContext)
	{
		if (this.storeExposeFreshness())
		{
			return true;
		}
		let tmpAuthorize = (this.options.Admin && (typeof(this.options.Admin.authorize) === 'function')) ? this.options.Admin.authorize : null;
		if (!tmpAuthorize || !pContext || !pContext.Request || !pContext.Principal)
		{
			return false;
		}
		try
		{
			return tmpAuthorize(pContext.Request, pContext.Principal) === true;
		}
		catch (pError)
		{
			return false;
		}
	}

	/**
	 * Describe for an HTTP request (resolves the principal first; an entity the principal cannot
	 * facet is 404, exactly like a query).
	 *
	 * @param {string|null} pEntity
	 * @param {any} pRequest
	 * @param {(pError?: Error, pDescribe?: Record<string, any>) => void} fCallback
	 */
	describeRequest(pEntity, pRequest, fCallback)
	{
		if (!this._Attached || !this.Host)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The faceting service is not attached to a host.'));
		}
		let tmpEntity = ((typeof(pEntity) === 'string') && (pEntity.length > 0)) ? pEntity : null;
		let tmpRequest = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? pRequest : { params: {}, headers: {}, query: {} };
		let tmpContext = this.newContext(tmpEntity, tmpRequest, {});
		let fDescribe = () =>
		{
			let tmpResult = null;
			let tmpError = null;
			try
			{
				tmpResult = this.describe(tmpEntity, tmpContext.Principal, tmpContext);
			}
			catch (pDescribeError)
			{
				tmpError = this.stageError(tmpContext, 'Describe', pDescribeError);
			}
			return tmpError ? fCallback(tmpError) : fCallback(null, tmpResult);
		};
		this.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext,
			(pPrincipalError, pPrincipal) =>
			{
				if (pPrincipalError)
				{
					return fCallback(pPrincipalError);
				}
				tmpContext.Principal = pPrincipal;
				if (!tmpEntity)
				{
					return fDescribe();
				}
				this.fable.RetoldFacetingAuthorizer.check(tmpContext, [ tmpEntity ],
					(pGateError) =>
					{
						if (pGateError)
						{
							return fCallback(pGateError);
						}
						return fDescribe();
					});
			});
	}

	/**
	 * Engine availability summary (no tenant data).
	 *
	 * @return {Record<string, any>}
	 */
	status()
	{
		let fStats = (pService) =>
		{
			return (pService && (typeof(pService.stats) === 'function')) ? pService.stats() : null;
		};
		return (
			{
				Role: this.options.Role,
				Attached: this._Attached,
				ModelVersion: this.fable.RetoldFacetingCatalog ? this.fable.RetoldFacetingCatalog.modelVersion() : null,
				Engines: { Live: { Available: this._Attached }, ClickHouse: this.storeAvailability() },
				// M4 (internal-contracts §44.9): counters only, never tenant data.
				Cache: Object.assign({ Enabled: this.cacheEnabled() }, fStats(this.fable.RetoldFacetingResultCache) || {}),
				Generations: fStats(this.fable.RetoldFacetingGenerations),
				Changes: fStats(this.fable.RetoldFacetingChangeIntake),
				SSE: fStats(this.fable.RetoldFacetingSSE),
				ReadYourWrites: fStats(this.fable.RetoldFacetingReadYourWrites),
				// M5 (internal-contracts §62.5)
				Stores: (this.fable.RetoldFacetingMaterializer && this._StoreInstall.Configured) ? this.fable.RetoldFacetingMaterializer.status() : { Stores: {} },
				Freshness: fStats(this.fable.RetoldFacetingFreshness),
				StoreClickHouse: this.fable.RetoldFacetingStoreClickHouse ? this.fable.RetoldFacetingStoreClickHouse.status() : null
			});
	}

	/**
	 * Describe's Changes block (internal-contracts §44.9): the installed change source and the change
	 * stream route (null when SSE is off).
	 *
	 * @return {{ Intake: string, Stream: string|null }}
	 */
	changesDescribe()
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpSSE = this.fable.RetoldFacetingSSE;
		let tmpStream = (tmpSSE && (typeof(tmpSSE.enabled) === 'function')) ? tmpSSE.enabled() : !!(this.options.SSE && (this.options.SSE.Enabled === true));
		return (
			{
				Intake: tmpIntake ? tmpIntake._Source : 'None',
				Stream: tmpStream ? `${this.options.RoutePrefix}/Changes` : null
			});
	}
}

module.exports = RetoldFacetingService;
module.exports.serviceType = 'RetoldFacetingService';
module.exports.Options = libOptions;
module.exports.SUB_SERVICES = SUB_SERVICES;
module.exports.TOTAL_KEY = TOTAL_KEY;
module.exports.CACHE_STATUSES = CACHE_STATUSES;
module.exports.SHUTDOWN_MARKER = SHUTDOWN_MARKER;
module.exports.installOnRetoldDataService = (pRetoldDataService, pOptions, fCallback) =>
{
	// Late require: the installers module requires this one.
	return require('./Retold-Faceting-Installers.js').installOnRetoldDataService(pRetoldDataService, pOptions, fCallback);
};
// Part V (internal-contracts §73.1): the RAFS boot steps, re-exported so an app calls them from the package
// root (design 07 §3.1).  Late require, as above.
module.exports.foundationHookInstaller = (pServer, pOptions, fStep) =>
{
	return require('./Retold-Faceting-Installers.js').foundationHookInstaller(pServer, pOptions, fStep);
};
module.exports.foundationRouteInstaller = (pServer, pOptions, fStep) =>
{
	return require('./Retold-Faceting-Installers.js').foundationRouteInstaller(pServer, pOptions, fStep);
};
