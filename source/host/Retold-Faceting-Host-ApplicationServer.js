/**
 * Retold Faceting - Host: retold-application-foundation-server (Embedded role)
 *
 * The host of a RetoldApplicationServer (RAFS 1.0.5, a PRIVATE package): this module never
 * require()s it.  The server object is duck-typed (pServer.fable, .DAL, .Endpoints, .MeadowModel,
 * .tenancyConfig(), .entitlementsConfig(), .MembershipConfig, the class statics .Entitlements and
 * .manifest).  It extends the plain retold-data-service host because the meadow-endpoints half is
 * the same (route-bound controller snapshot, dialect, delete column, primary key, connected-reads
 * check, the header-session refusal); only the sources differ:
 *
 *   DALs                 pServer.DAL[E]                         (Retold-Application-Server.js:98, :602-604)
 *   Endpoints            pServer.Endpoints[E] (meadow-endpoints; .controller === ._Controller)   (:99, :612-614)
 *   Model                pServer.MeadowModel ({ Tables }, never reloaded)                         (:104)
 *   Service server       pServer.fable.Orator.serviceServer     (=== fable.OratorServiceServer)  (:314-333)
 *   Scope policy         pServer.tenancyConfig() + the tenancy coverage snapshot (§75), never Faceting.Scope.Policy
 *   Authorizer           Retold-Entitlements can() over the principal's resolved action set (§77)
 *   Principal            pRequest.UserSession (resolved by the tenancy pre() handler; without tenancy, by
 *                        RAFS's own fable.OratorAuthentication.resolveSessionForRequest), IDUser-enriched
 *                        with RAFS's own Entitlements.resolveIDUser, through the SAME getValue functions
 *                        tenancy uses (§76)
 *
 * OWNER PRINCIPLE: tenancy is the host app's job, in its own behaviors.  This host never re-implements
 * the tenancy fence, filter or stamp; faceting inherits them by running each entity's own
 * Reads-QueryConfiguration on its route-bound controller, and asserts the result with the ScopeGuard
 * against the coverage the host actually installed (the Required set is exactly the entities RAFS put
 * a tenancy layer on, read from the controllers — never inferred from Endpoints − Exclude or from "has
 * the column").
 *
 * Contract: internal-contracts Part V (§71–§82).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libRetoldFacetingHostDataService = require('./Retold-Faceting-Host-DataService.js');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

const isPlainObject = libRetoldFacetingHostDataService.isPlainObject;
const hasOwn = libRetoldFacetingHostDataService.hasOwn;

// Kept for callers that pinned the skeleton's refusal text (the host is implemented now; nothing returns it).
const NOT_IMPLEMENTED_MESSAGE = 'The retold-application-foundation-server host adapter is not implemented in this release (internal-contracts Part V).';

// RAFS 1.0.5 marks every BehaviorInjection it installed tenancy on with this array of guard layers
// (Retold-Tenancy.js:433-437, :461).  The observed coverage (§75.1) reads it; RAFS-1's
// pServer.tenancyScopedEntities() wins when the host exports it.
const TENANCY_LAYERS_MARKER = '_RetoldTenancyLayers';

// Retold-Tenancy defaults (Retold-Tenancy.js:495, :468-471).
const DEFAULT_TENANCY_COLUMN = 'IDCustomer';

// The meadow-endpoints route version RAFS mounts under (DeniedPrefixes are matched against
// '/<version>/<Entity>' and '/<version>/<Entity>s', §78).
const DEFAULT_ROUTE_VERSION = '1.0';

// Manifest tenancy defaults (Retold-App-Manifest.js:104-105) and the Membership platform-principal
// defaults (Retold-Membership.js:75-76).
const DEFAULT_ROOT_TABLE = 'Customer';
const DEFAULT_IDENTITY_TABLE = 'User';
const DEFAULT_SYSTEM_ADMIN_FIELD = 'SystemRole';
const DEFAULT_SYSTEM_ADMIN_VALUE = 'root';

// Retold-Entitlements' API prefix default (Retold-Entitlements.js:233), and the principal's IDUser field
// without entitlements (with them it is exactly entitlementsConfig().IdentityUserField, §76.1).
const DEFAULT_ENTITLEMENTS_API_PREFIX = '/1.0/';
const DEFAULT_IDENTITY_USER_FIELD = 'IDUser';

// The entitlements config fields RAFS reads raw, with no default (Retold-Entitlements.js resolveIDUser
// :88-100, the gate :278-286): a config without one of them is a boot refusal (§73.5), so the persona
// faceting reads is always the one RAFS's gate reads.
const REQUIRED_ENTITLEMENT_FIELDS = Object.freeze([ 'IdentityUserField', 'IdentityAccountField', 'TenantField' ]);

// The entitlements config keys naming the role tables (§77.3: a write to any of them invalidates).
const ROLE_TABLE_KEYS = Object.freeze([ 'RoleTable', 'RoleActionTable', 'UserRoleTable', 'UserActionTable' ]);

// The meadow DAL write methods (own properties of every DAL object, meadow Meadow.js:413-418).  The role
// tables' are wrapped for entitlement invalidation (§79.3), whatever wrote through them.
const DAL_WRITE_METHODS = Object.freeze([ 'doCreate', 'doUpdate', 'doDelete', 'doUndelete' ]);

// The marker on an entitlement-invalidation wrapper ({ Host, Table, Original }), and the interim intake's
// wrapper marker (Change-Intake-Interim.js INTAKE_MARKER) — both walked to find ours under another wrapper.
const ENTITLEMENT_WRAP_MARKER = Symbol.for('RetoldFaceting.EntitlementInvalidation');
const INTAKE_WRAP_MARKER = Symbol.for('RetoldFaceting.Intake');
const MAX_WRAP_DEPTH = 16;

// The per-persona entitlement cache bound (§77.3; oldest entries are dropped beyond it).  The cache is
// off unless Authorization.EntitlementCacheMS is positive (RAFS's own gate resolves per request).
const ENTITLEMENT_CACHE_MAX_ENTRIES = 10000;
const DEFAULT_ENTITLEMENT_CACHE_MS = 0;

// The intake subscriber that drops entitlement-cache entries on role-table events (§79.3).
const ENTITLEMENT_SUBSCRIBER = 'RAFSEntitlements';

// The read behaviors Retold-Tenancy guards (Retold-Tenancy.js:366-391): the only Scope.Behavior /
// Scope.BehaviorOverrides values accepted for an Installed entity (§73.5).
const TENANCY_GUARDED_READ_BEHAVIORS = Object.freeze([ 'Reads-QueryConfiguration', 'Read-QueryConfiguration', 'Count-QueryConfiguration', 'CountBy-QueryConfiguration', 'ReadMax-QueryConfiguration' ]);

// The tenant value of a change event that names no tenant (internal-contracts §39).
const UNKNOWN_TENANT = '*';

// Tenancy coverage classes of one model entity (§75.2).
const COVERAGE = Object.freeze(
	{
		Installed: 'Installed',
		Excluded: 'Excluded',
		Unguarded: 'Unguarded',
		Controllerless: 'Controllerless',
		Misconfigured: 'Misconfigured',
		None: 'None'
	});

// The operators the host's tenancy fence does not admit that faceting itself renders, and the
// stand-in a capture swaps them for while the host behavior runs (§75.4).  'IS' + null is the SQLite
// NULL form (FH-2); RAFS's fence allowlist (Retold-Tenancy.js:69-75) has no 'IS'.
const FENCE_SWAP_OPERATORS = Object.freeze({ IS: '=' });

// Authorization.Strategy string values (§77.1); a function is the third form.
const AUTHORIZATION_STRATEGIES = Object.freeze([ 'Auto', 'None' ]);

const normalizeScopeValue = libRetoldFacetingUtil.normalizeScopeValue;

/**
 * A configuration value for a log line or a boot error: a plain name (entity, column, route prefix) as
 * is, anything else JSON-quoted and truncated (Util.logSafe).
 *
 * @param {any} pValue
 * @return {string}
 */
