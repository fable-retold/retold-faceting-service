/**
 * Retold Faceting - Host: plain retold-data-service (Embedded role)
 *
 * Binds to a RetoldDataService instance: fable.DAL, fable.MeadowEndpoints, fullModel and the
 * Orator service server (design 07 §2.2).  Snapshots the ROUTE-BOUND controller of every entity
 * at bind() time, because an RDS model reload replaces fable.MeadowEndpoints[E] (and fable.DAL[E])
 * but leaves the routes bound to the old controller (D-31; RDS skips connectRoutes for entities
 * whose routes already exist, Retold-Data-Service-MeadowEndpoints.js loadModel).
 *
 * Model reloads are observed by wrapping the RDS model loader (interim onModelChanged until the
 * RDS-2 ModelLoaded event exists): entities that already had routes keep their captured
 * controller, entities seen for the first time take the new one, then listeners are notified.
 * Execution, the dialect, the delete column and the primary key all come from the route-bound
 * controller's DAL (the DAL the list reads through), so they never drift from the list.
 *
 * Contract: internal-contracts §12.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libRetoldFacetingHostBase = require('./Retold-Faceting-Host-Base.js');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingGraph = require('../catalog/Retold-Faceting-Graph.js');

// Marker on a wrapped loadModel function (so a re-bind never double-wraps).
const LOAD_MODEL_WRAP_MARKER = '__RetoldFacetingLoadModelWrap';

const hasOwn = libRetoldFacetingHostBase.hasOwn;
const isPlainObject = libRetoldFacetingHostBase.isPlainObject;

class RetoldFacetingHostDataService extends libRetoldFacetingHostBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (resolved by the base)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingHostDataService';

		// The RetoldDataService instance (set by bind)
		this._RetoldDataService = null;
		// Entity → controller the CRUD routes are bound to (snapshot; D-31)
		this._RouteBoundControllers = {};
		// Entity → the meadow-endpoints object those routes came from (for its enabled behavior sets)
		this._RouteBoundEndpoints = {};
		this._Bound = false;
		// True when the host runs header-asserted sessions under Scope.AllowHeaderSession ('Spoofable')
		this._HeaderSession = false;
		// Cached normalized scope policy (invalidated on model change)
		this._ScopePolicy = null;
	}

	getHostKind()
	{
		return 'DataService';
	}

	/**
	 * @return {boolean}
	 */
	isBound()
	{
		return this._Bound;
	}

	/**
	 * The fable that owns the RDS objects (the RDS's fable once bound; normally the same as this.fable).
	 *
	 * @return {any}
	 */
	_hostFable()
	{
		if (this._RetoldDataService && this._RetoldDataService.fable)
		{
			return this._RetoldDataService.fable;
		}
		return this.fable;
	}

	/**
	 * The fable.DAL map (the RDS mutates this same object on every loadModel).
	 *
	 * @return {Record<string, any>}
	 */
	_dalMap()
	{
		let tmpFable = this._hostFable();
		return (tmpFable && isPlainObject(tmpFable.DAL)) ? tmpFable.DAL : {};
	}

	/**
	 * The fable.MeadowEndpoints map.
	 *
	 * @return {Record<string, any>}
	 */
	_endpointsMap()
	{
		let tmpFable = this._hostFable();
		return (tmpFable && isPlainObject(tmpFable.MeadowEndpoints)) ? tmpFable.MeadowEndpoints : {};
	}

	/**
	 * Capture the route-bound controller of every entity that does not have one captured yet.
	 * Existing captures are never replaced (D-31).
	 *
	 * @return {Array<string>} the entities captured by this call
	 */
	_captureRouteBoundControllers()
	{
		let tmpEndpoints = this._endpointsMap();
		let tmpCaptured = [];
		let tmpEntities = Object.keys(tmpEndpoints);
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			if (hasOwn(this._RouteBoundControllers, tmpEntity))
			{
				continue;
			}
			let tmpEndpoint = tmpEndpoints[tmpEntity];
			if (!tmpEndpoint || (typeof(tmpEndpoint) !== 'object') || !tmpEndpoint.controller)
			{
				continue;
			}
			this._RouteBoundControllers[tmpEntity] = tmpEndpoint.controller;
			this._RouteBoundEndpoints[tmpEntity] = tmpEndpoint;
			tmpCaptured.push(tmpEntity);
		}
		return tmpCaptured;
	}

	/**
	 * The meadow-endpoints session data source configured for the routes ('Request' by default).
	 *
	 * @return {string}
	 */
	getSessionDataSource()
	{
		let tmpFable = this._hostFable();
		let tmpSources = [];
		if (tmpFable && tmpFable.settings && (typeof(tmpFable.settings.MeadowEndpointsSessionDataSource) === 'string'))
		{
			tmpSources.push(tmpFable.settings.MeadowEndpointsSessionDataSource);
		}
		let tmpEntities = Object.keys(this._RouteBoundControllers);
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpSettings = this._RouteBoundControllers[tmpEntities[i]].settings;
			if (tmpSettings && (typeof(tmpSettings.MeadowEndpointsSessionDataSource) === 'string'))
			{
				tmpSources.push(tmpSettings.MeadowEndpointsSessionDataSource);
			}
		}
		// Any controller trusting a header makes the whole host header-sourced (06 §2.2).
		if (tmpSources.indexOf('Header') >= 0)
		{
			return 'Header';
		}
		return (tmpSources.length > 0) ? tmpSources[0] : 'Request';
	}

	/**
	 * Wrap the RDS model loader so reloads capture new controllers and notify onModelChanged
	 * listeners.  Wraps the RetoldDataServiceMeadowEndpoints service when present (both
	 * RDS.loadModel and loadModelFromFile funnel into it), else RDS.loadModel itself.
	 *
	 * @param {any} pRetoldDataService
	 */
	_wrapModelLoader(pRetoldDataService)
	{
		let tmpFable = pRetoldDataService.fable;
		let tmpTarget = (tmpFable && tmpFable.RetoldDataServiceMeadowEndpoints && (typeof(tmpFable.RetoldDataServiceMeadowEndpoints.loadModel) === 'function'))
			? tmpFable.RetoldDataServiceMeadowEndpoints
			: pRetoldDataService;
		if (typeof(tmpTarget.loadModel) !== 'function')
		{
			this.fable.log.warn('RetoldFaceting host: the RetoldDataService has no loadModel; model reloads will not rebuild the catalog.');
			return;
		}
		let fOriginal = tmpTarget.loadModel;
		// Other hosts may have wrapped after this one: walk the whole chain before wrapping again.
		for (let fLink = fOriginal; (typeof(fLink) === 'function') && fLink[LOAD_MODEL_WRAP_MARKER]; fLink = fLink[LOAD_MODEL_WRAP_MARKER].Original)
		{
			if (fLink[LOAD_MODEL_WRAP_MARKER].Host === this)
			{
				return;
			}
		}
		let tmpHost = this;
		let fWrapped = function (...pArguments)
		{
			let tmpCallbackIndex = -1;
			for (let i = pArguments.length - 1; i >= 0; i--)
			{
				if (typeof(pArguments[i]) === 'function')
				{
					tmpCallbackIndex = i;
					break;
				}
			}
			let fOriginalCallback = (tmpCallbackIndex >= 0) ? pArguments[tmpCallbackIndex] : null;
			let fAfterLoad = function (pError, ...pRest)
			{
				if (!pError)
				{
					tmpHost._onHostModelLoaded();
				}
				if (fOriginalCallback)
				{
					return fOriginalCallback.call(this, pError, ...pRest);
				}
			};
			if (tmpCallbackIndex >= 0)
			{
				pArguments[tmpCallbackIndex] = fAfterLoad;
			}
			else
			{
				pArguments.push(fAfterLoad);
			}
			return fOriginal.apply(this, pArguments);
		};
		fWrapped[LOAD_MODEL_WRAP_MARKER] = { Host: this, Original: fOriginal };
		tmpTarget.loadModel = fWrapped;
	}

	/**
	 * After the host loaded (or reloaded) a model: capture controllers for new entities, drop the
	 * cached policy (isScoped depends on model columns), notify listeners.
	 */
	_onHostModelLoaded()
	{
		let tmpCaptured = this._captureRouteBoundControllers();
		this._ScopePolicy = null;
		if (tmpCaptured.length > 0)
		{
			this.fable.log.info(`RetoldFaceting host: captured route-bound controllers for [${tmpCaptured.join(', ')}] after a model load.`);
		}
		this.notifyModelChanged(this.getModelSync());
	}

	/**
	 * Bind to a RetoldDataService: capture DAL / MeadowEndpoints references, snapshot route-bound
	 * controllers, wrap loadModel for onModelChanged, refuse header-sourced sessions (06 §2.2) and
	 * mis-configured scope policies.
	 *
	 * @param {any} pRetoldDataService
	 * @param {(pError?: Error) => void} fCallback
	 */
	bind(pRetoldDataService, fCallback)
	{
		if (!pRetoldDataService || (typeof(pRetoldDataService) !== 'object') || !pRetoldDataService.fable)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostDataService.bind needs a RetoldDataService instance.'));
		}
		if (this._Bound && (this._RetoldDataService !== pRetoldDataService))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostDataService is already bound to a different RetoldDataService.'));
		}

		let tmpScopeProblems = this.validateScopeConfiguration(this.options.Scope);
		if (tmpScopeProblems.length > 0)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting scope configuration is invalid: ${tmpScopeProblems.join(' ')}`));
		}

		this._RetoldDataService = pRetoldDataService;
		this._ScopePolicy = null;
		this._captureRouteBoundControllers();

		// Header-asserted sessions let any caller pick their tenant (06 §2.2): refuse unless allowed.
		if (this.getSessionDataSource() === 'Header')
		{
			if (this.options.Scope.AllowHeaderSession !== true)
			{
				this._RetoldDataService = null;
				this._RouteBoundControllers = {};
				this._RouteBoundEndpoints = {};
				this._Bound = false;
				return fCallback(libFacetErrors.create('FACET_INTERNAL', `Embedded faceting is refused on a host whose MeadowEndpointsSessionDataSource is 'Header' (callers could assert any session); set RetoldFaceting.Scope.AllowHeaderSession to accept it (ScopeAssurance 'Spoofable').`));
			}
			this._HeaderSession = true;
			this.fable.log.warn(`RetoldFaceting host: header-sourced sessions are allowed (Scope.AllowHeaderSession); ScopeAssurance is 'Spoofable'.`);
		}

		this._wrapModelLoader(pRetoldDataService);

		let tmpControllerless = isPlainObject(this.options.Catalog.Controllerless) ? Object.keys(this.options.Catalog.Controllerless) : [];
		if (tmpControllerless.length > 0)
		{
			this.fable.log.warn(`RetoldFaceting host: Catalog.Controllerless declarations [${tmpControllerless.join(', ')}] are not supported in this milestone; those entities stay unfacetable.`);
		}
		if (this.getScopePolicy().Kind !== 'Policy')
		{
			this.fable.log.warn(`RetoldFaceting host: no scope policy is configured (ScopeAssurance 'Unscoped'): facets equal the lists the entities' own Reads behaviors produce, but the service cannot tell tenants apart — every write invalidates every principal's cached answers over its entity, and the change stream stays off unless SSE.Enabled is true.`);
		}

		this._Bound = true;
		return fCallback();
	}

	/**
	 * @param {(pError?: Error, pModel?: Record<string, any>) => void} fCallback
	 */
	getModel(fCallback)
	{
		let tmpModel = this.getModelSync();
		if (!tmpModel)
		{
			return fCallback(libFacetErrors.create('FACET_MODEL_RELOADING', 'No model is loaded.'));
		}
		return fCallback(null, tmpModel);
	}

	/**
	 * RetoldDataService.fullModel (false until a model is loaded → null).
	 *
	 * @return {Record<string, any>|null}
	 */
	getModelSync()
	{
		if (this._RetoldDataService && isPlainObject(this._RetoldDataService.fullModel))
		{
			return this._RetoldDataService.fullModel;
		}
		return null;
	}

	/**
	 * @return {Array<string>} every entity with a DAL
	 */
	listEntities()
	{
		let tmpDALs = this._dalMap();
		return Object.keys(tmpDALs).filter((pEntity) => { return tmpDALs[pEntity] && (typeof(tmpDALs[pEntity]) === 'object'); });
	}

	/**
	 * @param {string} pEntity
	 * @return {any|null} fable.DAL[pEntity]
	 */
	getDAL(pEntity)
	{
		let tmpDALs = this._dalMap();
		if (!hasOwn(tmpDALs, pEntity) || !tmpDALs[pEntity] || (typeof(tmpDALs[pEntity]) !== 'object'))
		{
			return null;
		}
		return tmpDALs[pEntity];
	}

	/**
	 * D-17 names: the base check (DALs, model tables) plus every meadow-endpoints entry.
	 *
	 * @return {Array<string>}
	 */
	reservedEntityNames()
	{
		let tmpNames = new Set(super.reservedEntityNames());
		let tmpEndpoints = this._endpointsMap();
		libOptions.ROUTE_RESERVED_NAMES.forEach((pName) => { if (hasOwn(tmpEndpoints, pName)) { tmpNames.add(pName); } });
		return libOptions.ROUTE_RESERVED_NAMES.filter((pName) => { return tmpNames.has(pName); });
	}

	/**
	 * @param {string} pEntity
	 * @return {any|null} the controller captured at bind (or at the entity's first model load)
	 */
	getRouteBoundController(pEntity)
	{
		return hasOwn(this._RouteBoundControllers, pEntity) ? this._RouteBoundControllers[pEntity] : null;
	}

	/**
	 * Are the entity's list (Reads) routes connected on its route-bound endpoints?
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	hasConnectedReadRoutes(pEntity)
	{
		if (!hasOwn(this._RouteBoundEndpoints, pEntity))
		{
			return false;
		}
		let tmpEndpoint = this._RouteBoundEndpoints[pEntity];
		let tmpSets = (tmpEndpoint && isPlainObject(tmpEndpoint._EnabledBehaviorSets)) ? tmpEndpoint._EnabledBehaviorSets : null;
		// Older meadow-endpoints have no behavior-set switches: every route is connected.
		return !tmpSets || (tmpSets.Reads !== false);
	}

	/**
	 * @return {any|null}
	 */
	getServiceServer()
	{
		let tmpFable = this._hostFable();
		return (tmpFable && tmpFable.OratorServiceServer) ? tmpFable.OratorServiceServer : null;
	}

	/**
	 * @return {Record<string, any>} internal-contracts §8.3 (cached until the next model load)
	 */
	getScopePolicy()
	{
		if (!this._ScopePolicy)
		{
			this._ScopePolicy = this.buildScopePolicy(this.options.Scope,
				(pEntity, pColumn) =>
				{
					return this.entityHasColumn(pEntity, pColumn);
				});
		}
		return this._ScopePolicy;
	}

	/**
	 * @param {string} [pEntity]
	 * @return {string} 'Unscoped' | 'Guarded' | 'Global' | 'Spoofable'
	 */
	scopeAssurance(pEntity)
	{
		if (this._HeaderSession)
		{
			return 'Spoofable';
		}
		return super.scopeAssurance(pEntity);
	}

	/**
	 * @param {string} pEntity
	 * @return {{ Name: string|null, Provider: string|null, Supported: boolean }} from the DAL's provider name
	 */
	getDialectProfile(pEntity)
	{
		let tmpDAL = this.getExecutionDAL(pEntity);
		let tmpProvider = (tmpDAL && (typeof(tmpDAL.providerName) === 'string')) ? tmpDAL.providerName : null;
		let tmpSupported = (tmpProvider !== null) && (libRetoldFacetingHostBase.SUPPORTED_DIALECTS.indexOf(tmpProvider) >= 0);
		return { Name: tmpProvider, Provider: tmpProvider, Supported: tmpSupported };
	}

	/**
	 * The MeadowSchema.Schema the entity's queries are built from (the DAL's, else the model's).
	 *
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>}
	 */
	_meadowSchema(pEntity)
	{
		let tmpDAL = this.getExecutionDAL(pEntity);
		if (tmpDAL && Array.isArray(tmpDAL.schema) && (tmpDAL.schema.length > 0))
		{
			return tmpDAL.schema;
		}
		let tmpTable = this.getEntityModel(pEntity);
		if (tmpTable && isPlainObject(tmpTable.MeadowSchema) && Array.isArray(tmpTable.MeadowSchema.Schema))
		{
			return tmpTable.MeadowSchema.Schema;
		}
		return [];
	}

	/**
	 * @param {string} pEntity
	 * @return {string|null} the column whose MeadowSchema Type is 'Deleted'
	 */
	getDeleteColumn(pEntity)
	{
		let tmpSchema = this._meadowSchema(pEntity);
		for (let i = 0; i < tmpSchema.length; i++)
		{
			if (tmpSchema[i] && (tmpSchema[i].Type === 'Deleted') && (typeof(tmpSchema[i].Column) === 'string'))
			{
				return tmpSchema[i].Column;
			}
		}
		return null;
	}

	/**
	 * The one primary-key resolution: the execution DAL's defaultIdentifier, else the model's
	 * (Graph.primaryKeyOf: MeadowSchema.DefaultIdentifier, the ID column, the AutoIdentity column).
	 *
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	getPrimaryKey(pEntity)
	{
		let tmpDAL = this.getExecutionDAL(pEntity);
		if (tmpDAL && (typeof(tmpDAL.defaultIdentifier) === 'string') && (tmpDAL.defaultIdentifier.length > 0))
		{
			return tmpDAL.defaultIdentifier;
		}
		return libRetoldFacetingGraph.primaryKeyOf(this.getEntityModel(pEntity));
	}

	/**
	 * Host.isFacetable for plain RDS (06 §5.1, internal-contracts §12.1):
	 *   - a plain identifier, not NeverFacet / Account / ApiKey / LoginChallenge / RetoldFacetChangeLog;
	 *   - a DAL on a supported SQL dialect, a model table, and a route-bound controller whose Reads
	 *     routes are connected (controller-less declarations are a later milestone);
	 *   - with a scope policy: scoped, or listed in Catalog.GlobalEntities.
	 * Plain RDS has no entitlements, so the principal does not change the answer.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pPrincipal]
	 * @return {boolean}
	 */
	isFacetable(pEntity, pPrincipal)
	{
		if ((typeof(pEntity) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pEntity))
		{
			return false;
		}
		if (libOptions.NEVER_FACETABLE.indexOf(pEntity) >= 0)
		{
			return false;
		}
		let tmpNeverFacet = Array.isArray(this.options.Catalog.NeverFacet) ? this.options.Catalog.NeverFacet : [];
		if (tmpNeverFacet.indexOf(pEntity) >= 0)
		{
			return false;
		}
		if (!this.getDAL(pEntity) || !this.getEntityModel(pEntity))
		{
			return false;
		}
		if (!this.getRouteBoundController(pEntity) || !this.hasConnectedReadRoutes(pEntity))
		{
			return false;
		}
		if (!this.getDialectProfile(pEntity).Supported)
		{
			return false;
		}
		let tmpPolicy = this.getScopePolicy();
		if ((tmpPolicy.Kind === 'Policy') && !tmpPolicy.isScoped(pEntity))
		{
			let tmpGlobal = Array.isArray(this.options.Catalog.GlobalEntities) ? this.options.Catalog.GlobalEntities : [];
			return (tmpGlobal.indexOf(pEntity) >= 0);
		}
		return true;
	}

	/**
	 * Any route-bound controller (the session marshaler is shared, internal-contracts §12.2).
	 *
	 * @return {any|null}
	 */
	_anyRouteBoundController()
	{
		let tmpEntities = Object.keys(this._RouteBoundControllers);
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpController = this._RouteBoundControllers[tmpEntities[i]];
			if (tmpController && (typeof(tmpController.initializeRequestState) === 'function'))
			{
				return tmpController;
			}
		}
		return null;
	}

	/**
	 * Raw principal from the meadow-endpoints session marshaler (internal-contracts §12.2):
	 * SessionData = controller.initializeRequestState(pRequest, 'Reads').SessionData, exactly what the
	 * entity's list routes see.  (PrincipalResolver adds the unset-scope-value check.)
	 *
	 * @param {any} pRequest
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	resolvePrincipal(pRequest, fCallback)
	{
		let tmpRequest = (pRequest && (typeof(pRequest) === 'object')) ? pRequest : { params: {}, headers: {}, query: {} };
		if (!tmpRequest.headers || (typeof(tmpRequest.headers) !== 'object'))
		{
			tmpRequest.headers = {};
		}
		let tmpSessionData = null;
		try
		{
			let tmpController = this._anyRouteBoundController();
			if (tmpController)
			{
				tmpSessionData = tmpController.initializeRequestState(tmpRequest, 'Reads').SessionData;
			}
			else
			{
				let tmpFable = this._hostFable();
				let tmpDefaultSession = (tmpFable && tmpFable.settings && isPlainObject(tmpFable.settings.MeadowEndpointsDefaultSessionObject)) ? tmpFable.settings.MeadowEndpointsDefaultSessionObject : { LoggedIn: false };
				tmpSessionData = Object.assign({}, tmpDefaultSession, isPlainObject(tmpRequest.UserSession) ? tmpRequest.UserSession : {});
			}
		}
		catch (pSessionError)
		{
			this.fable.log.error(`RetoldFaceting host: session resolution failed: ${pSessionError.message}`);
			return fCallback(libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpPrincipal = null;
		try
		{
			tmpPrincipal = this.buildPrincipal(tmpSessionData, tmpRequest, 'InProcess');
		}
		catch (pPrincipalError)
		{
			this.fable.log.error(`RetoldFaceting host: principal construction failed: ${pPrincipalError.message}`);
			return fCallback(libFacetErrors.create('FACET_INTERNAL'));
		}
		return fCallback(null, tmpPrincipal);
	}
}

module.exports = RetoldFacetingHostDataService;
module.exports.serviceType = 'RetoldFacetingHostDataService';
module.exports.LOAD_MODEL_WRAP_MARKER = LOAD_MODEL_WRAP_MARKER;
