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
const libRetoldFacetingUtil = require('./Retold-Faceting-Util.js');

// Every sub-service, in registration order: [ serviceType, class ].
const SUB_SERVICES = (
	[
		[ 'RetoldFacetingHostDataService', libRetoldFacetingHostDataService ],
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
		[ 'RetoldFacetingRouter', libRetoldFacetingRouter ],
		[ 'RetoldFacetingRoutes', libRetoldFacetingRoutes ]
	]);

// The Agg Key of the envelope Total (internal-contracts §5.1); the Planner owns it.
const TOTAL_KEY = libRetoldFacetingPlanner.TOTAL_KEY;

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
		this._RequestCounter = 0;
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
	 * Attach to a host (design 07 §2.2): register services, bind the host, refuse reserved entity
	 * names, build the catalog, mount the routes.
	 *
	 * @param {{ RetoldDataService: any }} pAttachOptions
	 * @param {(pError?: Error) => void} fCallback
	 */
	attach(pAttachOptions, fCallback)
	{
		if (this._Attached)
		{
			return fCallback();
		}
		this.registerServices();
		this.Host = this.fable.RetoldFacetingHostDataService;
		let tmpRetoldDataService = (pAttachOptions && pAttachOptions.RetoldDataService) ? pAttachOptions.RetoldDataService : this.fable.RetoldDataService;

		this.Host.bind(tmpRetoldDataService,
			(pBindError) =>
			{
				if (pBindError)
				{
					return fCallback(pBindError);
				}
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
				// D-31: a host model reload rebuilds the graph, the catalog and the definitions (same sources;
				// the previous catalog stays on failure).
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
						}
					});
				this.fable.RetoldFacetingRoutes.connect(this.Host.getServiceServer());
				this._Attached = true;
				return fCallback();
			});
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
	 * The pipeline (internal-contracts §2), as a waterfall of the stage methods below.
	 * pInternalOptions.ForceEngine === 'Reference' runs the O1 oracle; it is never reachable from a
	 * client.
	 *
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @param {any} pRequest
	 * @param {{ ForceEngine?: string }} pInternalOptions
	 * @param {(pError?: Error, pEnvelope?: Record<string, any>, pMeta?: { Version: string, Engine: string, ScopeRepaired: boolean, Statements: number, Relations: number, BehaviorRuns: number, Variants: number }) => void} fCallback
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
		let fGuard = this.stageGuard(tmpContext);

		this.fable.Utility.waterfall(
			[
				fGuard('Principal', (fNext) => { return this.stagePrincipal(tmpContext, fNext); }),
				fGuard('Shape', (fNext) => { return this.stageShape(tmpContext, pBody, tmpStart, fNext); }),
				fGuard('Gate', (fNext) => { return this.stageGate(tmpContext, fNext); }),
				fGuard('Bind', (fNext) => { return this.stageBind(tmpContext, fNext); }),
				fGuard('Filter', (fNext) => { return this.stageFilter(tmpContext, fNext); }),
				fGuard('Plan', (fNext) => { return this.stagePlan(tmpContext, fNext); }),
				fGuard('Execute', (pPlan, fNext) => { return this.stageExecute(tmpContext, pPlan, fNext); }),
				fGuard('Records', (pPlan, pExecution, fNext) => { return this.stageRecords(tmpContext, pPlan, pExecution, fNext); }),
				fGuard('Post', (pPlan, pExecution, fNext) => { return this.postProcess(tmpContext, pPlan, pExecution, tmpStart, fNext); })
			],
			(pError, pEnvelope, pMeta) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, pEnvelope, pMeta);
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
		let tmpTimeoutMS = this.options.Limits.TimeoutMS;
		if ((typeof(pContext.NormalizedRequest.TimeoutMS) === 'number') && (pContext.NormalizedRequest.TimeoutMS > 0))
		{
			tmpTimeoutMS = Math.min(tmpTimeoutMS, pContext.NormalizedRequest.TimeoutMS);
		}
		pContext.Deadline = pStart + tmpTimeoutMS;
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
			try
			{
				tmpFacets[tmpKey] = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, Object.assign({}, tmpPostBase, { OwnedConjuncts: tmpOwned, DisplayName: tmpAgg.DisplayName }));
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
				let tmpEnvelope = libFacetEnvelope.buildEnvelope(
					{
						Records: tmpRecords ? tmpRecords.Records : undefined,
						RecordShape: tmpRecords ? 'Entity' : undefined,
						RecordsDropped: tmpRecords ? tmpRecords.Dropped : undefined,
						Entity: pContext.Entity,
						Version: null,
						ModelVersion: this.fable.RetoldFacetingCatalog.modelVersion(),
						Engine: pExecution.Engine,
						Exact: (pExecution.Exact !== false),
						AsOf: pExecution.AsOf || pContext.Now,
						ElapsedMS: Date.now() - pStart,
						Total: (tmpTotal === null) ? undefined : tmpTotal,
						IncludesDeleted: (pContext.FilterAST.IncludesDeleted === true),
						FilterAST: pContext.FilterAST,
						Facets: tmpFacets,
						Errors: tmpErrors,
						Warnings: pContext.Warnings.concat(Array.isArray(tmpRequest.Warnings) ? tmpRequest.Warnings : [])
					});
				let tmpFailure = libFacetEnvelope.requestFailure(tmpEnvelope, tmpRequest.Total !== false);
				if (tmpFailure)
				{
					return fCallback(libFacetErrors.create(tmpFailure.Code, tmpFailure.Message, tmpFailure.Detail));
				}
				let tmpVersion = this.version(pContext, pExecution, tmpEnvelope);
				tmpEnvelope.Version = tmpVersion;
				let tmpCaptures = pExecution.Captures || {};
				let tmpRepaired = Object.keys(tmpCaptures).some((pEntity) => { return !!(tmpCaptures[pEntity] && tmpCaptures[pEntity].Repaired); });
				return fCallback(null, tmpEnvelope,
					{
						Version: tmpVersion,
						Engine: pExecution.Engine,
						ScopeRepaired: tmpRepaired,
						// Every SQL statement the request ran (facets, staged key sets, label reads, the Records
						// keys and hydration); Labels counts the label reads among them.
						Statements: pContext.Counters.Statements || 0,
						Labels: pContext.Counters.Labels || 0,
						Relations: pContext.Counters.Relations,
						BehaviorRuns: pContext.Counters.BehaviorRuns,
						Variants: Object.keys(pContext.Variants || {}).length,
						Cubes: Array.isArray(pPlan.Cubes) ? pPlan.Cubes.length : 0,
						CubeFallbacks: Array.isArray(pExecution.CubeFallbacks) ? pExecution.CubeFallbacks.slice() : [],
						Staged: pExecution.Staged || { Relations: 0, Keys: 0 },
						BindHash: pPlan.BindHash || null,
						RecordsDropped: tmpRecords ? tmpRecords.Dropped : 0
					});
			});
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
						return fNext(null, { Count: pCount }, { Version: tmpVersion, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pCountMeta && pCountMeta.Captures) });
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
							{ Version: tmpVersion, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pKeys.Captures) });
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
						return fNext(null, pPage.Records, { Dropped: pPage.Dropped, Version: tmpVersion, Keys: pPage.Keys, Statements: pContext.Counters.Statements, ScopeRepaired: fRepaired(pPage.Captures) });
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
				ForceEngine: (typeof(tmpInternal.ForceEngine) === 'string') ? tmpInternal.ForceEngine : null,
				PlanForm: tmpPlanForm,
				Bind: null,
				Mode: ([ 'Records', 'Count', 'Keys' ].indexOf(pMode) >= 0) ? pMode : 'Query',
				Plan: null,
				Cubes: [],
				RecordsResult: null,
				Memo: { Relations: {}, Captures: {}, VariantRows: {} },
				Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
				Warnings: []
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
				Freshness: { DefaultMode: this.options.Freshness.DefaultMode, MaxLagMS: this.options.Freshness.MaxLagMS },
				Engines: { Live: { Available: this._Attached, Dialect: (tmpProfile && tmpProfile.Name) ? tmpProfile.Name : null } },
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
			tmpDescribe.Entities[pEntity] = fOpaque(pEntity, tmpBlock);
			return tmpDescribe;
		}
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpBlock = fCanRead(tmpEntities[i]) ? tmpCatalog.describe(tmpEntities[i], pPrincipal, fCanRead) : null;
			if (tmpBlock)
			{
				tmpDescribe.Entities[tmpEntities[i]] = fOpaque(tmpEntities[i], tmpBlock);
			}
		}
		return tmpDescribe;
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
		return (
			{
				Role: this.options.Role,
				Attached: this._Attached,
				ModelVersion: this.fable.RetoldFacetingCatalog ? this.fable.RetoldFacetingCatalog.modelVersion() : null,
				Engines: { Live: { Available: this._Attached } }
			});
	}
}

module.exports = RetoldFacetingService;
module.exports.serviceType = 'RetoldFacetingService';
module.exports.Options = libOptions;
module.exports.SUB_SERVICES = SUB_SERVICES;
module.exports.TOTAL_KEY = TOTAL_KEY;
module.exports.installOnRetoldDataService = (pRetoldDataService, pOptions, fCallback) =>
{
	// Late require: the installers module requires this one.
	return require('./Retold-Faceting-Installers.js').installOnRetoldDataService(pRetoldDataService, pOptions, fCallback);
};