const logSafe = (pValue) =>
{
	if ((typeof(pValue) === 'string') && /^[A-Za-z0-9_./*-]{1,128}$/.test(pValue))
	{
		return pValue;
	}
	return libRetoldFacetingUtil.logSafe(pValue);
};

/**
 * Retold-Tenancy's default getValue (Retold-Tenancy.js:468-471), reproduced so the principal and the
 * guard read the session the same way when the app supplies no getValue of its own.
 *
 * @param {string} pField - the UserRecord field
 * @return {(pSession: any) => any}
 */
const defaultTenancyGetValue = (pField) =>
{
	return (pSession) => { return (pSession && pSession.UserRecord) ? (pSession.UserRecord[pField] || 0) : 0; };
};

/**
 * A non-empty string, else the fallback.
 *
 * @param {any} pValue
 * @param {string|null} pFallback
 * @return {string|null}
 */
const nonEmptyString = (pValue, pFallback) =>
{
	return ((typeof(pValue) === 'string') && (pValue.length > 0)) ? pValue : pFallback;
};

/**
 * The strings of an array (anything else → []).
 *
 * @param {any} pValue
 * @return {Array<string>}
 */
const stringList = (pValue) =>
{
	return Array.isArray(pValue) ? pValue.filter((pEntry) => { return (typeof(pEntry) === 'string') && (pEntry.length > 0); }) : [];
};

/**
 * The role-set fingerprint of an action set (§76.1): 'r:' + the first 12 hex of sha256 over the sorted
 * actions joined by '\n'.
 *
 * @param {Set<string>} pActions
 * @return {string}
 */
const roleSetHash = (pActions) =>
{
	let tmpActions = [];
	if (pActions && (typeof(pActions.forEach) === 'function'))
	{
		pActions.forEach((pAction) => { tmpActions.push(String(pAction)); });
	}
	tmpActions.sort();
	return `r:${libCrypto.createHash('sha256').update(tmpActions.join('\n'), 'utf8').digest('hex').slice(0, 12)}`;
};

class RetoldFacetingHostApplicationServer extends libRetoldFacetingHostDataService
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (resolved by the base)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'RetoldFacetingHostApplicationServer';

		// The RetoldApplicationServer instance (set by bind)
		this._ApplicationServer = null;
		// pServer.tenancyConfig() as captured at bind (null: a single-tenant app, ScopeAssurance 'Unscoped')
		this._Tenancy = null;
		// The tenancy getValue functions, exactly as Retold-Tenancy builds them: { Column, getValue, Personal: { E: { Column, SessionField, getValue } } }
		this._TenancySpecs = null;
		// The coverage snapshot (§75.1): { Phase, Source, Column, Installed: Set, Excluded: Set, PersonalScopes, DeniedPrefixes, Classes: { E: COVERAGE.* } }
		this._TenancySnapshot = null;
		// pServer.entitlementsConfig() and the duck-typed Retold-Entitlements module ({ resolveActions, can })
		this._EntitlementsConfig = null;
		this._Entitlements = null;
		// (IDUser|IDCustomer) → { Actions: Set, Tenant, At } (§77.3)
		this._EntitlementCache = new Map();
		// Bumped by every invalidation, so a resolution that raced one is not stored (§77.3)
		this._EntitlementEpoch = 0;
		// The platform-principal rule (§77.4): { Field, Value } from pServer.MembershipConfig, else null
		this._PlatformRule = null;
		// Root / identity tables: never facetable while Global (§78 rule 5)
		this._IdentityTables = [];
		// The phase that last captured controllers ('Hook' | 'Routes'); set by the service before bind
		this._CapturePhase = null;
		// Endpoints registered after the route phase that a request referenced (warned once each, §73.4)
		this._UncapturedWarned = new Set();
		// getAuthorizer() memo (undefined: not built since the last bind)
		this._Authorizer = undefined;
		// Why the route phase must fail the boot (set by captureLateMounts; null when it may proceed, §73.4)
		this._RouteRefusal = null;
		// '<Entity>.<Column>' of personal getValue functions that threw (logged once each, §76.1)
		this._ScopeValueErrorsLogged = new Set();
	}

	getHostKind()
	{
		return 'ApplicationServer';
	}

	/**
	 * Does an object look like a RetoldApplicationServer whose boot reached the step this installer
	 * runs in (a fable, the DAL / Endpoints maps, a model with Tables, tenancyConfig())?  Duck-typed:
	 * the private package is never required.
	 *
	 * @param {any} pServer
	 * @return {boolean}
	 */
	static isApplicationServer(pServer)
	{
		return !!pServer && (typeof(pServer) === 'object')
			&& !!pServer.fable && (typeof(pServer.fable) === 'object')
			&& isPlainObject(pServer.DAL)
			&& isPlainObject(pServer.Endpoints)
			&& !!pServer.MeadowModel && isPlainObject(pServer.MeadowModel.Tables)
			&& (typeof(pServer.tenancyConfig) === 'function');
	}

	/**
	 * Does a CRUD route of the entity fall under one of the tenancy DeniedPrefixes?  Mirrors the RAFS
	 * pre() handler's `url.indexOf(prefix) === 0` (Retold-Tenancy.js:524-532) for both the singular and
	 * the plural route.  The routes are checked both where the model key puts them ('/1.0/E', '/1.0/Es')
	 * and where meadow-endpoints actually mounted them (pEndpointPrefix = '/<version>/<DAL.scope>',
	 * Meadow-Endpoints.js:43-47, and its plural): either one matching denies (fail closed).  Pure.
	 *
	 * @param {string} pEntity
	 * @param {Array<string>} pPrefixes
	 * @param {string} [pRouteVersion] - default '1.0'
	 * @param {string} [pEndpointPrefix] - the captured endpoint's own EndpointPrefix
	 * @return {boolean}
	 */
	static deniedByPrefixes(pEntity, pPrefixes, pRouteVersion, pEndpointPrefix)
	{
		if ((typeof(pEntity) !== 'string') || !Array.isArray(pPrefixes))
		{
			return false;
		}
		let tmpVersion = ((typeof(pRouteVersion) === 'string') && (pRouteVersion.length > 0)) ? pRouteVersion : DEFAULT_ROUTE_VERSION;
		let tmpRoutes = [ `/${tmpVersion}/${pEntity}` ];
		if ((typeof(pEndpointPrefix) === 'string') && (pEndpointPrefix.length > 0) && (tmpRoutes.indexOf(pEndpointPrefix) < 0))
		{
			tmpRoutes.push(pEndpointPrefix);
		}
		tmpRoutes = tmpRoutes.concat(tmpRoutes.map((pRoute) => { return `${pRoute}s`; }));
		return pPrefixes.some(
			(pPrefix) =>
			{
				return (typeof(pPrefix) === 'string') && (pPrefix.length > 0) && tmpRoutes.some((pRoute) => { return (pRoute.indexOf(pPrefix) === 0); });
			});
	}

	// ---------------------------------------------------------------- sources

	/**
	 * The fable that owns the RAFS objects (pServer.fable once bound).
	 *
	 * @return {any}
	 */
	_hostFable()
	{
		if (this._ApplicationServer && this._ApplicationServer.fable)
		{
			return this._ApplicationServer.fable;
		}
		return this.fable;
	}

	/**
	 * @return {Record<string, any>} pServer.DAL
	 */
	_dalMap()
	{
		return (this._ApplicationServer && isPlainObject(this._ApplicationServer.DAL)) ? this._ApplicationServer.DAL : {};
	}

	/**
	 * @return {Record<string, any>} pServer.Endpoints
	 */
	_endpointsMap()
	{
		return (this._ApplicationServer && isPlainObject(this._ApplicationServer.Endpoints)) ? this._ApplicationServer.Endpoints : {};
	}

	/**
	 * The primary key of a model table: the DAL's defaultIdentifier, else MeadowSchema.DefaultIdentifier,
	 * else the column with DataType 'ID' (null when none).  Pure over the server object.
	 *
	 * @param {any} pServer
	 * @param {string} pTable
	 * @return {string|null}
	 */
	static modelPrimaryKey(pServer, pTable)
	{
		let tmpDAL = (pServer && isPlainObject(pServer.DAL) && hasOwn(pServer.DAL, pTable)) ? pServer.DAL[pTable] : null;
		if (tmpDAL && (typeof(tmpDAL.defaultIdentifier) === 'string') && (tmpDAL.defaultIdentifier.length > 0))
		{
			return tmpDAL.defaultIdentifier;
		}
		let tmpTables = (pServer && pServer.MeadowModel && isPlainObject(pServer.MeadowModel.Tables)) ? pServer.MeadowModel.Tables : {};
		let tmpTable = hasOwn(tmpTables, pTable) ? tmpTables[pTable] : null;
		if (!isPlainObject(tmpTable))
		{
			return null;
		}
		if (isPlainObject(tmpTable.MeadowSchema) && (typeof(tmpTable.MeadowSchema.DefaultIdentifier) === 'string') && (tmpTable.MeadowSchema.DefaultIdentifier.length > 0))
		{
			return tmpTable.MeadowSchema.DefaultIdentifier;
		}
		let tmpIdentity = Array.isArray(tmpTable.Columns) ? tmpTable.Columns.filter((pColumn) => { return pColumn && (pColumn.DataType === 'ID'); })[0] : null;
		return (tmpIdentity && (typeof(tmpIdentity.Column) === 'string')) ? tmpIdentity.Column : null;
	}

	/**
	 * The route-bound controller of one meadow-endpoints object: its .controller getter
	 * (Meadow-Endpoints.js:108-111), else ._Controller (what Retold-Tenancy installs on).
	 *
	 * @param {any} pEndpoint
	 * @return {any|null}
	 */
	static endpointController(pEndpoint)
	{
		if (!pEndpoint || (typeof(pEndpoint) !== 'object'))
		{
			return null;
		}
		let tmpController = pEndpoint.controller || pEndpoint._Controller;
		return (tmpController && (typeof(tmpController) === 'object')) ? tmpController : null;
	}

	/**
	 * Capture the route-bound controller of every entity in pServer.Endpoints that has none captured yet
	 * (never replaced: RAFS has no reload, and late mounts are new entities).
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
			let tmpController = RetoldFacetingHostApplicationServer.endpointController(tmpEndpoints[tmpEntity]);
			if (!tmpController)
			{
				continue;
			}
			this._RouteBoundControllers[tmpEntity] = tmpController;
			this._RouteBoundEndpoints[tmpEntity] = tmpEndpoints[tmpEntity];
			tmpCaptured.push(tmpEntity);
		}
		return tmpCaptured;
	}

	/**
	 * RAFS has no model reload (the MeadowModel is fixed at construction): nothing to wrap.  The
	 * onModelChanged listeners fire only from captureLateMounts().
	 */
	_wrapModelLoader()
	{
	}

	/**
	 * @return {Record<string, any>|null} pServer.MeadowModel
	 */
	getModelSync()
	{
		if (this._ApplicationServer && this._ApplicationServer.MeadowModel && isPlainObject(this._ApplicationServer.MeadowModel.Tables))
		{
			return this._ApplicationServer.MeadowModel;
		}
		return null;
	}

	/**
	 * @return {any|null} pServer.fable.Orator.serviceServer (the object tenancy, entitlements and stopService use)
	 */
	getServiceServer()
	{
		let tmpFable = this._hostFable();
		if (tmpFable && tmpFable.Orator && tmpFable.Orator.serviceServer)
		{
			return tmpFable.Orator.serviceServer;
		}
		return (tmpFable && tmpFable.OratorServiceServer) ? tmpFable.OratorServiceServer : null;
	}

	/**
	 * The RetoldApplicationServer this host is bound to (null before bind).
	 *
	 * @return {any|null}
	 */
	getApplicationServer()
	{
		return this._ApplicationServer;
	}

	/**
	 * Which boot phase the next bind / capture runs in (the service sets it before bind; §75.1 Phase).
	 *
	 * @param {string} pPhase - 'Hook' | 'Routes'
	 */
	setCapturePhase(pPhase)
	{
		if ((pPhase === 'Hook') || (pPhase === 'Routes'))
		{
			this._CapturePhase = pPhase;
		}
	}

	/**
	 * Every entity name the host knows: the model tables, the DALs and the endpoints.
	 *
	 * @return {Array<string>}
	 */
	_knownEntities()
	{
		let tmpNames = new Set();
		let tmpModel = this.getModelSync();
		if (tmpModel)
		{
			Object.keys(tmpModel.Tables).forEach((pName) => { tmpNames.add(pName); });
		}
		Object.keys(this._dalMap()).forEach((pName) => { tmpNames.add(pName); });
		Object.keys(this._endpointsMap()).forEach((pName) => { tmpNames.add(pName); });
		return Array.from(tmpNames);
	}

	/**
	 * The server's hook config, called the way RAFS calls it (the method, else options.<Name>).
	 *
	 * @param {string} pMethod - e.g. 'entitlementsConfig'
	 * @param {string} pOptionName - e.g. 'Entitlements'
	 * @return {any|null}
	 */
	_serverConfig(pMethod, pOptionName)
	{
		let tmpServer = this._ApplicationServer;
		if (!tmpServer)
		{
			return null;
		}
		if (typeof(tmpServer[pMethod]) === 'function')
		{
			return tmpServer[pMethod]() || null;
		}
		return (isPlainObject(tmpServer.options) && tmpServer.options[pOptionName]) ? tmpServer.options[pOptionName] : null;
	}

	/**
	 * The Auth.Local block of the server's authConfig() (null without local auth).  A truthy non-object
	 * Local means the defaults (Retold-Auth-Local.js:30-41).
	 *
	 * @return {Record<string, any>|null}
	 */
	_authLocal()
	{
		let tmpServer = this._ApplicationServer;
		let tmpAuth = null;
		if (tmpServer && (typeof(tmpServer.authConfig) === 'function'))
		{
			tmpAuth = tmpServer.authConfig();
		}
		else if (tmpServer && isPlainObject(tmpServer.options))
		{
			tmpAuth = tmpServer.options.Auth;
		}
		if (!isPlainObject(tmpAuth) || !tmpAuth.Local)
		{
			return null;
		}
		return isPlainObject(tmpAuth.Local) ? tmpAuth.Local : {};
	}

	/**
	 * The app's orator-authentication service (RAFS _mountAuthentication puts it on the fable when
	 * EnableAuthentication is true), else null.
	 *
	 * @return {any|null}
	 */
	_authentication()
	{
		let tmpFable = this._hostFable();
		let tmpAuthentication = (tmpFable && tmpFable.OratorAuthentication) ? tmpFable.OratorAuthentication : null;
		return (tmpAuthentication && (typeof(tmpAuthentication) === 'object')) ? tmpAuthentication : null;
	}

	/**
	 * Does the bound server authenticate its users (options.EnableAuthentication, or orator-authentication
	 * mounted)?  On such a host an anonymous principal is 401 on every facet route unless the root entity
	 * is in Catalog.AllowAnonymous, whatever the tenancy setting (design 06 §5.1 rule 5; §75.5).  False
	 * before bind (everything fails closed then anyway).
	 *
	 * @return {boolean}
	 */
	authenticationRequired()
	{
		return this._Bound && this._serverAuthenticates();
	}

	/**
	 * authenticationRequired() without the bind check (the bind's own warnings use it).
	 *
	 * @return {boolean}
	 */
	_serverAuthenticates()
	{
		let tmpServer = this._ApplicationServer;
		if (!tmpServer)
		{
			return false;
		}
		return (isPlainObject(tmpServer.options) && (tmpServer.options.EnableAuthentication === true)) || !!this._authentication();
	}

	/**
	 * Authorization.EntitlementCacheMS as a non-negative number (DEFAULT_ENTITLEMENT_CACHE_MS when invalid).
	 *
	 * @return {number}
	 */
	_entitlementCacheMS()
	{
		let tmpTTL = this._authorization().EntitlementCacheMS;
		return ((typeof(tmpTTL) === 'number') && isFinite(tmpTTL) && (tmpTTL >= 0)) ? tmpTTL : DEFAULT_ENTITLEMENT_CACHE_MS;
	}

	// ---------------------------------------------------------------- bind (§74.1)

	/**
	 * Bind to a RetoldApplicationServer (§74.1): validate the duck type and the configuration, capture
	 * tenancyConfig() / entitlementsConfig() / the platform rule / the identity tables, snapshot the
	 * tenancy coverage and the route-bound controllers present now (the hook phase runs after
	 * _mountTenancy … _mountMembership), refuse header-sourced sessions, a Faceting Scope.Policy object,
	 * an entitlements config whose module cannot be found, Authorization.Strategy 'None' while
	 * entitlements gate the lists, PersonalScopes that share a column with different session sources,
	 * and a RoutePrefix segment that collides with an entity (the RAFS action gate would map it).
	 *
	 * @param {any} pServer
	 * @param {(pError?: Error) => void} fCallback
	 */
	bind(pServer, fCallback)
	{
		if (!RetoldFacetingHostApplicationServer.isApplicationServer(pServer))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostApplicationServer.bind needs a RetoldApplicationServer whose boot reached _loadMeadowEndpoints (fable, DAL, Endpoints, MeadowModel.Tables, tenancyConfig()).'));
		}
		if (this._Bound && (this._ApplicationServer !== pServer))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostApplicationServer is already bound to a different RetoldApplicationServer.'));
		}

		let tmpProblems = this._optionProblems();
		if (tmpProblems.length > 0)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting cannot mount on this RetoldApplicationServer: ${tmpProblems.join(' ')}`));
		}

		this._ApplicationServer = pServer;
		this._Authorizer = undefined;
		this._HeaderSession = false;
		let fRefuse = (pMessage) =>
		{
			// Fail closed: a refused (re-)bind leaves nothing half-bound.
			this._Bound = false;
			this._ApplicationServer = null;
			this._resetCaptures();
			return fCallback(libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting cannot mount on this RetoldApplicationServer: ${pMessage}`));
		};

		let tmpWarnings = [];
		try
		{
			this._captureConfiguration(pServer);
			this._captureRouteBoundControllers();
			this._TenancySnapshot = this._buildTenancySnapshot(this._CapturePhase || 'Hook');
		}
		catch (pCaptureError)
		{
			return fRefuse(pCaptureError.message);
		}
		this._ScopePolicy = null;

		let tmpRefusal = this._bindRefusal(pServer);
		if (tmpRefusal)
		{
			return fRefuse(tmpRefusal);
		}

		// Header-asserted sessions let any caller pick their tenant (06 §2.2).  On RAFS they are refused
		// outright (Scope.AllowHeaderSession is not accepted here): each controller's request state would
		// replace pRequest.UserSession with the x-trusted-session header session before the tenancy guard
		// runs (Meadow-Endpoints-Session-Marshaler.js:26-46), so the guard and the principal (built from the
		// tenancy pre-handler's session) would read different sessions.
		let tmpHeaderRefusal = this._headerSessionRefusal();
		if (tmpHeaderRefusal)
		{
			return fRefuse(tmpHeaderRefusal);
		}

		tmpWarnings = tmpWarnings.concat(this._bindWarnings(pServer));
		this._Bound = true;
		this._RouteRefusal = null;
		// Entitlement invalidation independent of facetability (§79.3): every write through the role tables'
		// DALs (RAFS's CRUD routes, grantRole, provisionDefaultRoles, app code) drops the cached action sets.
		this._wrapRoleTableDALs();
		this._logCoverage();
		tmpWarnings.forEach((pWarning) => { this.fable.log.warn(`RetoldFaceting host (ApplicationServer): ${pWarning}`); });
		return fCallback();
	}

	/**
	 * The header-session refusal (§73.5), or null: any route-bound controller (or the fable settings)
	 * sourcing sessions from the x-trusted-session header.
	 *
	 * @return {string|null}
	 */
	_headerSessionRefusal()
	{
		if (this.getSessionDataSource() !== 'Header')
		{
			return null;
		}
		return `its MeadowEndpointsSessionDataSource is 'Header' (callers could assert any session, and the lists would read that header session while the principal reads the tenancy pre-handler's); header sessions are refused on a RetoldApplicationServer (Scope.AllowHeaderSession is not accepted here).`;
	}

	/**
	 * Forget every capture (a refused first bind leaves nothing half-bound).
	 */
	_resetCaptures()
	{
		this._RouteBoundControllers = {};
		this._RouteBoundEndpoints = {};
		this._Tenancy = null;
		this._TenancySpecs = null;
		this._TenancySnapshot = null;
		this._EntitlementsConfig = null;
		this._Entitlements = null;
		this._PlatformRule = null;
		this._IdentityTables = [];
		this._ScopePolicy = null;
		this._Authorizer = undefined;
		this._HeaderSession = false;
		this._RouteRefusal = null;
		this._EntitlementCache.clear();
	}

	/**
	 * The option refusals that need no server (§73.5): the Scope section, the role, a Scope.Policy
	 * object, an unknown Authorization.Strategy.
	 *
	 * @return {Array<string>}
	 */
	_optionProblems()
	{
		let tmpProblems = this.validateScopeConfiguration(this.options.Scope);
		if (this.options.Role !== 'Embedded')
		{
			tmpProblems.push(`Role '${logSafe(String(this.options.Role))}' is not supported on a RetoldApplicationServer (Embedded only).`);
		}
		if (isPlainObject(this.options.Scope) && isPlainObject(this.options.Scope.Policy))
		{
			tmpProblems.push(`Faceting.Scope.Policy must be 'Auto' or false here: the tenancy policy comes from the server's tenancyConfig(), never from the faceting options.`);
		}
		let tmpStrategy = this._authorization().Strategy;
		if ((typeof(tmpStrategy) !== 'function') && (AUTHORIZATION_STRATEGIES.indexOf(tmpStrategy) < 0))
		{
			tmpProblems.push(`Authorization.Strategy must be 'Auto', 'None' or a function (got ${logSafe(String(tmpStrategy))}).`);
		}
		return tmpProblems;
	}

	/**
	 * @return {Record<string, any>} the resolved Authorization section
	 */
	_authorization()
	{
		return isPlainObject(this.options.Authorization) ? this.options.Authorization : {};
	}

	/**
	 * Capture the server's configuration (§74.1 step 2).  Throws on a tenancyConfig() /
	 * entitlementsConfig() hook that throws (the bind refuses).
	 *
	 * @param {any} pServer
	 */
	_captureConfiguration(pServer)
	{
		// Tenancy: tenancyConfig() exactly as _mountTenancy read it (a truthy non-object means the defaults).
		let tmpTenancy = pServer.tenancyConfig();
		this._Tenancy = tmpTenancy ? (isPlainObject(tmpTenancy) ? tmpTenancy : {}) : null;
		this._TenancySpecs = null;
		if (this._Tenancy)
		{
			let tmpColumn = nonEmptyString(this._Tenancy.Column, DEFAULT_TENANCY_COLUMN);
			let tmpPersonal = {};
			let tmpPersonalConfig = isPlainObject(this._Tenancy.PersonalScopes) ? this._Tenancy.PersonalScopes : {};
			Object.keys(tmpPersonalConfig).forEach(
				(pEntity) =>
				{
					let tmpSpec = tmpPersonalConfig[pEntity];
					if (!tmpSpec)
					{
						return;
					}
					let tmpPersonalColumn = isPlainObject(tmpSpec) ? tmpSpec.Column : undefined;
					let tmpSessionField = isPlainObject(tmpSpec) ? nonEmptyString(tmpSpec.SessionField, null) : null;
					let fGetValue = (isPlainObject(tmpSpec) && (typeof(tmpSpec.getValue) === 'function')) ? tmpSpec.getValue : null;
					tmpPersonal[pEntity] = (
						{
							Column: tmpPersonalColumn,
							SessionField: tmpSessionField || tmpPersonalColumn,
							CustomGetValue: fGetValue,
							// Retold-Tenancy.js:550-560: getValue wins, else UserRecord[SessionField || Column]
							getValue: fGetValue || defaultTenancyGetValue(tmpSessionField || tmpPersonalColumn)
						});
				});
			this._TenancySpecs = (
				{
					Column: tmpColumn,
					CustomGetValue: (typeof(this._Tenancy.getValue) === 'function') ? this._Tenancy.getValue : null,
					getValue: (typeof(this._Tenancy.getValue) === 'function') ? this._Tenancy.getValue : defaultTenancyGetValue(tmpColumn),
					Personal: tmpPersonal
				});
		}

		// Entitlements: the config and the module (an Authorization.Entitlements object override, else the
		// class static every RAFS subclass inherits, Retold-Application-Server.js:987).
		let tmpEntitlements = (typeof(pServer.entitlementsConfig) === 'function') ? pServer.entitlementsConfig() : null;
		this._EntitlementsConfig = tmpEntitlements ? (isPlainObject(tmpEntitlements) ? tmpEntitlements : {}) : null;
		let tmpOverride = this._authorization().Entitlements;
		let tmpModule = isPlainObject(tmpOverride) ? tmpOverride
			: (pServer.constructor && pServer.constructor.Entitlements) ? pServer.constructor.Entitlements
			: null;
		this._Entitlements = (tmpModule && (typeof(tmpModule.resolveActions) === 'function') && (typeof(tmpModule.can) === 'function')) ? tmpModule : null;
		this._EntitlementCache.clear();

		// The platform principal (§77.4): Membership's resolved config, stamped by _mountMembership.
		let tmpMembership = isPlainObject(pServer.MembershipConfig) ? pServer.MembershipConfig : null;
		this._PlatformRule = tmpMembership
			? { Field: nonEmptyString(tmpMembership.SystemAdminField, DEFAULT_SYSTEM_ADMIN_FIELD), Value: (typeof(tmpMembership.SystemAdminValue) !== 'undefined') && (tmpMembership.SystemAdminValue !== null) && (tmpMembership.SystemAdminValue !== '') ? tmpMembership.SystemAdminValue : DEFAULT_SYSTEM_ADMIN_VALUE }
			: null;

		this._IdentityTables = this._computeIdentityTables(pServer);
	}

	/**
	 * Root and identity tables (§78 rule 5): never facetable while Global, and a Catalog.GlobalEntities
	 * entry naming one that is Global is a boot refusal (§73.5).  With tenancy, always: the table keyed by
	 * the tenancy column (its primary key), the 'Customer' / 'User' tables when the model has them, and
	 * tenancyConfig().RootTable / .IdentityTable; plus the manifest, Membership, entitlements and Auth.Local
	 * tables below.
	 *
	 * @param {any} pServer
	 * @return {Array<string>}
	 */
	_computeIdentityTables(pServer)
	{
		let tmpTables = [];
		let fAdd = (pName) =>
		{
			if ((typeof(pName) === 'string') && (pName.length > 0) && (tmpTables.indexOf(pName) < 0))
			{
				tmpTables.push(pName);
			}
		};
		let tmpModelTables = (pServer.MeadowModel && isPlainObject(pServer.MeadowModel.Tables)) ? pServer.MeadowModel.Tables : {};
		if (this._Tenancy && this._TenancySpecs)
		{
			let tmpColumn = this._TenancySpecs.Column;
			fAdd(nonEmptyString(this._Tenancy.RootTable, null));
			fAdd(nonEmptyString(this._Tenancy.IdentityTable, null));
			[ DEFAULT_ROOT_TABLE, DEFAULT_IDENTITY_TABLE ].forEach((pName) => { if (hasOwn(tmpModelTables, pName)) { fAdd(pName); } });
			Object.keys(tmpModelTables).forEach(
				(pName) =>
				{
					if (RetoldFacetingHostApplicationServer.modelPrimaryKey(pServer, pName) === tmpColumn)
					{
						fAdd(pName);
					}
				});
		}
		// The manifest convention (Retold-App-Manifest.js:104-112): only for a fromManifest class whose
		// manifest declares tenancy without ScopeRootAndIdentity.
		let tmpManifest = (pServer.constructor && isPlainObject(pServer.constructor.manifest)) ? pServer.constructor.manifest : null;
		if (tmpManifest && isPlainObject(tmpManifest.Tenancy) && !tmpManifest.Tenancy.ScopeRootAndIdentity)
		{
			fAdd(nonEmptyString(tmpManifest.Tenancy.RootTable, DEFAULT_ROOT_TABLE));
			fAdd(nonEmptyString(tmpManifest.Tenancy.IdentityTable, DEFAULT_IDENTITY_TABLE));
		}
		let tmpMembership = isPlainObject(pServer.MembershipConfig) ? pServer.MembershipConfig : null;
		if (tmpMembership)
		{
			fAdd(tmpMembership.CustomerTable);
			fAdd(tmpMembership.AccountTable);
			fAdd(tmpMembership.PersonaTable);
		}
		if (this._EntitlementsConfig)
		{
			fAdd(this._EntitlementsConfig.IdentityTable);
		}
		let tmpLocal = this._authLocal();
		if (tmpLocal)
		{
			fAdd(nonEmptyString(tmpLocal.UserTable, DEFAULT_IDENTITY_TABLE));
			fAdd(tmpLocal.MembershipTable);
		}
		return tmpTables;
	}

	/**
	 * The refusals that need the captured server (§73.5).  null when the bind may proceed.
	 *
	 * @param {any} pServer
	 * @return {string|null}
	 */
	_bindRefusal(pServer)
	{
		let tmpAuthorization = this._authorization();
		let tmpScope = isPlainObject(this.options.Scope) ? this.options.Scope : {};
		// The boot step the hook installer ran in (§73.3): a snapshot taken before _mountTenancy /
		// _mountMembership would classify every scoped entity Unguarded and miss the platform and identity
		// tables, silently.
		let tmpPhaseRefusal = this._bootPhaseRefusal(pServer);
		if (tmpPhaseRefusal)
		{
			return tmpPhaseRefusal;
		}
		if (this._Tenancy && ((tmpScope.Guard === 'Off') || (tmpScope.Guard === 'Repair')))
		{
			// Strict only: tenancy is the app's job in its own behaviors.  'Repair' would fill in a displaced
			// RAFS guard on the facet side and keep answering while the entity's own list ran unscoped.
			return `Scope.Guard '${logSafe(String(tmpScope.Guard))}' is not allowed on a host with tenancy (only 'Strict': a dropped or rewritten tenancy guard must fail the facet, never be filled in by faceting).`;
		}
		let tmpBehaviorRefusal = this._scopeBehaviorRefusal();
		if (tmpBehaviorRefusal)
		{
			return tmpBehaviorRefusal;
		}
		let tmpPersonal = this._personalScopeCheck(this._TenancySnapshot);
		if (tmpPersonal.Refusal)
		{
			return tmpPersonal.Refusal;
		}
		let tmpIdentityRefusal = this._globalIdentityRefusal();
		if (tmpIdentityRefusal)
		{
			return tmpIdentityRefusal;
		}
		if (this._EntitlementsConfig)
		{
			if (tmpAuthorization.Strategy === 'None')
			{
				return `Authorization.Strategy 'None' is refused while entitlementsConfig() gates the lists (facets would be more permissive than the lists).`;
			}
			let tmpMissing = REQUIRED_ENTITLEMENT_FIELDS.filter((pField) => { return !nonEmptyString(this._EntitlementsConfig[pField], null); });
			if (tmpMissing.length > 0)
			{
				return `entitlementsConfig() lacks [${tmpMissing.join(', ')}]: Retold-Entitlements reads them with no default, so RAFS's gate and faceting could resolve different personas.`;
			}
			if (!this._Entitlements)
			{
				// A Strategy function only narrows the entitlements check (§77.1), so the module is needed with one too.
				return `entitlementsConfig() is set but no Retold-Entitlements module (resolveActions + can) is reachable through the server class (.Entitlements) or Authorization.Entitlements.`;
			}
			let tmpCollision = this._routePrefixCollision();
			if (tmpCollision)
			{
				return `RoutePrefix ${logSafe(this.options.RoutePrefix)} puts the segment '${logSafe(tmpCollision.Segment)}' after the entitlements APIPrefix, so the RAFS action gate would map facet requests to ${logSafe(tmpCollision.Entity)}.<verb>; choose a RoutePrefix whose first segment names no entity.`;
			}
		}
		return null;
	}

	/**
	 * Did the hook installer run in a boot step that is too early (§73.3)?  With tenancyConfig() set, no
	 * RAFS-1 export and at least one mounted, non-excluded endpoint with a BehaviorInjection, some
	 * route-bound controller must carry the tenancy layer marker; with membershipConfig() set, the server
	 * must carry the MembershipConfig _mountMembership stamps.
	 *
	 * @param {any} pServer
	 * @return {string|null}
	 */
	_bootPhaseRefusal(pServer)
	{
		let tmpAdvice = 'the faceting hook installer ran before RAFS\'s %STEP% step: put foundationHookInstaller(this, options) in the array hookInstallers() returns (not in seedSteps() or preSchemaSteps()).';
		let tmpSnapshot = this._TenancySnapshot;
		if (this._Tenancy && tmpSnapshot && (tmpSnapshot.Source === 'Marker') && (tmpSnapshot.Installed.size < 1))
		{
			let tmpCandidates = Object.keys(this._RouteBoundControllers).filter(
				(pEntity) =>
				{
					let tmpController = this._RouteBoundControllers[pEntity];
					return !tmpSnapshot.Excluded.has(pEntity) && !!tmpController && !!tmpController.BehaviorInjection;
				});
			if (tmpCandidates.length > 0)
			{
				return `tenancyConfig() is set but none of the ${tmpCandidates.length} mounted, non-excluded endpoints carries a tenancy layer: ${tmpAdvice.replace('%STEP%', '_mountTenancy')}`;
			}
		}
		let tmpMembership = null;
		try
		{
			tmpMembership = this._serverConfig('membershipConfig', 'Membership');
		}
		catch (pMembershipError)
		{
			return `membershipConfig() threw: ${logSafe(pMembershipError.message)}`;
		}
		if (tmpMembership && !isPlainObject(pServer.MembershipConfig))
		{
			return `membershipConfig() is set but the server carries no MembershipConfig yet: ${tmpAdvice.replace('%STEP%', '_mountMembership')}`;
		}
		return null;
	}

	/**
	 * Scope.Behavior / Scope.BehaviorOverrides on a tenancy host: every Installed entity must be captured
	 * through a behavior Retold-Tenancy guards (§73.5), else the capture would run a hash RAFS never
	 * scoped.
	 *
	 * @return {string|null}
	 */
	_scopeBehaviorRefusal()
	{
		let tmpSnapshot = this._TenancySnapshot;
		if (!this._Tenancy || !tmpSnapshot)
		{
			return null;
		}
		let tmpScope = isPlainObject(this.options.Scope) ? this.options.Scope : {};
		let tmpDefault = nonEmptyString(tmpScope.Behavior, 'Reads-QueryConfiguration');
		let tmpOverrides = isPlainObject(tmpScope.BehaviorOverrides) ? tmpScope.BehaviorOverrides : {};
		let tmpInstalled = Object.keys(tmpSnapshot.Classes).filter((pEntity) => { return tmpSnapshot.Classes[pEntity] === COVERAGE.Installed; }).sort();
		for (let i = 0; i < tmpInstalled.length; i++)
		{
			let tmpHash = hasOwn(tmpOverrides, tmpInstalled[i]) ? tmpOverrides[tmpInstalled[i]] : tmpDefault;
			if (TENANCY_GUARDED_READ_BEHAVIORS.indexOf(tmpHash) < 0)
			{
				return `Scope.${hasOwn(tmpOverrides, tmpInstalled[i]) ? `BehaviorOverrides.${logSafe(tmpInstalled[i])}` : 'Behavior'} is ${logSafe(String(tmpHash))}, which RAFS tenancy does not guard on ${logSafe(tmpInstalled[i])} (use one of ${TENANCY_GUARDED_READ_BEHAVIORS.join(', ')}).`;
			}
		}
		return null;
	}

	/**
	 * The PersonalScopes checks (§73.5), over the entities RAFS actually put a tenancy layer on (an entry
	 * for an excluded table, a late mount or a NoAutoCRUD table is never evaluated by RAFS, so it never
	 * fails the boot).  ScopeValues are keyed by column: entries sharing a column must agree on the
	 * session value.  Two default getValues (UserRecord[SessionField || Column]) with different
	 * SessionFields cannot agree → refusal; an app getValue function cannot be compared, so the first
	 * entry's is used for the column (the guard asserts the others: a disagreement is a ScopeGuard 500 on
	 * that entity, never a leak) → warning.
	 *
	 * @param {Record<string, any>|null} pSnapshot
	 * @return {{ Refusal: string|null, Warnings: Array<string>, Conflicted: Array<string> }}
	 */
	_personalScopeCheck(pSnapshot)
	{
		let tmpResult = { Refusal: null, Warnings: [], Conflicted: [] };
		if (!this._TenancySpecs || !pSnapshot)
		{
			return tmpResult;
		}
		let tmpColumn = this._TenancySpecs.Column;
		let tmpPersonal = this._TenancySpecs.Personal;
		let tmpByColumn = {};
		let tmpEntities = Object.keys(tmpPersonal).filter((pEntity) => { return pSnapshot.Installed.has(pEntity); }).sort();
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			let tmpSpec = tmpPersonal[tmpEntity];
			if ((typeof(tmpSpec.Column) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(tmpSpec.Column))
			{
				tmpResult.Refusal = `tenancyConfig().PersonalScopes.${logSafe(tmpEntity)} needs a plain Column identifier.`;
				tmpResult.Conflicted.push(tmpEntity);
				return tmpResult;
			}
			if (tmpSpec.Column === tmpColumn)
			{
				tmpResult.Refusal = `tenancyConfig().PersonalScopes.${logSafe(tmpEntity)} uses the tenancy column ${logSafe(tmpColumn)} (scope values are keyed by column).`;
				tmpResult.Conflicted.push(tmpEntity);
				return tmpResult;
			}
			let tmpFirst = tmpByColumn[tmpSpec.Column];
			if (!tmpFirst)
			{
				tmpByColumn[tmpSpec.Column] = { Entity: tmpEntity, SessionField: tmpSpec.SessionField, CustomGetValue: tmpSpec.CustomGetValue };
				continue;
			}
			if (!tmpFirst.CustomGetValue && !tmpSpec.CustomGetValue)
			{
				if (tmpFirst.SessionField !== tmpSpec.SessionField)
				{
					tmpResult.Refusal = `tenancyConfig().PersonalScopes ${logSafe(tmpFirst.Entity)} and ${logSafe(tmpEntity)} share the column ${logSafe(tmpSpec.Column)} with different session sources (SessionField ${logSafe(String(tmpFirst.SessionField))} vs ${logSafe(String(tmpSpec.SessionField))}; scope values are keyed by column).`;
					tmpResult.Conflicted.push(tmpEntity);
					return tmpResult;
				}
				continue;
			}
			if (tmpFirst.CustomGetValue !== tmpSpec.CustomGetValue)
			{
				tmpResult.Warnings.push(`tenancyConfig().PersonalScopes ${logSafe(tmpFirst.Entity)} and ${logSafe(tmpEntity)} share the column ${logSafe(tmpSpec.Column)} through different getValue functions / session fields: faceting reads ${logSafe(tmpFirst.Entity)}'s for the column, so they must agree (a disagreement is a ScopeGuard 500 on ${logSafe(tmpEntity)}, never a leak).`);
			}
		}
		return tmpResult;
	}

	/**
	 * A Catalog.GlobalEntities entry naming a root / identity table that is Global here (Excluded or
	 * Unguarded) is a boot refusal (§78 rule 5): it would expose every tenant's root or identity rows.
	 *
	 * @return {string|null}
	 */
	_globalIdentityRefusal()
	{
		let tmpSnapshot = this._TenancySnapshot;
		if (!this._Tenancy || !tmpSnapshot)
		{
			return null;
		}
		let tmpCatalog = isPlainObject(this.options.Catalog) ? this.options.Catalog : {};
		let tmpNamed = stringList(tmpCatalog.GlobalEntities).filter(
			(pEntity) =>
			{
				let tmpClass = tmpSnapshot.Classes[pEntity];
				return (this._IdentityTables.indexOf(pEntity) >= 0) && ((tmpClass === COVERAGE.Excluded) || (tmpClass === COVERAGE.Unguarded));
			});
		if (tmpNamed.length < 1)
		{
			return null;
		}
		return `Catalog.GlobalEntities names [${tmpNamed.map(logSafe).join(', ')}], root / identity table(s) that tenancy does not guard here: facets would expose every tenant's rows (root and identity tables are never facetable while global; remove them).`;
	}

	/**
	 * Would the RAFS entitlements gate (Retold-Entitlements.js requiredActionFor: the first path segment
	 * after APIPrefix, matched against <E> and <E>s) map a facet URL to an entity action (§77.5)?  Probed
	 * with the fixed facet URLs and one per-entity URL, against every model / endpoint entity.
	 *
	 * @return {{ Entity: string, Segment: string, Path: string }|null}
	 */
	_routePrefixCollision()
	{
		let tmpConfig = this._EntitlementsConfig || {};
		let tmpAPIPrefix = nonEmptyString(tmpConfig.APIPrefix, DEFAULT_ENTITLEMENTS_API_PREFIX);
		let tmpRoutePrefix = String(this.options.RoutePrefix || '');
		let tmpEntities = this._knownEntities();
		let tmpPaths = [ `${tmpRoutePrefix}/Describe`, `${tmpRoutePrefix}/Changes` ].concat(tmpEntities.map((pEntity) => { return `${tmpRoutePrefix}/${pEntity}/Query`; }));
		for (let i = 0; i < tmpPaths.length; i++)
		{
			if (tmpPaths[i].indexOf(tmpAPIPrefix) !== 0)
			{
				continue;
			}
			let tmpSegment = tmpPaths[i].slice(tmpAPIPrefix.length).split('/')[0];
			if (!tmpSegment)
			{
				continue;
			}
			for (let j = 0; j < tmpEntities.length; j++)
			{
				if ((tmpSegment === tmpEntities[j]) || (tmpSegment === `${tmpEntities[j]}s`))
				{
					return { Entity: tmpEntities[j], Segment: tmpSegment, Path: tmpPaths[i] };
				}
			}
		}
		return null;
	}

	/**
	 * The boot warnings of §73.5 (the bind continues).
	 *
	 * @param {any} pServer
	 * @return {Array<string>}
	 */
	_bindWarnings(pServer)
	{
		let tmpWarnings = [];
		let tmpCatalog = isPlainObject(this.options.Catalog) ? this.options.Catalog : {};
		if (Array.isArray(pServer.NoAutoCRUDTables))
		{
			tmpWarnings.push(`NoAutoCRUDTables is an array; RAFS looks tables up by name in an object map, so it mounted public CRUD routes for [${pServer.NoAutoCRUDTables.map((pName) => { return logSafe(String(pName)); }).join(', ')}] (use { Table: true }). Faceting follows what the app meant: those tables are never facetable.`);
		}
		let tmpFable = this._hostFable();
		if (tmpFable && tmpFable.Orator && tmpFable.Orator.serviceServer && tmpFable.OratorServiceServer && (tmpFable.Orator.serviceServer !== tmpFable.OratorServiceServer))
		{
			tmpWarnings.push('fable.Orator.serviceServer and fable.OratorServiceServer differ; the facet routes mount on fable.Orator.serviceServer.');
		}
		let tmpControllerless = isPlainObject(tmpCatalog.Controllerless) ? Object.keys(tmpCatalog.Controllerless) : [];
		if (tmpControllerless.length > 0)
		{
			tmpWarnings.push(`Catalog.Controllerless declarations [${tmpControllerless.map(logSafe).join(', ')}] are not supported yet; those entities stay unfacetable.`);
		}
		// Endpoints whose routes are not where the model key puts them (DAL.scope ≠ the Tables key): the
		// DeniedPrefixes check covers both forms (§78 rule 3), but the app's own prefixes may not.
		Object.keys(this._RouteBoundEndpoints).sort().forEach(
			(pEntity) =>
			{
				let tmpEndpoint = this._RouteBoundEndpoints[pEntity];
				let tmpName = (tmpEndpoint && (typeof(tmpEndpoint.EndpointName) === 'string')) ? tmpEndpoint.EndpointName : null;
				if (tmpName && (tmpName !== pEntity))
				{
					tmpWarnings.push(`the endpoint of ${logSafe(pEntity)} is mounted as ${logSafe(tmpName)} (its MeadowSchema.Scope differs from the model key): its routes are ${logSafe(String(tmpEndpoint.EndpointPrefix))}[s], and DeniedPrefixes are matched against both names.`);
				}
			});
		if (!this._Tenancy)
		{
			if (this.getScopePolicy().Kind !== 'Policy')
			{
				tmpWarnings.push(`the server has no tenancyConfig() (ScopeAssurance 'Unscoped'): facets equal the lists the entities' own Reads behaviors produce, but the service cannot tell tenants apart.`);
			}
			if (this._serverAuthenticates() || this._EntitlementsConfig)
			{
				// RAFS resolves pRequest.UserSession only in its tenancy pre-handler (Retold-Tenancy.js:514-539).
				tmpWarnings.push(`the server authenticates${this._EntitlementsConfig ? ' and has entitlementsConfig()' : ''} but has no tenancyConfig(): RAFS resolves sessions only in its tenancy pre-handler, so its own${this._EntitlementsConfig ? ' entitlement gate never runs and its' : ''} CRUD lists see every caller as anonymous. The facet routes resolve the session themselves through fable.OratorAuthentication (and RAFS's Entitlements.resolveIDUser), refuse anonymous principals${this._EntitlementsConfig ? ' and need <Entity>.read' : ''}, so facets can be stricter than those lists.${this._authentication() ? '' : ' No OratorAuthentication is mounted: every facet principal is anonymous (401).'}`);
			}
		}
		else
		{
			let tmpSnapshot = this._TenancySnapshot;
			let tmpRoutePrefix = String(this.options.RoutePrefix || '');
			tmpSnapshot.DeniedPrefixes.forEach(
				(pPrefix) =>
				{
					if (`${tmpRoutePrefix}/`.indexOf(pPrefix) === 0)
					{
						tmpWarnings.push(`the tenancy DeniedPrefixes entry ${logSafe(pPrefix)} covers the facet RoutePrefix ${logSafe(tmpRoutePrefix)}: RAFS answers every facet request 404 before it reaches the service.`);
					}
				});
			Object.keys(tmpSnapshot.Classes).forEach(
				(pEntity) =>
				{
					let tmpClass = tmpSnapshot.Classes[pEntity];
					if (tmpClass === COVERAGE.Misconfigured)
					{
						tmpWarnings.push(`${logSafe(pEntity)} carries a tenancy layer but lacks the tenancy column ${logSafe(tmpSnapshot.Column)} or its personal-scope column (Misconfigured): its own list errors, and it is never facetable.`);
					}
					else if ((tmpClass === COVERAGE.Unguarded) && this.entityHasColumn(pEntity, tmpSnapshot.Column))
					{
						tmpWarnings.push(`${logSafe(pEntity)} has the tenancy column ${logSafe(tmpSnapshot.Column)} but no tenancy layer (mounted after _mountTenancy?): its list is not tenant-scoped, and it is never facetable.`);
					}
				});
			tmpWarnings = tmpWarnings.concat(this._personalScopeCheck(tmpSnapshot).Warnings);
			stringList(tmpCatalog.AllowAnonymous).forEach(
				(pEntity) =>
				{
					if (tmpSnapshot.Classes[pEntity] === COVERAGE.Installed)
					{
						tmpWarnings.push(`Catalog.AllowAnonymous names ${logSafe(pEntity)}, which RAFS tenancy guards (its guard answers 401 to anonymous requests anyway).`);
					}
				});
			stringList(tmpCatalog.GlobalEntities).forEach(
				(pEntity) =>
				{
					let tmpClass = tmpSnapshot.Classes[pEntity];
					if ((tmpClass !== COVERAGE.Excluded) && (tmpClass !== COVERAGE.Unguarded))
					{
						tmpWarnings.push(`Catalog.GlobalEntities names ${logSafe(pEntity)}, which is not Global here (${tmpClass || 'unknown'}).`);
					}
				});
		}
		let tmpCacheMS = this._entitlementCacheMS();
		if (this._EntitlementsConfig && (tmpCacheMS > 0))
		{
			tmpWarnings.push(`Authorization.EntitlementCacheMS is ${tmpCacheMS}: action sets are cached per process. Writes through this process's role-table DALs invalidate the cache; writes by other processes (or raw SQL) do not, so a revocation there can facet for up to ${tmpCacheMS} ms while RAFS's own gate (which never caches) already denies. Use 0 unless this process is the only writer.`);
		}
		if ((typeof(this._authorization().RequireAction) === 'string') && !this._EntitlementsConfig && (typeof(this._authorization().Strategy) !== 'function'))
		{
			tmpWarnings.push(`Authorization.RequireAction is set but the server has no entitlementsConfig(): no principal carries actions, so no entity is readable.`);
		}
		return tmpWarnings;
	}

	/**
	 * Log the coverage table (entity → class).
	 */
	_logCoverage()
	{
		let tmpSnapshot = this._TenancySnapshot;
		if (!tmpSnapshot)
		{
			return;
		}
		let tmpRows = Object.keys(tmpSnapshot.Classes).sort().map((pEntity) => { return `${pEntity}=${tmpSnapshot.Classes[pEntity]}`; });
		this.fable.log.info(`RetoldFaceting host (ApplicationServer, ${tmpSnapshot.Phase}, ${tmpSnapshot.Source}): tenancy coverage [${tmpRows.join(', ')}].`);
	}

	// ---------------------------------------------------------------- coverage (§75)

	/**
	 * Build the coverage snapshot (§75.1) from the captured controllers.
	 *
	 * @param {string} pPhase - 'Hook' | 'Routes'
	 * @return {Record<string, any>}
	 */
	_buildTenancySnapshot(pPhase)
	{
		let tmpEntities = this._knownEntities();
		let tmpSnapshot = (
			{
				Phase: pPhase,
				Source: 'None',
				Column: null,
				Installed: new Set(),
				Excluded: new Set(),
				PersonalScopes: {},
				DeniedPrefixes: [],
				Classes: {}
			});
		if (!this._Tenancy)
		{
			tmpEntities.forEach((pEntity) => { tmpSnapshot.Classes[pEntity] = COVERAGE.None; });
			return tmpSnapshot;
		}
		tmpSnapshot.Column = this._TenancySpecs.Column;
		tmpSnapshot.Excluded = new Set(stringList(this._Tenancy.Exclude));
		tmpSnapshot.DeniedPrefixes = stringList(this._Tenancy.DeniedPrefixes);
		Object.keys(this._TenancySpecs.Personal).forEach(
			(pEntity) =>
			{
				let tmpSpec = this._TenancySpecs.Personal[pEntity];
				tmpSnapshot.PersonalScopes[pEntity] = { Column: tmpSpec.Column, SessionField: tmpSpec.SessionField, CustomGetValue: !!tmpSpec.CustomGetValue };
			});

		let tmpServer = this._ApplicationServer;
		if (tmpServer && (typeof(tmpServer.tenancyScopedEntities) === 'function'))
		{
			// [UPSTREAM RAFS-1]: the host says which entities it installed tenancy on.
			let tmpExported = tmpServer.tenancyScopedEntities();
			if (!Array.isArray(tmpExported))
			{
				throw new Error('tenancyScopedEntities() did not return an array.');
			}
			tmpSnapshot.Source = 'Export';
			stringList(tmpExported).forEach((pEntity) => { tmpSnapshot.Installed.add(pEntity); });
		}
		else
		{
			// The observed marker on each route-bound controller (Retold-Tenancy.js:433-437, :461).
			tmpSnapshot.Source = 'Marker';
			Object.keys(this._RouteBoundControllers).forEach(
				(pEntity) =>
				{
					let tmpInjection = this._RouteBoundControllers[pEntity].BehaviorInjection;
					if (tmpInjection && Array.isArray(tmpInjection[TENANCY_LAYERS_MARKER]) && (tmpInjection[TENANCY_LAYERS_MARKER].length > 0))
					{
						tmpSnapshot.Installed.add(pEntity);
					}
				});
		}
		tmpEntities.forEach((pEntity) => { tmpSnapshot.Classes[pEntity] = this._classify(pEntity, tmpSnapshot); });
		return tmpSnapshot;
	}

	/**
	 * The coverage class of one entity under a snapshot (§75.2).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSnapshot
	 * @return {string}
	 */
	_classify(pEntity, pSnapshot)
	{
		if (!this._Tenancy)
		{
			return COVERAGE.None;
		}
		if (!this.getRouteBoundController(pEntity))
		{
			return COVERAGE.Controllerless;
		}
		if (pSnapshot.Installed.has(pEntity))
		{
			if (!this.entityHasColumn(pEntity, pSnapshot.Column))
			{
				return COVERAGE.Misconfigured;
			}
			let tmpPersonal = hasOwn(this._TenancySpecs.Personal, pEntity) ? this._TenancySpecs.Personal[pEntity] : null;
			if (tmpPersonal && !this.entityHasColumn(pEntity, tmpPersonal.Column))
			{
				return COVERAGE.Misconfigured;
			}
			return COVERAGE.Installed;
		}
		if (pSnapshot.Excluded.has(pEntity))
		{
			return COVERAGE.Excluded;
		}
		return COVERAGE.Unguarded;
	}

	/**
	 * Route phase (§73.4): capture the route-bound controller of every entity registered in
	 * pServer.Endpoints since the hook phase (late mounts), re-classify (§75.2: a late mount carries no
	 * tenancy layer; an app hook between the phases may also have added one to an endpoint captured
	 * earlier), and notify the onModelChanged listeners when anything was captured OR any entity's class
	 * changed, so the catalog, the intake wraps, the mirror specs and the cache always follow the
	 * snapshot.  The checks that need the final coverage run again (header sessions on a late
	 * controller, PersonalScopes on a newly Installed entity): a failure is kept for routePhaseRefusal()
	 * and the host stops serving (fail closed).
	 *
	 * @return {Array<string>} the entities captured by this call
	 */
	captureLateMounts()
	{
		if (!this._Bound)
		{
			return [];
		}
		this._CapturePhase = 'Routes';
		let tmpPrevious = this._TenancySnapshot ? Object.assign({}, this._TenancySnapshot.Classes) : {};
		let tmpCaptured = this._captureRouteBoundControllers();
		try
		{
			this._TenancySnapshot = this._buildTenancySnapshot('Routes');
		}
		catch (pSnapshotError)
		{
			// The export failed now although it worked at bind: nothing new is Installed (fail closed).
			this.fable.log.error(`RetoldFaceting host (ApplicationServer): the tenancy coverage could not be refreshed: ${logSafe(pSnapshotError.message)}`);
			this._TenancySnapshot.Phase = 'Routes';
			this._TenancySnapshot.Installed = new Set();
			this._knownEntities().forEach((pEntity) => { this._TenancySnapshot.Classes[pEntity] = this._classify(pEntity, this._TenancySnapshot); });
		}
		this._ScopePolicy = null;
		this._Authorizer = undefined;
		let tmpClasses = this._TenancySnapshot.Classes;
		let tmpChanged = Object.keys(tmpClasses).filter((pEntity) => { return (tmpCaptured.indexOf(pEntity) < 0) && (tmpPrevious[pEntity] !== tmpClasses[pEntity]); }).sort();

		let tmpRefusal = this._headerSessionRefusal() || this._personalScopeCheck(this._TenancySnapshot).Refusal || this._scopeBehaviorRefusal();
		if (tmpRefusal)
		{
			this._RouteRefusal = tmpRefusal;
			this.fable.log.error(`RetoldFaceting host (ApplicationServer): the route phase refuses: ${tmpRefusal}`);
			// Fail closed until the boot stops: nothing is facetable, no principal resolves.
			this._Bound = false;
			return tmpCaptured;
		}
		if (tmpCaptured.length > 0)
		{
			let tmpCapturedClasses = tmpCaptured.map((pEntity) => { return `${pEntity}=${this.tenancyCoverage(pEntity)}`; });
			this.fable.log.info(`RetoldFaceting host (ApplicationServer): captured late-mounted endpoints [${tmpCapturedClasses.join(', ')}].`);
			tmpCaptured.forEach(
				(pEntity) =>
				{
					if ((this.tenancyCoverage(pEntity) === COVERAGE.Unguarded) && this._TenancySnapshot.Column && this.entityHasColumn(pEntity, this._TenancySnapshot.Column))
					{
						this.fable.log.warn(`RetoldFaceting host (ApplicationServer): ${logSafe(pEntity)} was mounted after tenancy and has the tenancy column ${logSafe(this._TenancySnapshot.Column)}: its list is not tenant-scoped, and it is never facetable.`);
					}
				});
		}
		if (tmpChanged.length > 0)
		{
			this.fable.log.info(`RetoldFaceting host (ApplicationServer): tenancy coverage changed between the phases [${tmpChanged.map((pEntity) => { return `${pEntity}: ${tmpPrevious[pEntity] || 'unknown'} → ${tmpClasses[pEntity]}`; }).join(', ')}].`);
		}
		if ((tmpCaptured.length > 0) || (tmpChanged.length > 0))
		{
			this.notifyModelChanged(this.getModelSync());
		}
		return tmpCaptured;
	}

	/**
	 * Why the route phase must fail the boot (set by captureLateMounts), or null.
	 *
	 * @return {string|null}
	 */
	routePhaseRefusal()
	{
		return this._RouteRefusal;
	}

	/**
	 * The coverage snapshot (§75.1), or null before bind.
	 *
	 * @return {Record<string, any>|null}
	 */
	tenancySnapshot()
	{
		return this._TenancySnapshot;
	}

	/**
	 * The coverage class of one entity (§75.2); 'None' before bind and on a host without tenancy;
	 * 'Controllerless' for a name the host does not know.
	 *
	 * @param {string} pEntity
	 * @return {string} one of COVERAGE
	 */
	tenancyCoverage(pEntity)
	{
		let tmpSnapshot = this._TenancySnapshot;
		if (!tmpSnapshot || !this._Tenancy)
		{
			return COVERAGE.None;
		}
		if ((typeof(pEntity) === 'string') && hasOwn(tmpSnapshot.Classes, pEntity))
		{
			return tmpSnapshot.Classes[pEntity];
		}
		return COVERAGE.Controllerless;
	}

	/**
	 * What the host's tenancy fence does not admit that faceting renders, and the stand-in the capture
	 * swaps in while a host behavior runs (§75.4).  null on a bound host without tenancy (no fence).
	 *
	 * @return {{ Swap: Record<string, string> }|null}
	 */
	fenceProfile()
	{
		if (this._Bound && !this._Tenancy)
		{
			return null;
		}
		return { Swap: FENCE_SWAP_OPERATORS };
	}

	/**
	 * The normalized scope policy (§75.3): Column from tenancyConfig(), SessionField = Column (the
	 * principal carries the tenancy getValue results under the column names), Exclude = every model
	 * entity that is not Installed, PersonalScopes only on Installed entities, Required / Guard /
	 * UnsetValues from Faceting.Scope.  Without tenancy: Scope.Required only (Kind 'None' when empty).
	 *
	 * @return {Record<string, any>}
	 */
	getScopePolicy()
	{
		if (this._ScopePolicy)
		{
			return this._ScopePolicy;
		}
		let tmpScope = isPlainObject(this.options.Scope) ? this.options.Scope : {};
		let fHasColumn = (pEntity, pColumn) => { return this.entityHasColumn(pEntity, pColumn); };
		if (!this._Bound && !this._TenancySnapshot)
		{
			// Before bind: no policy (nothing is facetable yet; not memoized).
			return this.buildScopePolicy({ Policy: false, Required: {} }, () => { return false; });
		}
		let tmpPolicyScope = { Policy: false, Required: tmpScope.Required, Guard: tmpScope.Guard, UnsetValues: tmpScope.UnsetValues };
		if (this._Tenancy && this._TenancySnapshot)
		{
			let tmpSnapshot = this._TenancySnapshot;
			let tmpExclude = [];
			let tmpPersonal = {};
			Object.keys(tmpSnapshot.Classes).forEach(
				(pEntity) =>
				{
					if (tmpSnapshot.Classes[pEntity] !== COVERAGE.Installed)
					{
						tmpExclude.push(pEntity);
						return;
					}
					if (hasOwn(this._TenancySpecs.Personal, pEntity))
					{
						let tmpColumn = this._TenancySpecs.Personal[pEntity].Column;
						tmpPersonal[pEntity] = { Column: tmpColumn, SessionField: tmpColumn };
					}
				});
			tmpPolicyScope.Policy = { Column: tmpSnapshot.Column, SessionField: tmpSnapshot.Column, Exclude: tmpExclude, PersonalScopes: tmpPersonal };
		}
		this._ScopePolicy = this.buildScopePolicy(tmpPolicyScope, fHasColumn);
		return this._ScopePolicy;
	}

	// ---------------------------------------------------------------- authorization (§77)

	/**
	 * The entitlement authorizer (§77): { Strategy, canRead(pEntity, pPrincipal) } — synchronous, over
	 * the action set resolvePrincipal put on the principal.  null without an entitlements config (and
	 * no Strategy function, no RequireAction).  Before bind it denies everything.
	 *
	 * @return {{ Strategy: string, canRead: (pEntity: string, pPrincipal: Record<string, any>) => boolean }|null}
	 */
	getAuthorizer()
	{
		if (!this._Bound)
		{
			return { Strategy: 'Unbound', canRead: () => { return false; } };
		}
		if (typeof(this._Authorizer) === 'undefined')
		{
			this._Authorizer = this._buildAuthorizer();
		}
		return this._Authorizer;
	}

	/**
	 * Build the authorizer of the bound configuration (getAuthorizer memoizes it per bind).
	 *
	 * @return {{ Strategy: string, canRead: (pEntity: string, pPrincipal: Record<string, any>) => boolean }|null}
	 */
	_buildAuthorizer()
	{
		let tmpAuthorization = this._authorization();
		let tmpRequireAction = ((typeof(tmpAuthorization.RequireAction) === 'string') && (tmpAuthorization.RequireAction.length > 0)) ? tmpAuthorization.RequireAction : null;
		let fCan = (pActions, pAction) =>
		{
			if (this._Entitlements)
			{
				return (this._Entitlements.can(pActions, pAction) === true);
			}
			return !!pActions && (typeof(pActions.has) === 'function') && pActions.has(pAction);
		};
		let fRequired = (pPrincipal) =>
		{
			return !tmpRequireAction || fCan(pPrincipal ? pPrincipal.Actions : null, tmpRequireAction);
		};
		if (typeof(tmpAuthorization.Strategy) === 'function')
		{
			let fStrategy = tmpAuthorization.Strategy;
			if (this._EntitlementsConfig)
			{
				// With entitlements the function only narrows RAFS's gate: never more permissive than the lists.
				return (
					{
						Strategy: 'EntitlementsAndFunction',
						canRead: (pEntity, pPrincipal) => { return this.entitlementCanRead(pEntity, pPrincipal) && (fStrategy(pEntity, pPrincipal) === true) && fRequired(pPrincipal); }
					});
			}
			return (
				{
					Strategy: 'Function',
					canRead: (pEntity, pPrincipal) => { return (fStrategy(pEntity, pPrincipal) === true) && fRequired(pPrincipal); }
				});
		}
		if (!this._EntitlementsConfig)
		{
			if (tmpRequireAction)
			{
				return { Strategy: 'RequireAction', canRead: (pEntity, pPrincipal) => { return fRequired(pPrincipal); } };
			}
			return null;
		}
		return (
			{
				Strategy: 'Entitlements',
				canRead: (pEntity, pPrincipal) => { return this.entitlementCanRead(pEntity, pPrincipal) && fRequired(pPrincipal); }
			});
	}

	/**
	 * The Retold-Entitlements read rule for one entity (§77.2), RequireAction aside: not in
	 * pServer.Endpoints → false; in ExcludeEntities → true for an authenticated principal (Kind 'User':
	 * the RAFS gate maps it to nothing, but faceting never serves an anonymous one); otherwise
	 * can(Actions, '<E>.read'), false without an action set.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPrincipal
	 * @return {boolean}
	 */
	entitlementCanRead(pEntity, pPrincipal)
	{
		if ((typeof(pEntity) !== 'string') || !this._EntitlementsConfig || !this._Entitlements)
		{
			return false;
		}
		// Read live, as the RAFS gate does (Retold-Entitlements.js:46-51).
		if (!hasOwn(this._endpointsMap(), pEntity))
		{
			return false;
		}
		if (stringList(this._EntitlementsConfig.ExcludeEntities).indexOf(pEntity) >= 0)
		{
			return !!pPrincipal && (pPrincipal.Kind === 'User');
		}
		let tmpActions = pPrincipal ? pPrincipal.Actions : null;
		if (!tmpActions)
		{
			return false;
		}
		return (this._Entitlements.can(tmpActions, `${pEntity}.read`) === true);
	}

	/**
	 * Is this principal a platform principal (Membership SystemAdminField === SystemAdminValue on the
	 * session UserRecord, §77.4)?  Admin routes only; never a tenancy or entitlement bypass.
	 *
	 * @param {Record<string, any>} pPrincipal
	 * @return {boolean}
	 */
	isPlatformPrincipal(pPrincipal)
	{
		return !!pPrincipal && (typeof(pPrincipal) === 'object') && (pPrincipal.Platform === true);
	}

	// ---------------------------------------------------------------- isFacetable (§78)

	/**
	 * Host.isFacetable on RAFS (§78; principal-independent: the catalog build calls it without one).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pPrincipal]
	 * @return {boolean}
	 */
	isFacetable(pEntity, pPrincipal)
	{
		if (!this._Bound)
		{
			return false;
		}
		// 1. a plain identifier, never NEVER_FACETABLE / Catalog.NeverFacet
		if ((typeof(pEntity) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pEntity))
		{
			return false;
		}
		if (libOptions.NEVER_FACETABLE.indexOf(pEntity) >= 0)
		{
			return false;
		}
		let tmpCatalog = isPlainObject(this.options.Catalog) ? this.options.Catalog : {};
		if (stringList(tmpCatalog.NeverFacet).indexOf(pEntity) >= 0)
		{
			return false;
		}
		// 2. a DAL, a model table, a route-bound controller with its Reads routes, a supported dialect
		if (!this.getDAL(pEntity) || !this.getEntityModel(pEntity))
		{
			return false;
		}
		// 2b. an app that listed the table in an ARRAY NoAutoCRUDTables meant to hide it (RAFS mounted it
		// anyway, a boot warning): fail closed on the intent.
		let tmpServer = this._ApplicationServer;
		if (tmpServer && Array.isArray(tmpServer.NoAutoCRUDTables) && (tmpServer.NoAutoCRUDTables.indexOf(pEntity) >= 0))
		{
			return false;
		}
		if (!this.getRouteBoundController(pEntity))
		{
			this._warnUncaptured(pEntity);
			return false;
		}
		if (!this.hasConnectedReadRoutes(pEntity) || !this.getDialectProfile(pEntity).Supported)
		{
			return false;
		}
		// 3. the tenancy DeniedPrefixes hide its CRUD routes
		if (this._Tenancy && RetoldFacetingHostApplicationServer.deniedByPrefixes(pEntity, this._TenancySnapshot.DeniedPrefixes, this._endpointVersion(pEntity), this._endpointPrefix(pEntity)))
		{
			return false;
		}
		// 4. coverage
		let tmpGlobal = stringList(tmpCatalog.GlobalEntities);
		let tmpClass = this.tenancyCoverage(pEntity);
		switch (tmpClass)
		{
			case COVERAGE.Installed:
				return true;
			case COVERAGE.None:
			{
				// Plain RDS semantics (a Scope.Required-only policy may still make it scoped).
				let tmpPolicy = this.getScopePolicy();
				if ((tmpPolicy.Kind === 'Policy') && !tmpPolicy.isScoped(pEntity))
				{
					return (tmpGlobal.indexOf(pEntity) >= 0);
				}
				return true;
			}
			case COVERAGE.Excluded:
			case COVERAGE.Unguarded:
				if ((tmpClass === COVERAGE.Unguarded) && this.entityHasColumn(pEntity, this._TenancySnapshot.Column))
				{
					// Its list is unscoped while the app meant it scoped: never.
					return false;
				}
				// 5. root / identity tables are never facetable while Global
				if (this._IdentityTables.indexOf(pEntity) >= 0)
				{
					return false;
				}
				return (tmpGlobal.indexOf(pEntity) >= 0);
			default:
				// Misconfigured, Controllerless
				return false;
		}
	}

	/**
	 * The meadow-endpoints route version of an entity's routes (DeniedPrefixes are matched against it).
	 *
	 * @param {string} pEntity
	 * @return {string}
	 */
	_endpointVersion(pEntity)
	{
		let tmpEndpoint = hasOwn(this._RouteBoundEndpoints, pEntity) ? this._RouteBoundEndpoints[pEntity] : null;
		return (tmpEndpoint && (typeof(tmpEndpoint.EndpointVersion) === 'string') && (tmpEndpoint.EndpointVersion.length > 0)) ? tmpEndpoint.EndpointVersion : DEFAULT_ROUTE_VERSION;
	}

	/**
	 * Where meadow-endpoints mounted the entity's routes (its EndpointPrefix, '/<version>/<DAL.scope>'),
	 * or null.
	 *
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	_endpointPrefix(pEntity)
	{
		let tmpEndpoint = hasOwn(this._RouteBoundEndpoints, pEntity) ? this._RouteBoundEndpoints[pEntity] : null;
		return (tmpEndpoint && (typeof(tmpEndpoint.EndpointPrefix) === 'string') && (tmpEndpoint.EndpointPrefix.length > 0)) ? tmpEndpoint.EndpointPrefix : null;
	}

	/**
	 * An entity in pServer.Endpoints that was registered after the route phase captured controllers
	 * (§73.4 step 4): never facetable; the log names it once.
	 *
	 * @param {string} pEntity
	 */
	_warnUncaptured(pEntity)
	{
		if ((this._CapturePhase !== 'Routes') || this._UncapturedWarned.has(pEntity))
		{
			return;
		}
		if (!RetoldFacetingHostApplicationServer.endpointController(hasOwn(this._endpointsMap(), pEntity) ? this._endpointsMap()[pEntity] : null))
		{
			return;
		}
		this._UncapturedWarned.add(pEntity);
		this.fable.log.warn(`RetoldFaceting host (ApplicationServer): ${logSafe(pEntity)} was registered in pServer.Endpoints after foundationRouteInstaller ran, so it is never facetable (put the faceting route installer LAST in routeInstallers()).`);
	}

	// ---------------------------------------------------------------- principal (§76)

	/**
	 * The persona field: with entitlements exactly entitlementsConfig().IdentityUserField, the field
	 * RAFS's enrichment writes and its gate reads (the bind refuses a config without it, so there is no
	 * default to disagree on); without entitlements 'IDUser'.
	 *
	 * @return {string}
	 */
	_identityUserField()
	{
		return this._EntitlementsConfig ? String(this._EntitlementsConfig.IdentityUserField) : DEFAULT_IDENTITY_USER_FIELD;
	}

	/**
	 * The principal's raw parts from a RAFS UserSession (§76.1).  Throws when the TENANCY getValue throws
	 * (no principal at all).  The getValue functions are called only for an authenticated session (a
	 * UserRecord), exactly when the RAFS guard calls them (Retold-Tenancy.js:400-404); an anonymous
	 * session's columns are 0.  Each personal-scope column is computed in isolation: a personal getValue
	 * that throws leaves its column null and names it in Unresolved, so only requests that reference an
	 * entity needing that column fail (FACET_INTERNAL at the root, denied as a hop or label target).
	 *
	 * @param {any} pUserSession
	 * @return {{ Kind: string, Record: Record<string, any>|null, IDUser: any, IDCustomer: any, SessionData: Record<string, any>, Platform: boolean, Unresolved: Array<string> }}
	 */
	_principalParts(pUserSession)
	{
		let tmpSession = ((typeof(pUserSession) === 'object') && (pUserSession !== null)) ? pUserSession : {};
		let tmpRecord = (isPlainObject(tmpSession.UserRecord) && !Array.isArray(tmpSession.UserRecord)) ? tmpSession.UserRecord : null;
		let tmpKind = tmpRecord ? 'User' : 'Anonymous';
		let tmpIDUser = (tmpRecord && tmpRecord[this._identityUserField()]) || 0;

		let tmpColumns = {};
		let tmpUnresolved = [];
		let tmpSpecs = this._TenancySpecs;
		if (tmpSpecs)
		{
			tmpColumns[tmpSpecs.Column] = tmpRecord ? tmpSpecs.getValue(tmpSession) : 0;
			let tmpClasses = this._TenancySnapshot ? this._TenancySnapshot.Classes : {};
			Object.keys(tmpSpecs.Personal).forEach(
				(pEntity) =>
				{
					let tmpPersonal = tmpSpecs.Personal[pEntity];
					if ((tmpClasses[pEntity] !== COVERAGE.Installed) || hasOwn(tmpColumns, tmpPersonal.Column))
					{
						return;
					}
					if (!tmpRecord)
					{
						tmpColumns[tmpPersonal.Column] = 0;
						return;
					}
					try
					{
						tmpColumns[tmpPersonal.Column] = tmpPersonal.getValue(tmpSession);
					}
					catch (pValueError)
					{
						tmpColumns[tmpPersonal.Column] = null;
						tmpUnresolved.push(tmpPersonal.Column);
						let tmpKey = `${pEntity}.${tmpPersonal.Column}`;
						if (!this._ScopeValueErrorsLogged.has(tmpKey))
						{
							this._ScopeValueErrorsLogged.add(tmpKey);
							this.fable.log.error(`RetoldFaceting host (ApplicationServer): the PersonalScopes getValue of ${logSafe(pEntity)} (${logSafe(tmpPersonal.Column)}) threw: ${logSafe(pValueError && pValueError.message)}; requests that need that column fail (logged once).`);
						}
					}
				});
		}
		let tmpIDCustomer = tmpSpecs ? tmpColumns[tmpSpecs.Column] : ((tmpRecord && tmpRecord.IDCustomer) || 0);

		// The session's own top-level keys ($Scope.<Name> binding reads them, as the meadow session data
		// would), then the principal fields, then the scope columns (which always win).
		let tmpSessionData = {};
		Object.keys(tmpSession).forEach((pKey) => { if (pKey !== 'UserRecord') { tmpSessionData[pKey] = tmpSession[pKey]; } });
		tmpSessionData.LoggedIn = (tmpKind === 'User');
		tmpSessionData.UserID = tmpIDUser;
		tmpSessionData.CustomerID = tmpIDCustomer;
		Object.keys(tmpColumns).forEach((pColumn) => { tmpSessionData[pColumn] = tmpColumns[pColumn]; });

		let tmpPlatform = !!(this._PlatformRule && tmpRecord && hasOwn(tmpRecord, this._PlatformRule.Field) && (tmpRecord[this._PlatformRule.Field] === this._PlatformRule.Value));
		// The tenant the action set is resolved in: exactly what RAFS's gate passes (UserRecord[TenantField]
		// || 0, Retold-Entitlements.js:288), which an app tenancy getValue need not equal.
		let tmpActionTenant = (this._EntitlementsConfig && tmpRecord) ? (tmpRecord[String(this._EntitlementsConfig.TenantField)] || 0) : tmpIDCustomer;
		return { Kind: tmpKind, Record: tmpRecord, IDUser: tmpIDUser, IDCustomer: tmpIDCustomer, ActionTenant: tmpActionTenant, SessionData: tmpSessionData, Platform: tmpPlatform, Unresolved: tmpUnresolved };
	}

	/**
	 * The base principal of a parts object (the shared §12.2 builder: $CurrentUser / $Scope / Required
	 * binding unchanged).
	 *
	 * @param {Record<string, any>} pParts - _principalParts()
	 * @param {string} [pSource]
	 * @return {Readonly<Record<string, any>>}
	 */
	_basePrincipal(pParts, pSource)
	{
		return super.buildPrincipal(pParts.SessionData, { UserSession: { UserRecord: pParts.Record || {} } }, (typeof(pSource) === 'string') ? pSource : 'InProcess');
	}

	/**
	 * The principal of a request (§76): the request's session (_requestSession), IDUser-enriched with
	 * RAFS's own Entitlements.resolveIDUser when entitlements are on and the persona is not on the
	 * UserRecord yet, built with the tenancy getValue functions, then (entitlements on) the persona's
	 * action set, RoleSetHash, Platform.
	 *
	 * @param {any} pRequest
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	resolvePrincipal(pRequest, fCallback)
	{
		if (!this._Bound)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostApplicationServer is not bound to a RetoldApplicationServer.'));
		}
		this._requestSession(pRequest,
			(pSessionError, pSession) =>
			{
				if (pSessionError)
				{
					this.fable.log.error(`RetoldFaceting host (ApplicationServer): the session could not be resolved: ${logSafe(pSessionError.message)}`);
					return fCallback(libFacetErrors.create('FACET_INTERNAL'));
				}
				return this._principalForSession(pSession, fCallback);
			});
	}

	/**
	 * Re-resolve the principal of an open change stream (Host.revalidatePrincipal, internal-contracts
	 * §46.4 / §76.5): the session is read again from the source the tenancy pre-handler uses
	 * (tenancyConfig().resolveSession, else orator-authentication), never from the snapshot the stream
	 * opened with, then built exactly as resolvePrincipal builds it.  A logged-out or expired session is
	 * anonymous, a role change changes RoleSetHash: the SSE service closes the stream on either.  A
	 * cookie session's LastAccess is restored after the read (a revalidation is not user activity, so a
	 * sliding session still lapses).  Errors call back (the stream closes: fail closed).
	 *
	 * @param {any} pRequest - the request the stream was opened with
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	revalidatePrincipal(pRequest, fCallback)
	{
		if (!this._Bound)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostApplicationServer is not bound to a RetoldApplicationServer.'));
		}
		let fResolve = null;
		if (this._Tenancy && (typeof(this._Tenancy.resolveSession) === 'function'))
		{
			fResolve = this._Tenancy.resolveSession;
		}
		else
		{
			let tmpAuthentication = this._authentication();
			if (tmpAuthentication && (typeof(tmpAuthentication.resolveSessionForRequest) === 'function'))
			{
				fResolve = (pSessionRequest, fSessionCallback) => { return tmpAuthentication.resolveSessionForRequest(pSessionRequest, fSessionCallback); };
			}
		}
		if (!fResolve || !pRequest || (typeof(pRequest) !== 'object'))
		{
			return this._principalForSession({}, fCallback);
		}
		let tmpPrevious = (pRequest.UserSession && (typeof(pRequest.UserSession) === 'object')) ? pRequest.UserSession : null;
		let tmpLastAccess = tmpPrevious ? tmpPrevious.LastAccess : undefined;
		let tmpCalledBack = false;
		let fSession = (pError, pSession) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			if (pSession && (pSession === tmpPrevious) && (typeof(tmpLastAccess) !== 'undefined'))
			{
				pSession.LastAccess = tmpLastAccess;
			}
			if (pError)
			{
				return fCallback(pError);
			}
			return this._principalForSession(pSession || {}, fCallback);
		};
		try
		{
			fResolve(pRequest, fSession);
		}
		catch (pResolveError)
		{
			if (tmpCalledBack)
			{
				throw pResolveError;
			}
			fSession(pResolveError);
		}
	}

	/**
	 * The session of a request (§76.1): pRequest.UserSession whenever something set it (the tenancy
	 * pre-handler for every HTTP request on a tenancy app, the caller in-process).  On a server with NO
	 * tenancy (so no pre-handler resolves sessions) and orator-authentication mounted, an HTTP request's
	 * session is resolved with RAFS's own fable.OratorAuthentication.resolveSessionForRequest (cookie,
	 * then bearer token) — the resolver the tenancy pre-handler would have called.  It is used for the
	 * principal only: pRequest.UserSession is not set, so the entity behaviors see what the lists see.
	 * Otherwise anonymous.
	 *
	 * @param {any} pRequest
	 * @param {(pError?: Error, pSession?: any) => void} fCallback
	 */
	_requestSession(pRequest, fCallback)
	{
		if (!pRequest || (typeof(pRequest) !== 'object'))
		{
			return fCallback(null, null);
		}
		let tmpAuthentication = this._Tenancy ? null : this._authentication();
		if (('UserSession' in pRequest) || !tmpAuthentication || (typeof(tmpAuthentication.resolveSessionForRequest) !== 'function'))
		{
			return fCallback(null, pRequest.UserSession);
		}
		let tmpCalledBack = false;
		try
		{
			tmpAuthentication.resolveSessionForRequest(pRequest,
				(pError, pSession) =>
				{
					if (tmpCalledBack)
					{
						return;
					}
					tmpCalledBack = true;
					return fCallback(pError || null, pSession || {});
				});
		}
		catch (pResolveError)
		{
			if (tmpCalledBack)
			{
				throw pResolveError;
			}
			tmpCalledBack = true;
			return fCallback(pResolveError);
		}
	}

	/**
	 * Write the persona onto an authenticated session exactly as RAFS's entitlements pre-handler does
	 * (UserRecord[IdentityUserField] = Entitlements.resolveIDUser(…), Retold-Entitlements.js:278-286), when
	 * entitlements are on and the record does not carry one yet: an in-process session (a job, a fresh
	 * Account-row session no HTTP request enriched) then gets the persona the guard will read, because
	 * the guard reads the same UserRecord.  A module without resolveIDUser enriches nothing (documented).
	 *
	 * @param {any} pSession
	 * @param {(pError?: Error) => void} fCallback
	 */
	_enrichPersona(pSession, fCallback)
	{
		let tmpConfig = this._EntitlementsConfig;
		let tmpModule = this._Entitlements;
		let tmpRecord = (pSession && (typeof(pSession) === 'object') && isPlainObject(pSession.UserRecord)) ? pSession.UserRecord : null;
		if (!tmpConfig || !tmpModule || (typeof(tmpModule.resolveIDUser) !== 'function') || !tmpRecord)
		{
			return fCallback();
		}
		let tmpField = String(tmpConfig.IdentityUserField);
		if (tmpRecord[tmpField])
		{
			return fCallback();
		}
		let tmpCalledBack = false;
		try
		{
			tmpModule.resolveIDUser(this._ApplicationServer, tmpConfig, pSession,
				(pError, pIDUser) =>
				{
					if (tmpCalledBack)
					{
						return;
					}
					tmpCalledBack = true;
					if (pError)
					{
						return fCallback(pError);
					}
					tmpRecord[tmpField] = pIDUser;
					return fCallback();
				});
		}
		catch (pEnrichError)
		{
			if (tmpCalledBack)
			{
				throw pEnrichError;
			}
			tmpCalledBack = true;
			return fCallback(pEnrichError);
		}
	}

	/**
	 * Build the principal of a resolved session (resolvePrincipal and revalidatePrincipal share it).
	 *
	 * @param {any} pSession
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	_principalForSession(pSession, fCallback)
	{
		this._enrichPersona(pSession,
			(pEnrichError) =>
			{
				if (pEnrichError)
				{
					this.fable.log.error(`RetoldFaceting host (ApplicationServer): the persona could not be resolved: ${logSafe(pEnrichError.message)}`);
					return fCallback(libFacetErrors.create('FACET_INTERNAL'));
				}
				let tmpParts = null;
				let tmpBase = null;
				try
				{
					tmpParts = this._principalParts(pSession);
					tmpBase = this._basePrincipal(tmpParts, 'InProcess');
				}
				catch (pPrincipalError)
				{
					this.fable.log.error(`RetoldFaceting host (ApplicationServer): principal construction failed (a tenancy getValue threw?): ${logSafe(pPrincipalError.message)}`);
					return fCallback(libFacetErrors.create('FACET_INTERNAL'));
				}
				let fFinish = (pActions) =>
				{
					let tmpPrincipal = Object.assign({}, tmpBase,
						{
							RoleSetHash: pActions ? roleSetHash(pActions) : '',
							Platform: tmpParts.Platform
						});
					if (pActions)
					{
						Object.defineProperty(tmpPrincipal, 'Actions', { value: new Set(pActions), enumerable: false, writable: false, configurable: false });
					}
					if (tmpParts.Unresolved.length > 0)
					{
						Object.defineProperty(tmpPrincipal, 'UnresolvedScopeColumns', { value: Object.freeze(tmpParts.Unresolved.slice()), enumerable: false, writable: false, configurable: false });
					}
					return fCallback(null, Object.freeze(tmpPrincipal));
				};
				if (!this._EntitlementsConfig || !this._Entitlements)
				{
					return fFinish(null);
				}
				this._resolveActions(tmpParts.IDUser, tmpParts.ActionTenant,
					(pActionsError, pActions) =>
					{
						if (pActionsError)
						{
							this.fable.log.error(`RetoldFaceting host (ApplicationServer): the entitlements could not be resolved: ${logSafe(pActionsError.message)}`);
							return fCallback(libFacetErrors.create('FACET_INTERNAL'));
						}
						return fFinish(pActions);
					});
			});
	}

	/**
	 * The action set of a persona (§77.3): Retold-Entitlements resolveActions, cached per (IDUser,
	 * IDCustomer) for Authorization.EntitlementCacheMS (0 disables), at most ENTITLEMENT_CACHE_MAX_ENTRIES
	 * (oldest dropped).  IDUser 0 → the empty set.  Calls back exactly once, never synchronously from
	 * inside the module's own callback chain twice.
	 *
	 * @param {any} pIDUser
	 * @param {any} pIDCustomer
	 * @param {(pError?: Error, pActions?: Set<string>) => void} fCallback
	 */
	_resolveActions(pIDUser, pIDCustomer, fCallback)
	{
		let tmpIDUser = normalizeScopeValue(pIDUser);
		let tmpTenant = normalizeScopeValue(pIDCustomer);
		if ((tmpIDUser === null) || (tmpIDUser === 0) || (tmpIDUser === ''))
		{
			return fCallback(null, new Set());
		}
		let tmpTTL = this._entitlementCacheMS();
		let tmpKey = JSON.stringify([ tmpIDUser, tmpTenant ]);
		if (tmpTTL > 0)
		{
			let tmpEntry = this._EntitlementCache.get(tmpKey);
			if (tmpEntry && ((Date.now() - tmpEntry.At) < tmpTTL))
			{
				return fCallback(null, tmpEntry.Actions);
			}
			if (tmpEntry)
			{
				this._EntitlementCache.delete(tmpKey);
			}
		}
		let tmpEpoch = this._EntitlementEpoch;
		let tmpCalledBack = false;
		let fDone = (pError, pResult) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpActions = (pResult && pResult.Actions && (typeof(pResult.Actions.has) === 'function') && (typeof(pResult.Actions.forEach) === 'function')) ? pResult.Actions : null;
			if (!tmpActions)
			{
				return fCallback(new Error('resolveActions returned no action set.'));
			}
			tmpActions = new Set(tmpActions);
			// A role-table write that landed while this read ran invalidated it already: do not store.
			if ((tmpTTL > 0) && (tmpEpoch === this._EntitlementEpoch))
			{
				this._EntitlementCache.set(tmpKey, { Actions: tmpActions, Tenant: tmpTenant, At: Date.now() });
				while (this._EntitlementCache.size > ENTITLEMENT_CACHE_MAX_ENTRIES)
				{
					this._EntitlementCache.delete(this._EntitlementCache.keys().next().value);
				}
			}
			return fCallback(null, tmpActions);
		};
		try
		{
			this._Entitlements.resolveActions(this._ApplicationServer, this._EntitlementsConfig, pIDUser, pIDCustomer, fDone);
		}
		catch (pResolveError)
		{
			if (tmpCalledBack)
			{
				// Thrown downstream of our own callback (not ours to swallow).
				throw pResolveError;
			}
			return fDone(pResolveError);
		}
	}

	/**
	 * The synchronous principal of a WRITE (the change intake's Actor, §76.4): the same sources as
	 * resolvePrincipal from pRequest.UserSession (never pSessionData), without the action set
	 * (RoleSetHash ''; the intake keys read-your-writes by Util.principalIdentityKey).
	 *
	 * @param {Record<string, any>} pSessionData - ignored on RAFS (the tenancy guard reads pRequest.UserSession)
	 * @param {any} [pRequest]
	 * @param {string} [pSource]
	 * @return {Readonly<Record<string, any>>}
	 */
	buildPrincipal(pSessionData, pRequest, pSource)
	{
		if (!this._Bound)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostApplicationServer is not bound to a RetoldApplicationServer.');
		}
		let tmpUserSession = (pRequest && (typeof(pRequest) === 'object')) ? pRequest.UserSession : null;
		let tmpParts = this._principalParts(tmpUserSession);
		let tmpBase = this._basePrincipal(tmpParts, pSource);
		return Object.freeze(Object.assign({}, tmpBase, { RoleSetHash: '', Platform: tmpParts.Platform }));
	}

	// ---------------------------------------------------------------- change capture (§79)

	/**
	 * Entities the RAFS chassis writes DAL-direct, which no interim wrapper sees (§79.2): Membership's
	 * tenant root / account / persona tables, the entitlement role tables, the record-grant table, the
	 * comms tables, the profile persona (and account) table, Reconcile.RawWriterEntities.
	 * ChangeIntake.covers(E) is false for them unless ChangeCapture.NotifyManaged names them.
	 *
	 * @return {Array<string>}
	 */
	rawWriterEntities()
	{
		let tmpServer = this._ApplicationServer;
		let tmpEntities = [];
		let fAdd = (pName) =>
		{
			if ((typeof(pName) === 'string') && (pName.length > 0) && (tmpEntities.indexOf(pName) < 0))
			{
				tmpEntities.push(pName);
			}
		};
		if (tmpServer)
		{
			let tmpMembership = isPlainObject(tmpServer.MembershipConfig) ? tmpServer.MembershipConfig : null;
			if (tmpMembership)
			{
				[ 'CustomerTable', 'AccountTable', 'PersonaTable' ].forEach((pKey) => { fAdd(tmpMembership[pKey]); });
			}
			let tmpEntitlements = this._EntitlementsConfig;
			if (tmpEntitlements)
			{
				[ 'RoleTable', 'RoleActionTable', 'UserRoleTable', 'UserActionTable' ].forEach((pKey) => { fAdd(tmpEntitlements[pKey]); });
			}
			let tmpRecordLevel = isPlainObject(tmpServer.RecordLevelConfig) ? tmpServer.RecordLevelConfig : null;
			if (tmpRecordLevel)
			{
				fAdd(tmpRecordLevel.GrantTable);
			}
			let tmpComms = isPlainObject(tmpServer.CommsConfig) ? tmpServer.CommsConfig : null;
			if (tmpComms)
			{
				[ 'OutboxTable', 'DevInboxTable', 'TemplateTable', 'ChallengeTable', 'NotificationPrefTable', 'AccountTable', 'PersonaTable' ].forEach((pKey) => { fAdd(tmpComms[pKey]); });
			}
			let tmpProfile = this._serverConfig('profileConfig', 'Profile');
			if (tmpProfile)
			{
				// Retold-Profile.js:30-48 (its resolved config is not stamped on the server)
				let tmpProfileConfig = isPlainObject(tmpProfile) ? tmpProfile : {};
				let tmpLocal = this._authLocal() || {};
				fAdd(nonEmptyString(tmpProfileConfig.PersonaTable, null) || nonEmptyString(tmpLocal.MembershipTable, null));
				fAdd(nonEmptyString(tmpProfileConfig.AccountTable, null) || nonEmptyString(tmpLocal.UserTable, null) || 'Account');
			}
		}
		let tmpReconcile = isPlainObject(this.options.Reconcile) ? this.options.Reconcile : {};
		stringList(tmpReconcile.RawWriterEntities).forEach(fAdd);
		return tmpEntities;
	}

	/**
	 * Called by the service after ChangeIntake.install() (§79.3): re-checks the role-table DAL wraps
	 * (installed at bind; independent of facetability) and subscribes the entitlement-cache invalidator
	 * ('RAFSEntitlements', after 'Generations' and 'ReadYourWrites'), which also hears notify() events an
	 * app sends for the role tables (e.g. a bridge relaying another process's writes).
	 *
	 * @param {any} pIntake - RetoldFacetingChangeIntake
	 * @return {boolean} true when entitlements are on (something is installed)
	 */
	installChangeIntake(pIntake)
	{
		if (!this._EntitlementsConfig)
		{
			return false;
		}
		this._wrapRoleTableDALs();
		if (pIntake && (typeof(pIntake.subscribe) === 'function'))
		{
			pIntake.subscribe(ENTITLEMENT_SUBSCRIBER, (pEvent) => { this.onEntitlementChange(pEvent); });
		}
		return true;
	}

	/**
	 * The role tables of the entitlements config (RoleTable, RoleActionTable, UserRoleTable,
	 * UserActionTable; those it names).
	 *
	 * @return {Array<string>}
	 */
	_roleTables()
	{
		let tmpConfig = this._EntitlementsConfig;
		if (!tmpConfig)
		{
			return [];
		}
		let tmpTables = [];
		ROLE_TABLE_KEYS.forEach(
			(pKey) =>
			{
				let tmpName = nonEmptyString(tmpConfig[pKey], null);
				if (tmpName && (tmpTables.indexOf(tmpName) < 0))
				{
					tmpTables.push(tmpName);
				}
			});
		return tmpTables;
	}

	/**
	 * Wrap the write methods of every role table's DAL (pServer.DAL[T], the same object its route-bound
	 * controller writes through) with an invalidation-only hook (§77.3, §79.3): whatever writes a role
	 * table in this process — RAFS's CRUD routes, Entitlements.grantRole / provisionDefaultRoles, app
	 * code — drops the cached action sets and revalidates open change streams, whether or not the table
	 * is facetable (NeverFacet, DeniedPrefixes, Exclude, NoAutoCRUD) and whether or not the write was
	 * armed by the change intake.  Installed at bind, before the intake wraps (so the intake's own wrapper
	 * stays outermost on a facetable role table); idempotent (a method whose wrapper chain already holds
	 * ours is left alone).  Never throws.
	 *
	 * @return {Array<string>} '<Table>.<method>' wrapped by this call
	 */
	_wrapRoleTableDALs()
	{
		let tmpWrapped = [];
		let tmpDALs = this._dalMap();
		this._roleTables().forEach(
			(pTable) =>
			{
				let tmpDAL = hasOwn(tmpDALs, pTable) ? tmpDALs[pTable] : null;
				if (!tmpDAL || (typeof(tmpDAL) !== 'object'))
				{
					return;
				}
				DAL_WRITE_METHODS.forEach(
					(pMethod) =>
					{
						try
						{
							let fCurrent = tmpDAL[pMethod];
							if ((typeof(fCurrent) !== 'function') || this._roleWrapInChain(fCurrent))
							{
								return;
							}
							tmpDAL[pMethod] = this._roleWriteWrapper(pTable, pMethod, fCurrent);
							tmpWrapped.push(`${pTable}.${pMethod}`);
						}
						catch (pWrapError)
						{
							this.fable.log.error(`RetoldFaceting host (ApplicationServer): the entitlement invalidation could not wrap ${logSafe(pTable)}.${pMethod}: ${logSafe(pWrapError.message)}`);
						}
					});
			});
		return tmpWrapped;
	}

	/**
	 * Does a DAL method's wrapper chain (ours, the interim intake's) hold this host's invalidation wrapper?
	 *
	 * @param {Function} fFunction
	 * @return {boolean}
	 */
	_roleWrapInChain(fFunction)
	{
		let fCurrent = fFunction;
		for (let i = 0; (i < MAX_WRAP_DEPTH) && (typeof(fCurrent) === 'function'); i++)
		{
			let tmpOurs = fCurrent[ENTITLEMENT_WRAP_MARKER];
			if (tmpOurs && (tmpOurs.Host === this))
			{
				return true;
			}
			let tmpIntake = fCurrent[INTAKE_WRAP_MARKER];
			fCurrent = tmpOurs ? tmpOurs.Original : (tmpIntake ? tmpIntake.Original : null);
		}
		return false;
	}

	/**
	 * The invalidation wrapper of one role-table DAL write method: the epoch moves when the write starts
	 * (a resolution racing it is never cached) and the cache is dropped (and streams revalidated) when it
	 * calls back, error or not (the write may have committed).  Passes every argument and result through.
	 *
	 * @param {string} pTable
	 * @param {Function} fOriginal
	 * @return {Function}
	 */
	_roleWriteWrapper(pTable, pMethod, fOriginal)
	{
		let tmpSelf = this;
		let fWrapped = function (pQuery, fCallback)
		{
			tmpSelf._EntitlementEpoch++;
			if (typeof(fCallback) !== 'function')
			{
				return fOriginal.apply(this, arguments);
			}
			// Read before the write runs (a behavior or the DAL may rewrite the query afterwards).
			let tmpTenants = tmpSelf._roleWriteTenants(pTable, pMethod, pQuery);
			let fObserved = function (...pResults)
			{
				tmpSelf._onRoleTableWrite(pTable, tmpTenants);
				return fCallback.apply(this, pResults);
			};
			return fOriginal.call(this, pQuery, fObserved);
		};
		Object.defineProperty(fWrapped, ENTITLEMENT_WRAP_MARKER, { value: { Host: this, Table: pTable, Original: fOriginal }, enumerable: false });
		return fWrapped;
	}

	/**
	 * The tenant column of a role table: the tenancy column when the table has it, else 'IDCustomer'
	 * (Retold-Entitlements writes role rows with IDCustomer, Retold-Entitlements.js grantRole /
	 * provisionDefaultRoles), else null.
	 *
	 * @param {string} pTable
	 * @return {string|null}
	 */
	_roleTenantColumn(pTable)
	{
		let tmpColumn = this._TenancySpecs ? this._TenancySpecs.Column : null;
		if (tmpColumn && this.entityHasColumn(pTable, tmpColumn))
		{
			return tmpColumn;
		}
		return this.entityHasColumn(pTable, DEFAULT_TENANCY_COLUMN) ? DEFAULT_TENANCY_COLUMN : null;
	}

	/**
	 * The tenants a role-table DAL write can change, from its FoxHound query, or [ '*' ] when that cannot
	 * be proven (fail closed: every entry).  A create names them in its records (every record must carry
	 * a scalar tenant); an update or delete names one only through a top-level '=' stanza on the tenant
	 * column in a filter with no top-level OR (RAFS's tenancy guard appends exactly that after its outer
	 * group), plus, for an update, the tenant its record stamps.  Pure over the query; never throws.
	 *
	 * @param {string} pTable
	 * @param {string} pMethod - doCreate | doUpdate | doDelete | doUndelete
	 * @param {any} pQuery
	 * @return {Array<any>}
	 */
	_roleWriteTenants(pTable, pMethod, pQuery)
	{
		try
		{
			let tmpColumn = this._roleTenantColumn(pTable);
			if (!tmpColumn || !pQuery || (typeof(pQuery) !== 'object'))
			{
				return [ UNKNOWN_TENANT ];
			}
			let tmpTenants = [];
			let fAdd = (pValue) =>
			{
				let tmpValue = normalizeScopeValue(pValue);
				if ((tmpValue === null) || (typeof(tmpValue) === 'undefined') || (typeof(tmpValue) === 'object'))
				{
					return false;
				}
				if (tmpTenants.indexOf(tmpValue) < 0)
				{
					tmpTenants.push(tmpValue);
				}
				return true;
			};
			let tmpRecords = (pQuery.query && Array.isArray(pQuery.query.records)) ? pQuery.query.records : [];
			if (pMethod === 'doCreate')
			{
				if ((tmpRecords.length < 1) || !tmpRecords.every((pRecord) => { return isPlainObject(pRecord) && fAdd(pRecord[tmpColumn]); }))
				{
					return [ UNKNOWN_TENANT ];
				}
				return tmpTenants;
			}
			let tmpFilters = (pQuery.parameters && Array.isArray(pQuery.parameters.filter)) ? pQuery.parameters.filter : [];
			let tmpDepth = 0;
			let tmpScoped = false;
			for (let i = 0; i < tmpFilters.length; i++)
			{
				let tmpStanza = tmpFilters[i];
				if (!tmpStanza || (typeof(tmpStanza) !== 'object'))
				{
					return [ UNKNOWN_TENANT ];
				}
				if ((tmpDepth === 0) && (i > 0) && (String(tmpStanza.Connector).toUpperCase() === 'OR'))
				{
					return [ UNKNOWN_TENANT ];
				}
				if (tmpStanza.Operator === '(')
				{
					tmpDepth++;
					continue;
				}
				if (tmpStanza.Operator === ')')
				{
					tmpDepth--;
					continue;
				}
				if (tmpStanza.Column !== tmpColumn)
				{
					continue;
				}
				if ((tmpDepth !== 0) || (tmpStanza.Operator !== '=') || !fAdd(tmpStanza.Value))
				{
					return [ UNKNOWN_TENANT ];
				}
				tmpScoped = true;
			}
			if (!tmpScoped)
			{
				return [ UNKNOWN_TENANT ];
			}
			if (pMethod === 'doUpdate')
			{
				tmpRecords.forEach((pRecord) => { if (isPlainObject(pRecord) && hasOwn(pRecord, tmpColumn)) { fAdd(pRecord[tmpColumn]); } });
			}
			return tmpTenants;
		}
		catch (pTenantError)
		{
			return [ UNKNOWN_TENANT ];
		}
	}

	/**
	 * A role-table write completed through a wrapped DAL method: drop the cached action sets of its
	 * tenants (every entry when they are not known) and revalidate the open change streams of those
	 * tenants.  Never throws.
	 *
	 * @param {string} pTable
	 * @param {Array<any>} [pTenants] - _roleWriteTenants(); default [ '*' ]
	 */
	_onRoleTableWrite(pTable, pTenants)
	{
		try
		{
			this.onEntitlementChange({ Entity: pTable, Tenants: (Array.isArray(pTenants) && (pTenants.length > 0)) ? pTenants : [ UNKNOWN_TENANT ] });
		}
		catch (pInvalidateError)
		{
			this.fable.log.error(`RetoldFaceting host (ApplicationServer): the entitlement invalidation after a ${logSafe(pTable)} write failed: ${logSafe(pInvalidateError.message)}`);
		}
	}

	/**
	 * Drop the entitlement-cache entries a role-table write may have changed (§77.3): the event's
	 * tenants ('*' → every entry), and ask the SSE service to revalidate every open stream (a revoked
	 * principal's stream closes, §76.5).  Events on other entities are ignored.
	 *
	 * @param {Record<string, any>} pEvent - a ChangeEvent
	 * @return {number} the entries dropped
	 */
	onEntitlementChange(pEvent)
	{
		let tmpConfig = this._EntitlementsConfig;
		if (!tmpConfig || !pEvent || (typeof(pEvent.Entity) !== 'string'))
		{
			return 0;
		}
		if (this._roleTables().indexOf(pEvent.Entity) < 0)
		{
			return 0;
		}
		this._EntitlementEpoch++;
		let tmpTenants = Array.isArray(pEvent.Tenants) ? pEvent.Tenants : [ UNKNOWN_TENANT ];
		this._revalidateStreams(tmpTenants);
		let tmpBefore = this._EntitlementCache.size;
		if ((tmpTenants.length < 1) || (tmpTenants.indexOf(UNKNOWN_TENANT) >= 0))
		{
			this._EntitlementCache.clear();
			return tmpBefore;
		}
		let tmpDrop = new Set(tmpTenants.map((pTenant) => { return JSON.stringify(normalizeScopeValue(pTenant)); }));
		Array.from(this._EntitlementCache.keys()).forEach(
			(pKey) =>
			{
				if (tmpDrop.has(JSON.stringify(this._EntitlementCache.get(pKey).Tenant)))
				{
					this._EntitlementCache.delete(pKey);
				}
			});
		return tmpBefore - this._EntitlementCache.size;
	}

	/**
	 * Ask the SSE service (when present) to revalidate the open streams of these tenants now (every
	 * stream when a tenant is unknown, or when the tenancy getValue is the app's own: a stream's tenant
	 * Part is the getValue result, the role rows' tenant is the entitlements tenant).  Never throws.
	 *
	 * @param {Array<any>} [pTenants]
	 */
	_revalidateStreams(pTenants)
	{
		let tmpSSE = this.fable.RetoldFacetingSSE;
		if (!tmpSSE || (typeof(tmpSSE.revalidateAll) !== 'function'))
		{
			return;
		}
		let tmpTenants = Array.isArray(pTenants) ? pTenants : [ UNKNOWN_TENANT ];
		if ((tmpTenants.length < 1) || (tmpTenants.indexOf(UNKNOWN_TENANT) >= 0) || !this._TenancySpecs || this._TenancySpecs.CustomGetValue)
		{
			tmpTenants = null;
		}
		try
		{
			tmpSSE.revalidateAll(tmpTenants);
		}
		catch (pSSEError)
		{
			this.fable.log.warn(`RetoldFaceting host (ApplicationServer): the change streams could not be revalidated: ${logSafe(pSSEError.message)}`);
		}
	}

	/**
	 * Drop every cached action set (tests, admin tooling).
	 */
	clearEntitlementCache()
	{
		this._EntitlementEpoch++;
		this._EntitlementCache.clear();
	}
}

module.exports = RetoldFacetingHostApplicationServer;
module.exports.serviceType = 'RetoldFacetingHostApplicationServer';
module.exports.NOT_IMPLEMENTED_MESSAGE = NOT_IMPLEMENTED_MESSAGE;
module.exports.TENANCY_LAYERS_MARKER = TENANCY_LAYERS_MARKER;
module.exports.DEFAULT_TENANCY_COLUMN = DEFAULT_TENANCY_COLUMN;
module.exports.DEFAULT_ROUTE_VERSION = DEFAULT_ROUTE_VERSION;
module.exports.DEFAULT_ROOT_TABLE = DEFAULT_ROOT_TABLE;
module.exports.DEFAULT_IDENTITY_TABLE = DEFAULT_IDENTITY_TABLE;
module.exports.DEFAULT_SYSTEM_ADMIN_FIELD = DEFAULT_SYSTEM_ADMIN_FIELD;
module.exports.DEFAULT_SYSTEM_ADMIN_VALUE = DEFAULT_SYSTEM_ADMIN_VALUE;
module.exports.ENTITLEMENT_CACHE_MAX_ENTRIES = ENTITLEMENT_CACHE_MAX_ENTRIES;
module.exports.ENTITLEMENT_SUBSCRIBER = ENTITLEMENT_SUBSCRIBER;
module.exports.ENTITLEMENT_WRAP_MARKER = ENTITLEMENT_WRAP_MARKER;
module.exports.REQUIRED_ENTITLEMENT_FIELDS = REQUIRED_ENTITLEMENT_FIELDS;
module.exports.TENANCY_GUARDED_READ_BEHAVIORS = TENANCY_GUARDED_READ_BEHAVIORS;
module.exports.COVERAGE = COVERAGE;
module.exports.FENCE_SWAP_OPERATORS = FENCE_SWAP_OPERATORS;
module.exports.roleSetHash = roleSetHash;
