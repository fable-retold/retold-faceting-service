/**
 * Facet-Test-Harness — boots a plain retold-data-service on a seeded fixture database, installs the
 * faceting service (Embedded), and gives tests the oracles (internal-contracts §14.1, §32):
 *
 *   let _Harness = libHarness.start({ Port: 19110, Fixture: 'Bookstore' }, fDone);
 *   let _Harness = libHarness.start({ Port: 19124, Fixture: 'ProjectTrack' }, fDone);   // M2 domains
 *
 * Fixtures (Domain: accepted as an alias of Fixture): 'Bookstore', 'Bookstore-Tenant' (M1),
 * 'ProjectTrack', 'LabTrack' (M2, two tenants on IDCustomer, definitions files loaded by default).
 * Providers come from the hook in test/support/Facet-Harness-Providers.js ('SQLite' in memory by
 * default; 'PostgreSQL' only when gated on — an unavailable provider calls fDone with an error whose
 * .Skip === true, which PG suites turn into a skipped suite).
 *
 * Ports: the server binds an EPHEMERAL port by default (the OS picks a free one; baseURL is read
 * back once it listens), so overlapping runs never collide.  Port (19100–19199, one per test file)
 * still names the run, and FixedPort: true binds exactly that port (debug scripts).  Host (optional)
 * binds that address only (e.g. '127.0.0.1'; default: every interface, as Orator does), and
 * BeforeListen(pHarness) (optional) runs after the test session shim is installed and before the
 * server listens, so a host can add its own restify pre() handlers with no window (the demo's
 * loopback guard).
 *   _Harness.facetQuery('Review', { Facets: [ … ] }, {}, (pError, pResponse) => …);   // Live over HTTP
 *   _Harness.query('Project', tmpBody, { Tenant: 1, User: 1, Now }, …);              // Live, in-process
 *   _Harness.reference('Review', { Facets: [ … ] }, {}, (pError, pEnvelope) => …);    // Reference, in-process
 *   _Harness.listCount('Review', 'FBV~Rating~GE~4', {}, (pError, pCount) => …);        // the real list
 *   _Harness.assertSelectionRoundTrip('Review', tmpBody, tmpEnvelope, {}, fDone);      // O2
 *   _Harness.assertTenantIsolation('Project', tmpBody, [ 'Lead', 'OtherLead' ], fDone);
 *   _Harness.stop(fDone);
 *
 * Principal (test-only "authentication", internal-contracts §14.1): every helper takes
 * pOptions.Tenant / pOptions.User (or _Harness.as('Lead') for a domain principal).  Over HTTP they
 * become the x-facet-test-tenant / x-facet-test-user headers, which a pre() shim turns into
 *   pRequest.UserSession = { LoggedIn: true, UserID, IDUser, IDTenant, CustomerID }
 * (MeadowEndpointsSessionDataSource stays 'Request', so the stock session marshaler hands it to
 * every list, count and facet route).  In-process calls build a synthetic request carrying the same
 * UserSession.  No Tenant and no User → the anonymous default session.  In-process calls also take
 * pOptions.Now (pin the request clock: $Now / $Today) and pOptions.PlanForm ({ Cube, Staged }).
 *
 * MeadowEndpoints: 'Installed' (default; the umbrella's meadow-endpoints, 4.0.21 today) or 'Monorepo'
 * (modules/meadow/meadow-endpoints, 4.1.x): the version the harness's endpoints are built with (an
 * unavailable checkout calls fDone with .Skip === true).  harness.meadowEndpointsVersion names it.
 *
 * Tenancy: Bookstore-Tenant installs the M1 IDTenant behavior; ProjectTrack / LabTrack install the
 * domain's policy as test behaviors (internal-contracts §31.2): IDCustomer = SessionData.CustomerID
 * on every entity that has the column, and each PersonalScopes column (LabForm.OwnerIDUser =
 * SessionData.UserID) — 401 when the session value is unset.  meadow-endpoints setBehavior is
 * single-slot, so installBehavior() CHAIN-WRAPS any behavior already there (the existing one runs
 * first, then the new one) — use _Harness.installBehavior(pEntity, pHash, fBehavior) to add more.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFable = require('fable');
const libFs = require('fs');
const libPath = require('path');
const libRetoldDataService = require('retold-data-service');
// The meadow-endpoints retold-data-service builds its endpoints with (the umbrella's installed copy).
const libInstalledMeadowEndpoints = require('meadow-endpoints');

const libRetoldFacetingService = require('../../source/Retold-Faceting-Service.js');
const libOptions = require('../../source/Retold-Faceting-Service-Options.js');
const libFacetEnvelope = require('../../source/contract/Facet-Contract-Envelope.js');
const libBookstoreSeed = require('../fixtures/Bookstore-Seed.js');
const libProjectTrackSeed = require('../fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('../fixtures/LabTrack-Seed.js');
const libProviders = require('./Facet-Harness-Providers.js');

const TENANT_HEADER = 'x-facet-test-tenant';
const USER_HEADER = 'x-facet-test-user';

// Behavior hashes the tenancy behavior is installed on (the list and its count).
const TENANCY_BEHAVIOR_HASHES = [ 'Reads-QueryConfiguration', 'Count-QueryConfiguration' ];

// Single-valued bucketed folds: SumOfCounts + MissingCount + OtherCount == Total (O2).
const BUCKETED_FOLDS = [ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ];

// M2 single-valued bucketed folds (zero-filled bands / two buckets) that obey the same sum rule.
const M2_BUCKETED_FOLDS = [ 'ChildRollup', 'ExistsSplit' ];

// Folds that exclude their own conjuncts by default (01 §8.3).
const SELF_EXCLUDING_FOLDS = [ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ];

// Clause types that compile to Path-shaped conjuncts (internal-contracts §23.4): a body holding one
// cannot be counted through the stock list.
const PATH_CLAUSE_PATTERN = /^(InternalJoin|ExternalJoin)/;

// Fixture → seed module (internal-contracts §32.1).
const DOMAINS = Object.freeze(
	{
		'Bookstore': libBookstoreSeed,
		'Bookstore-Tenant': libBookstoreSeed,
		'ProjectTrack': libProjectTrackSeed,
		'LabTrack': libLabTrackSeed
	});

// Fixtures whose tenancy behavior is installed by default (TenancyBehavior: 'Auto').
const TENANT_FIXTURES = [ 'Bookstore-Tenant', 'ProjectTrack', 'LabTrack' ];

/**
 * The seed module of a fixture.
 *
 * @param {string} pFixture
 * @return {Record<string, any>}
 */
const domainSeed = (pFixture) =>
{
	if (!Object.prototype.hasOwnProperty.call(DOMAINS, pFixture))
	{
		throw new Error(`Facet-Test-Harness: unknown fixture [${pFixture}] (${Object.keys(DOMAINS).join(' | ')}).`);
	}
	return DOMAINS[pFixture];
};

/**
 * The RetoldFaceting options a fixture runs with before a test's own Faceting is merged over them:
 * the M2 domain's FACETING_OPTIONS; the M1 IDTenant policy for Bookstore-Tenant; nothing for
 * Bookstore.
 *
 * @param {string} pFixture
 * @return {Record<string, any>}
 */
const domainOptions = (pFixture) =>
{
	let tmpSeed = domainSeed(pFixture);
	if (tmpSeed.FACETING_OPTIONS)
	{
		return libOptions.deepMerge(tmpSeed.FACETING_OPTIONS, {});
	}
	if (pFixture === 'Bookstore-Tenant')
	{
		return { Scope: { Policy: { Column: libBookstoreSeed.TENANT_COLUMN, SessionField: 'IDTenant' }, Guard: 'Strict' } };
	}
	return {};
};

/**
 * The UserSession the shim (and in-process calls) use for a tenant / user.
 *
 * @param {{ Tenant?: number, User?: number }} pOptions
 * @return {Record<string, any>|null} null = anonymous
 */
const sessionFor = (pOptions) =>
{
	let tmpOptions = pOptions || {};
	if ((typeof(tmpOptions.Tenant) !== 'number') && (typeof(tmpOptions.User) !== 'number'))
	{
		return null;
	}
	let tmpTenant = (typeof(tmpOptions.Tenant) === 'number') ? tmpOptions.Tenant : 0;
	let tmpUser = (typeof(tmpOptions.User) === 'number') ? tmpOptions.User : 1;
	return { LoggedIn: true, SessionID: `test-${tmpTenant}-${tmpUser}`, UserID: tmpUser, IDUser: tmpUser, IDTenant: tmpTenant, CustomerID: tmpTenant };
};

/**
 * A synthetic (in-process) request carrying the test session.
 *
 * @param {string} pEntity
 * @param {{ Tenant?: number, User?: number }} pOptions
 * @param {any} [pBody]
 * @return {Record<string, any>}
 */
const syntheticRequest = (pEntity, pOptions, pBody) =>
{
	let tmpSession = sessionFor(pOptions);
	let tmpRequest = { params: { Entity: pEntity }, headers: {}, query: {}, body: pBody };
	if (tmpSession)
	{
		tmpRequest.UserSession = tmpSession;
	}
	return tmpRequest;
};

/**
 * The in-process-only options of a helper call (internal-contracts §19.5): Now, PlanForm.
 *
 * @param {Record<string, any>} pOptions
 * @param {Record<string, any>} [pBase] - e.g. { ForceEngine: 'Reference' }
 * @return {Record<string, any>}
 */
const internalOptions = (pOptions, pBase) =>
{
	let tmpInternal = Object.assign({}, pBase || {});
	let tmpOptions = pOptions || {};
	if ((typeof(tmpOptions.Now) === 'string') || (typeof(tmpOptions.Now) === 'number'))
	{
		tmpInternal.Now = tmpOptions.Now;
	}
	if ((typeof(tmpOptions.PlanForm) === 'object') && (tmpOptions.PlanForm !== null))
	{
		tmpInternal.PlanForm = Object.assign({}, tmpOptions.PlanForm);
	}
	return tmpInternal;
};

/**
 * The default test tenancy behavior (Bookstore-Tenant): IDTenant = session tenant, 401 when unset.
 *
 * @this {any} the meadow-endpoints controller
 * @param {any} pRequest
 * @param {any} pRequestState
 * @param {Function} fCallback
 */
const testTenancyBehavior = function (pRequest, pRequestState, fCallback)
{
	let tmpTenant = (pRequestState.SessionData && pRequestState.SessionData.IDTenant) ? pRequestState.SessionData.IDTenant : 0;
	if (!tmpTenant)
	{
		return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
	}
	pRequestState.Query.addFilter('IDTenant', tmpTenant, '=', 'AND', 'TestTenancy');
	return fCallback();
};

/**
 * A policy behavior for an M2 domain (internal-contracts §31.2): `<Column> = SessionData[<SessionField>]`
 * at depth 0, 401 when the session value is unset.
 *
 * @param {string} pColumn - e.g. 'IDCustomer', 'OwnerIDUser'
 * @param {string} pSessionField - e.g. 'CustomerID', 'UserID'
 * @param {string} pParameter - the FoxHound parameter name ('TestTenancy', 'TestOwner')
 * @return {Function}
 */
const policyBehavior = (pColumn, pSessionField, pParameter) =>
{
	return function (pRequest, pRequestState, fCallback)
	{
		let tmpValue = (pRequestState.SessionData && pRequestState.SessionData[pSessionField]) ? pRequestState.SessionData[pSessionField] : 0;
		if (!tmpValue)
		{
			return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
		}
		pRequestState.Query.addFilter(pColumn, tmpValue, '=', 'AND', pParameter);
		return fCallback();
	};
};

// The monorepo checkout of meadow-endpoints (4.1.x), for the write-path suites that must also run
// against it (MeadowEndpoints: 'Monorepo'); absent on a box without the checkout (the suite skips).
const MONOREPO_MEADOW_ENDPOINTS = libPath.resolve(__dirname, '../../../meadow-endpoints/source/Meadow-Endpoints.js');

/**
 * The meadow-endpoints module a harness builds its endpoints with: 'Installed' (the umbrella's,
 * what retold-data-service requires) or 'Monorepo' (modules/meadow/meadow-endpoints, 4.1.x).
 *
 * @param {string} pWhich
 * @return {{ Available: boolean, Reason: string|null, Module: any, Version: string|null }}
 */
const meadowEndpointsModule = (pWhich) =>
{
	if (pWhich !== 'Monorepo')
	{
		return { Available: true, Reason: null, Module: libInstalledMeadowEndpoints, Version: null };
	}
	if (!libFs.existsSync(MONOREPO_MEADOW_ENDPOINTS))
	{
		return { Available: false, Reason: `no monorepo checkout at ${MONOREPO_MEADOW_ENDPOINTS}`, Module: null, Version: null };
	}
	try
	{
		let tmpPackage = JSON.parse(libFs.readFileSync(libPath.resolve(MONOREPO_MEADOW_ENDPOINTS, '../../package.json'), 'utf8'));
		return { Available: true, Reason: null, Module: require(MONOREPO_MEADOW_ENDPOINTS), Version: tmpPackage.version || null };
	}
	catch (pLoadError)
	{
		return { Available: false, Reason: `the monorepo meadow-endpoints does not load: ${pLoadError.message}`, Module: null, Version: null };
	}
};

/**
 * Install a behavior on a controller, chain-wrapping any behavior already at that hash
 * (setBehavior is single-slot until ME-1 adds addBehavior).  The existing behavior runs first;
 * an error from it short-circuits.  Both run with the controller as `this`.
 *
 * @param {any} pController - meadow-endpoints controller
 * @param {string} pBehaviorHash
 * @param {Function} fBehavior - function (pRequest, pRequestState, fCallback) (use `function`, not an arrow, to get the controller as this)
 */
const installBehavior = (pController, pBehaviorHash, fBehavior) =>
{
	let tmpInjection = pController.BehaviorInjection;
	if (typeof(tmpInjection.addBehavior) === 'function')
	{
		tmpInjection.addBehavior(pBehaviorHash, fBehavior);
		return;
	}
	let tmpExisting = (tmpInjection._BehaviorFunctions && tmpInjection._BehaviorFunctions.hasOwnProperty(pBehaviorHash))
		? tmpInjection._BehaviorFunctions[pBehaviorHash]
		: null;
	if (typeof(tmpExisting) !== 'function')
	{
		tmpInjection.setBehavior(pBehaviorHash, fBehavior);
		return;
	}
	tmpInjection.setBehavior(pBehaviorHash,
		function (pRequest, pRequestState, fCallback)
		{
			return tmpExisting.call(this, pRequest, pRequestState,
				(pError) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					return fBehavior.call(this, pRequest, pRequestState, fCallback);
				});
		});
};

/**
 * The remote fields and the default FilterKey of a join clause (internal-contracts §23.4 / §23.5),
 * as far as the request alone tells: an InternalJoin* clause looked up by the target key (L3) is
 * owned through its JoinInternalConnectionColumn; any other join clause owns a path signature that
 * no auto facet's FilterKey equals.
 *
 * @param {Record<string, any>} pClause
 * @return {string|null} the default FilterKey
 */
const joinClauseFilterKey = (pClause) =>
{
	if (!/^InternalJoin/.test(pClause.Type))
	{
		return null;
	}
	let tmpTargetKey = pClause.JoinExternalConnectionColumn || `ID${pClause.RemoteTable}`;
	let tmpRemote = /SelectedValue/.test(pClause.Type)
		? [ pClause.ExternalFilterTableLookupColumn || `ID${pClause.RemoteTable}` ]
		: (Array.isArray(pClause.ExternalFilterByColumns) ? pClause.ExternalFilterByColumns : [ pClause.ExternalFilterByColumn || 'Name' ]);
	let tmpL3 = (tmpRemote.length > 0) && tmpRemote.every((pField) => { return pField === tmpTargetKey; });
	return tmpL3 ? (pClause.JoinInternalConnectionColumn || null) : null;
};

/**
 * The exclusion a facet must report, derived from the REQUEST alone (internal-contracts §6.2), or
 * null when the body is outside the shapes this independent model covers (OR junctions, groups,
 * GUIDGroups, disabled or empty clauses, FilterString ORs / groups, Pivots, declared facets).
 *
 * Model: conjuncts are numbered c1… — one per Clause in array order (a NamedScope clause takes its
 * index but is never excluded), then one per FilterString stanza.  A facet (Exclude 'Self', the
 * default for Terms / DateHistogram / NumericHistogram / Ranges; 'None' for Stats / DistinctCount /
 * Missing / Pivot) owns a Clause whose FilterKey (else its single FilterByColumn; for an InternalJoin
 * clause looked up by the target key, its JoinInternalConnectionColumn) is the facet's column, and a
 * FilterString stanza on that column; a RawFilter, a NamedScope clause and the request Scopes are
 * never excluded.  An explicit Exclude array is returned as given.  Each excluded conjunct is
 * reported by its clause Hash, else its Id.
 *
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pSpec - the facet spec from the body
 * @return {Array<string>|null}
 */
const expectedExclusion = (pBody, pSpec) =>
{
	if (!pSpec || Array.isArray(pSpec.Facet) || (typeof(pSpec.Facet) !== 'string'))
	{
		return null;
	}
	if (Array.isArray(pSpec.Exclude))
	{
		return pSpec.Exclude.slice();
	}
	if ((pSpec.Facet.indexOf('/') >= 0) || (pSpec.Facet.indexOf('>') >= 0))
	{
		// Declared siblings and path facets: their ownership needs the registry (FilterKey = FacetID).
		return null;
	}
	let tmpFold = pSpec.Fold || null;
	let tmpPolicy = pSpec.Exclude || (((tmpFold === null) || (SELF_EXCLUDING_FOLDS.indexOf(tmpFold) >= 0)) ? 'Self' : 'None');
	if (tmpPolicy === 'None')
	{
		return [];
	}
	let tmpField = pSpec.Facet.substring(pSpec.Facet.indexOf('.') + 1);
	let tmpExcluded = [];
	let tmpClauses = Array.isArray(pBody.Clauses) ? pBody.Clauses : [];
	for (let i = 0; i < tmpClauses.length; i++)
	{
		let tmpClause = tmpClauses[i];
		if ((tmpClause.Enabled === false) || tmpClause.GUIDGroup || (tmpClause.Junction === 'OR'))
		{
			return null;
		}
		if (tmpClause.Type === 'RawFilter')
		{
			if (/(FBVOR|FBLOR|FOP)/.test(String(tmpClause.Value || tmpClause.Filter || '')))
			{
				return null;
			}
			continue;
		}
		if (tmpClause.Type === 'NamedScope')
		{
			continue;
		}
		let tmpFilterKey;
		if (PATH_CLAUSE_PATTERN.test(String(tmpClause.Type)))
		{
			tmpFilterKey = tmpClause.FilterKey || joinClauseFilterKey(tmpClause);
		}
		else
		{
			let tmpColumns = Array.isArray(tmpClause.FilterByColumns) ? tmpClause.FilterByColumns : [ tmpClause.FilterByColumn ];
			tmpFilterKey = tmpClause.FilterKey || ((tmpColumns.length === 1) ? tmpColumns[0] : null);
		}
		if (tmpFilterKey === tmpField)
		{
			tmpExcluded.push((typeof(tmpClause.Hash) === 'string') ? tmpClause.Hash : `c${i + 1}`);
		}
	}
	if (typeof(pBody.FilterString) === 'string')
	{
		let tmpTerms = pBody.FilterString.split('~');
		if (/(FBVOR|FBLOR|FOP|FCP)/.test(pBody.FilterString) || ((tmpTerms.length % 4) !== 0))
		{
			return null;
		}
		let tmpNumber = tmpClauses.length;
		for (let i = 0; i < tmpTerms.length; i += 4)
		{
			if (tmpTerms[i] === 'FSF')
			{
				continue;
			}
			tmpNumber++;
			if (tmpTerms[i + 1] === tmpField)
			{
				tmpExcluded.push(`c${tmpNumber}`);
			}
		}
	}
	return tmpExcluded;
};

/**
 * Does a body need the Reference to count it (internal-contracts §32.1 CountVia 'Auto'): request
 * Scopes, a NamedScope clause, or a join clause (Path-shaped conjuncts the stock list cannot carry)
 * — or, given the envelope, a DECLARED facet: its counts are under the definition's own Where
 * (W_def, never excluded, internal-contracts §24.6), which the stock list cannot carry either, so
 * the Reference counts a probe body that names the facet itself.
 *
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} [pEnvelope]
 * @return {boolean}
 */
const needsReferenceCount = (pBody, pEnvelope) =>
{
	let tmpBody = pBody || {};
	if (Array.isArray(tmpBody.Scopes) && (tmpBody.Scopes.length > 0))
	{
		return true;
	}
	let tmpClauses = Array.isArray(tmpBody.Clauses) ? tmpBody.Clauses : [];
	if (tmpClauses.some((pClause) => { return pClause && ((pClause.Type === 'NamedScope') || PATH_CLAUSE_PATTERN.test(String(pClause.Type))); }))
	{
		return true;
	}
	let tmpFacets = (pEnvelope && (typeof(pEnvelope.Facets) === 'object') && (pEnvelope.Facets !== null)) ? pEnvelope.Facets : {};
	return Object.keys(tmpFacets).some((pKey) => { return !!tmpFacets[pKey] && (tmpFacets[pKey].Declared === true); });
};

/**
 * Make a restify-backed Orator service server listen on one address only (Orator itself has no host
 * option and listens on every interface).  Replaces the instance's listen(); the rest of the lifecycle
 * (Active, Port, close) is unchanged.
 *
 * @param {Record<string, any>} pServiceServer - fable.OratorServiceServer
 * @param {string} pHost - e.g. '127.0.0.1'
 * @return {boolean} whether the server could be bound
 */
const bindHost = (pServiceServer, pHost) =>
{
	if (!pServiceServer || !pServiceServer.server || (typeof(pServiceServer.server.listen) !== 'function'))
	{
		return false;
	}
	pServiceServer.listen = function (pPort, fCallback)
	{
		this.server.listen(pPort, pHost,
			(pError) =>
			{
				this.Active = true;
				this.Port = pPort;
				return fCallback(pError);
			});
	};
	return true;
};

/**
 * Start a harness.  Returns the harness object synchronously; fDone(pError) when it is ready.
 *
 * @param {{ Port: number, Fixture?: string, Domain?: string, Provider?: string, Definitions?: any, Seed?: number, Scale?: string, Faceting?: Record<string, any>, TenancyBehavior?: any, TenancyEntities?: Array<string>, LogLevel?: string, FixedPort?: boolean, Host?: string, BeforeListen?: (pHarness: Record<string, any>) => void }} pOptions
 * @param {(pError?: Error) => void} fDone
 * @return {Record<string, any>}
 */
const start = (pOptions, fDone) =>
{
	let tmpInput = Object.assign({}, pOptions || {});
	if ((typeof(tmpInput.Fixture) !== 'string') && (typeof(tmpInput.Domain) === 'string'))
	{
		tmpInput.Fixture = tmpInput.Domain;
	}
	let tmpOptions = Object.assign({ Fixture: 'Bookstore', Provider: 'SQLite', Definitions: 'Auto', Seed: null, Scale: 'Small', Faceting: {}, TenancyBehavior: 'Auto', TenancyEntities: null, LogLevel: 'fatal', FixedPort: false, Host: null, BeforeListen: null, MeadowEndpoints: 'Installed' }, tmpInput);
	if ((typeof(tmpOptions.Port) !== 'number') || (tmpOptions.Port < 19100) || (tmpOptions.Port > 19199))
	{
		throw new Error('Facet-Test-Harness.start needs a unique Port in 19100-19199 (internal-contracts §14.4).');
	}
	let tmpSeedModule = domainSeed(tmpOptions.Fixture);
	if (typeof(tmpOptions.Seed) !== 'number')
	{
		tmpOptions.Seed = tmpSeedModule.DEFAULT_SEED;
	}
	// Ephemeral unless the caller pins it (a debug script): the OS picks a free port.
	let tmpListenPort = (tmpOptions.FixedPort === true) ? tmpOptions.Port : 0;

	let tmpHarness = (
		{
			fable: null,
			rds: null,
			faceting: null,
			db: null,
			model: null,
			seed: null,
			provider: tmpOptions.Provider,
			connection: null,
			principals: {},
			traps: {},
			port: tmpOptions.Port,
			baseURL: `http://127.0.0.1:${tmpOptions.Port}`,
			options: tmpOptions,
			facetingOptions: null,
			_Stopped: false
		});

	let tmpIsTenant = (TENANT_FIXTURES.indexOf(tmpOptions.Fixture) >= 0);
	let tmpIsDomain = !!tmpSeedModule.FACETING_OPTIONS;

	// Faceting options: the test's own deep-merged over the domain's; Definitions.Objects concatenated.
	let tmpDomainOptions = domainOptions(tmpOptions.Fixture);
	let tmpFacetingOptions = libOptions.deepMerge(tmpDomainOptions, tmpOptions.Faceting || {});
	let tmpDefinitions = { Path: false, Files: [], Objects: [] };
	if (tmpOptions.Definitions === 'Auto')
	{
		let tmpDomainDefinitions = tmpDomainOptions.Definitions || {};
		tmpDefinitions.Path = (typeof(tmpDomainDefinitions.Path) === 'string') ? tmpDomainDefinitions.Path : false;
		tmpDefinitions.Files = Array.isArray(tmpDomainDefinitions.Files) ? tmpDomainDefinitions.Files.slice() : [];
		tmpDefinitions.Objects = Array.isArray(tmpDomainDefinitions.Objects) ? tmpDomainDefinitions.Objects.slice() : [];
	}
	else if (Array.isArray(tmpOptions.Definitions))
	{
		tmpOptions.Definitions.forEach(
			(pEntry) =>
			{
				if (typeof(pEntry) === 'string')
				{
					tmpDefinitions.Files.push(pEntry);
				}
				else if ((typeof(pEntry) === 'object') && (pEntry !== null))
				{
					tmpDefinitions.Objects.push(pEntry);
				}
			});
	}
	else if (tmpOptions.Definitions !== false)
	{
		throw new Error('Facet-Test-Harness.start: Definitions must be \'Auto\', false or an array of paths / objects.');
	}
	let tmpTestDefinitions = (tmpOptions.Faceting && tmpOptions.Faceting.Definitions) ? tmpOptions.Faceting.Definitions : {};
	if (Array.isArray(tmpTestDefinitions.Files))
	{
		tmpDefinitions.Files = tmpDefinitions.Files.concat(tmpTestDefinitions.Files.filter((pFile) => { return tmpDefinitions.Files.indexOf(pFile) < 0; }));
	}
	if (Array.isArray(tmpTestDefinitions.Objects))
	{
		tmpDefinitions.Objects = tmpDefinitions.Objects.concat(tmpTestDefinitions.Objects);
	}
	if (typeof(tmpTestDefinitions.Path) !== 'undefined')
	{
		tmpDefinitions.Path = tmpTestDefinitions.Path;
	}
	let tmpHasDefinitions = (tmpDefinitions.Path !== false) || (tmpDefinitions.Files.length > 0) || (tmpDefinitions.Objects.length > 0);
	if (tmpHasDefinitions || tmpIsDomain)
	{
		tmpFacetingOptions.Definitions = Object.assign({}, tmpFacetingOptions.Definitions || {}, tmpDefinitions);
	}
	else
	{
		delete tmpFacetingOptions.Definitions;
	}
	tmpHarness.facetingOptions = tmpFacetingOptions;

	let tmpPolicy = (tmpFacetingOptions.Scope && tmpFacetingOptions.Scope.Policy) ? tmpFacetingOptions.Scope.Policy : null;
	let tmpPolicyColumn = (tmpPolicy && (typeof(tmpPolicy.Column) === 'string')) ? tmpPolicy.Column : libBookstoreSeed.TENANT_COLUMN;

	// The meadow-endpoints version the endpoints are built with (MeadowEndpoints 'Monorepo' = 4.1.x).
	let tmpEndpointsModule = meadowEndpointsModule(tmpOptions.MeadowEndpoints);
	tmpHarness.meadowEndpointsVersion = tmpEndpointsModule.Version;
	if (!tmpEndpointsModule.Available)
	{
		let tmpSkip = new Error(`Facet-Test-Harness: meadow-endpoints [${tmpOptions.MeadowEndpoints}] is unavailable: ${tmpEndpointsModule.Reason}`);
		tmpSkip.Skip = true;
		tmpHarness.stop = (fStopDone) => { tmpHarness._Stopped = true; return fStopDone(); };
		setImmediate(() => { fDone(tmpSkip); });
		return tmpHarness;
	}
	// retold-data-service builds every endpoint through libMeadowEndpoints.new(DAL) at loadModel; for
	// the duration of this harness's model load that factory builds the selected version's endpoints.
	let fRestoreEndpoints = () => {};
	let fSelectEndpoints = () =>
	{
		if (tmpEndpointsModule.Module === libInstalledMeadowEndpoints)
		{
			return;
		}
		let fInstalledNew = libInstalledMeadowEndpoints.new;
		libInstalledMeadowEndpoints.new = (pDAL, pControllerOptions) => { return tmpEndpointsModule.Module.new(pDAL, pControllerOptions); };
		fRestoreEndpoints = () => { libInstalledMeadowEndpoints.new = fInstalledNew; fRestoreEndpoints = () => {}; };
	};

	// The provider hook (internal-contracts §32.2).
	let tmpAvailability = libProviders.available(tmpOptions.Provider);
	if (!tmpAvailability.Available)
	{
		let tmpSkip = new Error(`Facet-Test-Harness: provider [${tmpOptions.Provider}] is unavailable: ${tmpAvailability.Reason}`);
		tmpSkip.Skip = true;
		tmpHarness.stop = (fStopDone) => { tmpHarness._Stopped = true; return fStopDone(); };
		setImmediate(() => { fDone(tmpSkip); });
		return tmpHarness;
	}

	let tmpFableSettings = Object.assign(
		{
			Product: 'RetoldFacetingTest',
			ProductVersion: '0.0.1',
			APIServerPort: tmpListenPort,
			LogStreams: [ { streamtype: 'console', level: tmpOptions.LogLevel } ]
		}, libProviders.fableSettings(tmpOptions.Provider, tmpOptions));
	let tmpFable = new libFable(tmpFableSettings);
	tmpHarness.fable = tmpFable;

	/**
	 * Install the test tenancy (or custom) behavior on the configured entities.
	 *
	 * @return {Error|null}
	 */
	let fInstallTenancy = () =>
	{
		let tmpCustom = (typeof(tmpOptions.TenancyBehavior) === 'function');
		let tmpWanted = tmpCustom || (tmpOptions.TenancyBehavior === true) || ((tmpOptions.TenancyBehavior === 'Auto') && tmpIsTenant);
		if (!tmpWanted)
		{
			return null;
		}
		let tmpBehavior;
		if (tmpCustom)
		{
			tmpBehavior = tmpOptions.TenancyBehavior;
		}
		else if (tmpIsDomain)
		{
			tmpBehavior = policyBehavior(tmpPolicyColumn, (tmpPolicy && tmpPolicy.SessionField) ? tmpPolicy.SessionField : 'CustomerID', 'TestTenancy');
		}
		else
		{
			tmpBehavior = testTenancyBehavior;
		}
		let tmpEntities = Object.keys(tmpFable.MeadowEndpoints);
		if (Array.isArray(tmpOptions.TenancyEntities))
		{
			tmpEntities = tmpEntities.filter((pEntity) => { return tmpOptions.TenancyEntities.indexOf(pEntity) >= 0; });
		}
		else if (!tmpCustom)
		{
			tmpEntities = tmpEntities.filter(
				(pEntity) =>
				{
					let tmpTable = tmpHarness.model.Tables[pEntity];
					return !!tmpTable && tmpTable.Columns.some((pColumn) => { return pColumn.Column === tmpPolicyColumn; });
				});
			if (tmpEntities.length < 1)
			{
				return new Error(`Facet-Test-Harness: TenancyBehavior needs a fixture with the [${tmpPolicyColumn}] column (use Fixture 'Bookstore-Tenant').`);
			}
		}
		for (let i = 0; i < tmpEntities.length; i++)
		{
			for (let j = 0; j < TENANCY_BEHAVIOR_HASHES.length; j++)
			{
				installBehavior(tmpFable.MeadowEndpoints[tmpEntities[i]].controller, TENANCY_BEHAVIOR_HASHES[j], tmpBehavior);
			}
		}
		// The domain's personal scopes (LabForm.OwnerIDUser = SessionData.UserID), after the tenancy.
		if (tmpIsDomain && !tmpCustom && tmpPolicy && (typeof(tmpPolicy.PersonalScopes) === 'object') && (tmpPolicy.PersonalScopes !== null))
		{
			let tmpPersonalEntities = Object.keys(tmpPolicy.PersonalScopes);
			for (let i = 0; i < tmpPersonalEntities.length; i++)
			{
				let tmpEntity = tmpPersonalEntities[i];
				let tmpPersonal = tmpPolicy.PersonalScopes[tmpEntity];
				if (!tmpFable.MeadowEndpoints[tmpEntity] || !tmpPersonal || (typeof(tmpPersonal.Column) !== 'string'))
				{
					continue;
				}
				let tmpOwnerBehavior = policyBehavior(tmpPersonal.Column, tmpPersonal.SessionField || 'UserID', 'TestOwner');
				for (let j = 0; j < TENANCY_BEHAVIOR_HASHES.length; j++)
				{
					installBehavior(tmpFable.MeadowEndpoints[tmpEntity].controller, TENANCY_BEHAVIOR_HASHES[j], tmpOwnerBehavior);
				}
			}
		}
		tmpHarness.tenancyEntities = tmpEntities;
		return null;
	};

	libProviders.connect(tmpOptions.Provider, tmpFable, tmpOptions,
		(pConnectError, pConnection) =>
		{
			if (pConnectError)
			{
				return fDone(pConnectError);
			}
			tmpHarness.connection = pConnection;
			tmpHarness.db = pConnection.db || null;
			libProviders.seed(pConnection, tmpSeedModule, { Fixture: tmpOptions.Fixture, Seed: tmpOptions.Seed, Scale: tmpOptions.Scale },
				(pSeedError, pSeedResult) =>
				{
					if (pSeedError)
					{
						return fDone(pSeedError);
					}
					tmpHarness.seed = pSeedResult;
					tmpHarness.model = tmpHarness.seed.Model;
					tmpHarness.principals = tmpHarness.seed.Principals || {};
					tmpHarness.traps = tmpHarness.seed.Traps || {};

					let tmpStorageProvider = pConnection.StorageProvider || tmpOptions.Provider;
					tmpFable.serviceManager.addServiceType('RetoldDataService', libRetoldDataService);
					tmpFable.serviceManager.instantiateServiceProvider('RetoldDataService', { StorageProvider: tmpStorageProvider, FullMeadowSchemaFilename: false });
					tmpHarness.rds = tmpFable.RetoldDataService;

					// Test-only session shim (runs before routing, for list AND facet routes).
					tmpFable.OratorServiceServer.pre(
						(pRequest, pResponse, fNext) =>
						{
							let tmpTenantHeader = pRequest.headers ? pRequest.headers[TENANT_HEADER] : null;
							let tmpUserHeader = pRequest.headers ? pRequest.headers[USER_HEADER] : null;
							if (tmpTenantHeader || tmpUserHeader)
							{
								pRequest.UserSession = sessionFor(
									{
										Tenant: tmpTenantHeader ? parseInt(tmpTenantHeader, 10) : undefined,
										User: tmpUserHeader ? parseInt(tmpUserHeader, 10) : undefined
									});
							}
							return fNext();
						});

					// Host hooks: a bind address, then the host's own pre() handlers, both before listen.
					if ((typeof(tmpOptions.Host) === 'string') && (tmpOptions.Host.length > 0))
					{
						bindHost(tmpFable.OratorServiceServer, tmpOptions.Host);
					}
					if (typeof(tmpOptions.BeforeListen) === 'function')
					{
						try
						{
							tmpOptions.BeforeListen(tmpHarness);
						}
						catch (pHookError)
						{
							return fDone(pHookError);
						}
					}

					fSelectEndpoints();
					tmpHarness.rds.initializeService(
						(pInitError) =>
						{
							if (pInitError)
							{
								fRestoreEndpoints();
								return fDone(pInitError);
							}
							// The port the server really listens on (ephemeral by default).
							let tmpRestify = tmpFable.OratorServiceServer ? tmpFable.OratorServiceServer.server : null;
							let tmpAddress = (tmpRestify && (typeof(tmpRestify.address) === 'function')) ? tmpRestify.address() : null;
							if (tmpAddress && (typeof(tmpAddress.port) === 'number'))
							{
								tmpHarness.port = tmpAddress.port;
								tmpHarness.baseURL = `http://127.0.0.1:${tmpAddress.port}`;
							}
							let tmpModelName = tmpIsDomain ? tmpOptions.Fixture : 'Bookstore';
							tmpHarness.rds.loadModel(tmpModelName, tmpHarness.model, tmpStorageProvider,
								(pLoadError) =>
								{
									fRestoreEndpoints();
									if (pLoadError)
									{
										return fDone(pLoadError);
									}
									let tmpTenancyError = fInstallTenancy();
									if (tmpTenancyError)
									{
										return fDone(tmpTenancyError);
									}
									libRetoldFacetingService.installOnRetoldDataService(tmpHarness.rds, tmpFacetingOptions,
										(pInstallError, pService) =>
										{
											if (pInstallError)
											{
												return fDone(pInstallError);
											}
											tmpHarness.faceting = pService || tmpFable.RetoldFacetingService;
											return fDone();
										});
								});
						});
				});
		});

	/**
	 * Close the server and release the database.  Idempotent.
	 *
	 * @param {(pError?: Error) => void} fStopDone
	 */
	tmpHarness.stop = (fStopDone) =>
	{
		let fRelease = () =>
		{
			if (!tmpHarness.connection)
			{
				return fStopDone();
			}
			return libProviders.release(tmpHarness.connection, () => { return fStopDone(); });
		};
		if (tmpHarness._Stopped)
		{
			return fStopDone();
		}
		tmpHarness._Stopped = true;
		if (!tmpHarness.fable || !tmpHarness.fable.Orator)
		{
			// Start failed before the server existed
			return fRelease();
		}
		// Orator calls back at once (with a message, not an error) when the server never started.
		tmpHarness.fable.Orator.stopWebServer(() => { return fRelease(); });
	};

	/**
	 * Add a behavior to one entity's route-bound controller (chain-wrapped; see installBehavior).
	 *
	 * @param {string} pEntity
	 * @param {string} pBehaviorHash - e.g. 'Reads-QueryConfiguration'
	 * @param {Function} fBehavior
	 */
	tmpHarness.installBehavior = (pEntity, pBehaviorHash, fBehavior) =>
	{
		return installBehavior(tmpHarness.fable.MeadowEndpoints[pEntity].controller, pBehaviorHash, fBehavior);
	};

	/**
	 * The { Tenant, User } of a named domain principal (internal-contracts §31.4).
	 *
	 * @param {string} pName - e.g. 'Lead', 'Tech'
	 * @return {{ Tenant: number, User: number }}
	 */
	tmpHarness.as = (pName) =>
	{
		if (!Object.prototype.hasOwnProperty.call(tmpHarness.principals || {}, pName))
		{
			throw new Error(`Facet-Test-Harness: unknown principal [${pName}] for fixture [${tmpOptions.Fixture}].`);
		}
		let tmpPrincipal = tmpHarness.principals[pName];
		return { Tenant: tmpPrincipal.Tenant, User: tmpPrincipal.User };
	};

	/**
	 * HTTP request through fetch.
	 *
	 * @param {string} pMethod
	 * @param {string} pPath - starts with '/'
	 * @param {any} pBody - JSON body or null
	 * @param {{ Tenant?: number, User?: number, Headers?: Record<string, string> }} pRequestOptions
	 * @param {(pError?: Error, pResponse?: { Status: number, Headers: Record<string, string>, Body: any }) => void} fCallback
	 */
	tmpHarness.request = (pMethod, pPath, pBody, pRequestOptions, fCallback) =>
	{
		let tmpRequestOptions = pRequestOptions || {};
		let tmpHeaders = Object.assign({}, tmpRequestOptions.Headers || {});
		if (typeof(tmpRequestOptions.Tenant) === 'number')
		{
			tmpHeaders[TENANT_HEADER] = String(tmpRequestOptions.Tenant);
		}
		if (typeof(tmpRequestOptions.User) === 'number')
		{
			tmpHeaders[USER_HEADER] = String(tmpRequestOptions.User);
		}
		let tmpFetchOptions = { method: pMethod, headers: tmpHeaders };
		if ((pBody !== null) && (typeof(pBody) !== 'undefined'))
		{
			tmpHeaders['content-type'] = 'application/json';
			tmpFetchOptions.body = (typeof(pBody) === 'string') ? pBody : JSON.stringify(pBody);
		}
		fetch(`${tmpHarness.baseURL}${pPath}`, tmpFetchOptions)
			.then(
				(pResponse) =>
				{
					return pResponse.text().then(
						(pText) =>
						{
							let tmpBody = pText;
							try
							{
								tmpBody = (pText.length > 0) ? JSON.parse(pText) : null;
							}
							catch (pParseError)
							{
								// Not JSON; keep the text
							}
							let tmpResponseHeaders = {};
							pResponse.headers.forEach((pValue, pKey) => { tmpResponseHeaders[pKey] = pValue; });
							return { Status: pResponse.status, Headers: tmpResponseHeaders, Body: tmpBody };
						});
				})
			.then(
				(pResult) =>
				{
					// Leave the promise chain before calling back (assertion errors must not become rejections).
					setImmediate(() => { fCallback(null, pResult); });
				},
				(pError) =>
				{
					setImmediate(() => { fCallback(pError); });
				});
	};

	/**
	 * POST /1.0/Facet/:Entity/Query
	 */
	tmpHarness.facetQuery = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Query`, pBody, pRequestOptions, fCallback);
	};

	/**
	 * Call the service in-process and leave its stack before calling back.
	 *
	 * @param {string} pEntity
	 * @param {any} pBody
	 * @param {Record<string, any>} pRequestOptions
	 * @param {Record<string, any>} pInternal
	 * @param {Function} fCallback - (pError, pEnvelope, pMeta)
	 */
	let fInProcess = (pEntity, pBody, pRequestOptions, pInternal, fCallback) =>
	{
		let tmpRequest = syntheticRequest(pEntity, pRequestOptions, pBody);
		return tmpHarness.faceting.queryInternal(pEntity, pBody, tmpRequest, pInternal,
			(pError, pEnvelope, pMeta) =>
			{
				setImmediate(() => { fCallback(pError, pEnvelope, pMeta); });
			});
	};

	/**
	 * The request through the Live engine, in-process (no HTTP), honoring pOptions.Now / PlanForm.
	 */
	tmpHarness.query = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		return fInProcess(pEntity, pBody, pRequestOptions, internalOptions(pRequestOptions), fCallback);
	};

	/**
	 * The same request through the Reference engine, in-process, with the same session (and
	 * pOptions.Now / PlanForm as internal options).
	 */
	tmpHarness.reference = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		let tmpRequest = syntheticRequest(pEntity, pRequestOptions, pBody);
		return tmpHarness.faceting.queryInternal(pEntity, pBody, tmpRequest, internalOptions(pRequestOptions, { ForceEngine: 'Reference' }), fCallback);
	};

	/**
	 * Live (HTTP) and Reference for the same body and session, normalized for deep-equal (O1).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {{ Tenant?: number, User?: number, Now?: string, PlanForm?: Record<string, any> }} pRequestOptions
	 * @param {(pError?: Error, pResult?: { Live: any, Reference: any, LiveNormalized: any, ReferenceNormalized: any }) => void} fCallback
	 */
	tmpHarness.compare = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		tmpHarness.facetQuery(pEntity, pBody, pRequestOptions,
			(pLiveError, pLiveResponse) =>
			{
				if (pLiveError)
				{
					return fCallback(pLiveError);
				}
				tmpHarness.reference(pEntity, pBody, pRequestOptions,
					(pReferenceError, pReferenceEnvelope) =>
					{
						// Callbacks from the service may be synchronous; leave its stack first.
						setImmediate(
							() =>
							{
								if (pReferenceError)
								{
									return fCallback(pReferenceError);
								}
								return fCallback(null,
									{
										Live: pLiveResponse,
										Reference: pReferenceEnvelope,
										LiveNormalized: libFacetEnvelope.normalizeForComparison(pLiveResponse.Body),
										ReferenceNormalized: libFacetEnvelope.normalizeForComparison(pReferenceEnvelope)
									});
							});
					});
			});
	};

	/**
	 * Live (in-process) and Reference with the SAME pinned clock (pOptions.Now, default the domain's
	 * TestNow) and plan form: O1 for requests that bind $Now.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {{ Tenant?: number, User?: number, Now?: string, PlanForm?: Record<string, any> }} pRequestOptions
	 * @param {(pError?: Error, pResult?: { Live: any, Reference: any, LiveNormalized: any, ReferenceNormalized: any, LiveMeta: any, ReferenceMeta: any }) => void} fCallback
	 */
	tmpHarness.compareInProcess = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		let tmpRequestOptions = Object.assign({}, pRequestOptions || {});
		if ((typeof(tmpRequestOptions.Now) !== 'string') && (typeof(tmpRequestOptions.Now) !== 'number'))
		{
			tmpRequestOptions.Now = tmpHarness.traps.TestNow || new Date().toISOString();
		}
		tmpHarness.query(pEntity, pBody, tmpRequestOptions,
			(pLiveError, pLiveEnvelope, pLiveMeta) =>
			{
				if (pLiveError)
				{
					return fCallback(pLiveError);
				}
				fInProcess(pEntity, pBody, tmpRequestOptions, internalOptions(tmpRequestOptions, { ForceEngine: 'Reference' }),
					(pReferenceError, pReferenceEnvelope, pReferenceMeta) =>
					{
						if (pReferenceError)
						{
							return fCallback(pReferenceError);
						}
						return fCallback(null,
							{
								Live: pLiveEnvelope,
								Reference: pReferenceEnvelope,
								LiveNormalized: libFacetEnvelope.normalizeForComparison(pLiveEnvelope),
								ReferenceNormalized: libFacetEnvelope.normalizeForComparison(pReferenceEnvelope),
								LiveMeta: pLiveMeta,
								ReferenceMeta: pReferenceMeta
							});
					});
			});
	};

	/**
	 * POST /1.0/Facet/:Entity/Records (internal-contracts §28.1) → { Status, Headers, Body }.
	 */
	tmpHarness.records = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Records`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * POST /1.0/Facet/:Entity/Records/:Begin/:Cap (the pict FilterEndpointOverride page shape).
	 */
	tmpHarness.recordsPage = (pEntity, pBegin, pCap, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Records/${pBegin}/${pCap}`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * POST /1.0/Facet/:Entity/Records/Count → { Status, Headers, Body: { Count } }.
	 */
	tmpHarness.recordsCount = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Records/Count`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * POST /1.0/Facet/:Entity/Keys → { Status, Headers, Body: { Entity, Keys, Count, Truncated, Version } }.
	 */
	tmpHarness.keys = (pEntity, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Keys`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * POST /1.0/Facet/:Entity/Scope/:Scope/Records[/:Begin/:Cap] (pBegin / pCap null → no page segment).
	 */
	tmpHarness.scopeRecords = (pEntity, pScope, pBegin, pCap, pBody, pRequestOptions, fCallback) =>
	{
		let tmpPage = ((pBegin === null) || (typeof(pBegin) === 'undefined')) ? '' : `/${pBegin}/${pCap}`;
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Scope/${encodeURIComponent(pScope)}/Records${tmpPage}`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * POST /1.0/Facet/:Entity/Scope/:Scope/Records/Count.
	 */
	tmpHarness.scopeRecordsCount = (pEntity, pScope, pBody, pRequestOptions, fCallback) =>
	{
		return tmpHarness.request('POST', `/1.0/Facet/${pEntity}/Scope/${encodeURIComponent(pScope)}/Records/Count`, pBody || {}, pRequestOptions, fCallback);
	};

	/**
	 * GET /1.0/<E>s/Count[/FilteredTo/<filter>] — pFilterString is RAW (decoded); encoded once here.
	 */
	tmpHarness.listCount = (pEntity, pFilterString, pRequestOptions, fCallback) =>
	{
		let tmpPath = ((typeof(pFilterString) === 'string') && (pFilterString.length > 0))
			? `/1.0/${pEntity}s/Count/FilteredTo/${encodeURIComponent(pFilterString)}`
			: `/1.0/${pEntity}s/Count`;
		tmpHarness.request('GET', tmpPath, null, pRequestOptions,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if ((pResponse.Status !== 200) || !pResponse.Body || (typeof(pResponse.Body.Count) !== 'number'))
				{
					return fCallback(new Error(`List count failed: ${pResponse.Status} ${JSON.stringify(pResponse.Body)}`));
				}
				return fCallback(null, pResponse.Body.Count);
			});
	};

	/**
	 * GET /1.0/<E>s[/FilteredTo/<filter>]/0/0 — every row (Cap 0 = no LIMIT).
	 */
	tmpHarness.listRows = (pEntity, pFilterString, pRequestOptions, fCallback) =>
	{
		let tmpPath = ((typeof(pFilterString) === 'string') && (pFilterString.length > 0))
			? `/1.0/${pEntity}s/FilteredTo/${encodeURIComponent(pFilterString)}/0/0`
			: `/1.0/${pEntity}s/0/0`;
		tmpHarness.request('GET', tmpPath, null, pRequestOptions,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if ((pResponse.Status !== 200) || !Array.isArray(pResponse.Body))
				{
					return fCallback(new Error(`List read failed: ${pResponse.Status} ${JSON.stringify(pResponse.Body)}`));
				}
				return fCallback(null, pResponse.Body);
			});
	};

	/**
	 * The fenced, RAW meadow-filter string for a body's Clauses + FilterString (list oracle input).
	 */
	tmpHarness.toFilterString = (pEntity, pBody) =>
	{
		let tmpBody = pBody || {};
		// FilterAST.build reads only Clauses and FilterString from its second argument (internal-contracts §4.3).
		let tmpFilterAST = tmpHarness.fable.RetoldFacetingFilterAST.build(pEntity, { Clauses: tmpBody.Clauses || [], FilterString: tmpBody.FilterString || null });
		return tmpHarness.fable.RetoldFacetingFilterAST.toFilterString(tmpFilterAST.Conjuncts);
	};

	/**
	 * Strip volatile fields for deep-equal (O1).
	 */
	tmpHarness.normalize = (pEnvelope) =>
	{
		return libFacetEnvelope.normalizeForComparison(pEnvelope);
	};

	/**
	 * The rows of a table a principal can see through its list (tenant, soft delete, personal scope),
	 * from the seed's generated rows.
	 *
	 * @param {string} pTable
	 * @param {{ Tenant?: number, User?: number }} pPrincipal
	 * @return {Array<Record<string, any>>}
	 */
	tmpHarness.visibleRows = (pTable, pPrincipal) =>
	{
		if (tmpHarness.seed && !tmpHarness.seed.Rows && (typeof(tmpSeedModule.generate) === 'function'))
		{
			// Seeds that keep no rows on their build() result (the bookstore): generation is
			// deterministic, so regenerate them once, lazily.
			tmpHarness.seed.Rows = tmpSeedModule.generate({ Fixture: tmpOptions.Fixture, Seed: tmpOptions.Seed, Scale: tmpOptions.Scale }).Rows;
		}
		let tmpRows = (tmpHarness.seed && tmpHarness.seed.Rows && Array.isArray(tmpHarness.seed.Rows[pTable])) ? tmpHarness.seed.Rows[pTable] : [];
		let tmpTable = tmpHarness.model.Tables[pTable];
		let fHas = (pColumn) => { return !!tmpTable && tmpTable.Columns.some((pEntry) => { return pEntry.Column === pColumn; }); };
		let tmpTenantColumn = tmpHarness.seed.TenantColumn || tmpPolicyColumn;
		let tmpPersonal = (tmpPolicy && tmpPolicy.PersonalScopes && tmpPolicy.PersonalScopes[pTable]) ? tmpPolicy.PersonalScopes[pTable] : null;
		return tmpRows.filter(
			(pRow) =>
			{
				if (fHas('Deleted') && (pRow.Deleted !== 0))
				{
					return false;
				}
				if (tmpTenantColumn && fHas(tmpTenantColumn) && (pRow[tmpTenantColumn] !== pPrincipal.Tenant))
				{
					return false;
				}
				if (tmpPersonal && fHas(tmpPersonal.Column) && (pRow[tmpPersonal.Column] !== pPrincipal.User))
				{
					return false;
				}
				return true;
			});
	};

	/**
	 * O2 (internal-contracts §10.7, §32.1), checked against the REQUEST, not the service's own claims:
	 *   - Excluded: the exclusion the harness derives on its own from the facet spec (clauses and
	 *     FilterString terms on the facet's own field, internal-contracts §6.2) must equal
	 *     FacetResult.Excluded (for bodies simple enough to derive it: no OR junctions / groups);
	 *   - EnvelopeTotal: for bodies without Clauses, the RAW body.FilterString goes to the list as is;
	 *   - a Terms bucket whose key holds '~' must carry Clause null (UnsafeKey); every other bucket
	 *     Clause must compile (a Clause the service itself refuses is a mismatch, never skipped);
	 * and then: for every selectable bucket with Count > 0 (and a sample of Count 0 buckets),
	 * replacing the conjuncts the facet EXCLUDED (FacetResult.Excluded: clause Hashes, else conjunct
	 * Ids) with the Bucket.Clause and counting equals Bucket.Count.  Also, per facet: the count of the
	 * facet's own filter (the excluded conjuncts removed) equals FacetResult.Total, and for single-
	 * valued folds SumOfCounts + MissingCount + OtherCount == Total; and envelope Total == the count
	 * of the full filter.
	 *
	 * Counting (pOptions.CountVia): 'List' — the real list Count route (the M1 oracle); 'Reference' —
	 * the Reference envelope Total of the modified BODY (clauses removed / appended, Scopes kept) as
	 * the same principal with the same pinned Now; 'Auto' (default) — the list unless the body has
	 * Scopes, a NamedScope clause or a join clause (Path-shaped conjuncts the list cannot carry), or
	 * the envelope has a declared facet (its definition Where).
	 *
	 * Calls back fCallback(Error, Report) when anything mismatches (so it can be handed fDone),
	 * else fCallback(null, Report).  Report = { Checked, Skipped, CountVia, Mismatches: [ { Facet, Check, Key?, Expected, Actual } ] }.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody - the original request body
	 * @param {Record<string, any>} pEnvelope - the response envelope (Live or Reference)
	 * @param {{ Tenant?: number, User?: number, Now?: string, MaxBuckets?: number, ZeroSample?: number, CountVia?: string }} pRequestOptions
	 * @param {(pError?: Error, pReport?: { Checked: number, Skipped: number, Mismatches: Array<any> }) => void} fCallback
	 */
	tmpHarness.assertSelectionRoundTrip = (pEntity, pBody, pEnvelope, pRequestOptions, fCallback) =>
	{
		let tmpRequestOptions = pRequestOptions || {};
		let tmpCountVia = tmpRequestOptions.CountVia || 'Auto';
		if (tmpCountVia === 'Auto')
		{
			tmpCountVia = needsReferenceCount(pBody, pEnvelope) ? 'Reference' : 'List';
		}
		if (tmpCountVia === 'Reference')
		{
			return fRoundTripViaReference(pEntity, pBody, pEnvelope, tmpRequestOptions, fCallback);
		}
		if (tmpCountVia !== 'List')
		{
			return fCallback(new Error(`assertSelectionRoundTrip: unknown CountVia [${tmpCountVia}].`), { Checked: 0, Skipped: 0, Mismatches: [] });
		}
		let tmpMaxBuckets = (typeof(tmpRequestOptions.MaxBuckets) === 'number') ? tmpRequestOptions.MaxBuckets : Infinity;
		let tmpZeroSample = (typeof(tmpRequestOptions.ZeroSample) === 'number') ? tmpRequestOptions.ZeroSample : 2;
		let tmpReport = { Checked: 0, Skipped: 0, CountVia: 'List', Mismatches: [] };
		let tmpFilterASTService = tmpHarness.fable.RetoldFacetingFilterAST;
		let tmpClauseCompiler = tmpHarness.fable.RetoldFacetingClauseCompiler;
		let tmpBody = pBody || {};

		if (!pEnvelope || (typeof(pEnvelope) !== 'object') || (typeof(pEnvelope.Facets) !== 'object'))
		{
			return fCallback(new Error('assertSelectionRoundTrip needs a facet envelope.'), tmpReport);
		}

		let tmpConjuncts;
		try
		{
			tmpConjuncts = tmpFilterASTService.build(pEntity, { Clauses: tmpBody.Clauses || [], FilterString: tmpBody.FilterString || null }).Conjuncts;
		}
		catch (pBuildError)
		{
			return fCallback(pBuildError, tmpReport);
		}

		// The work list: [ { Facet, Check, Key?, Expected, Filter } ]
		let tmpChecks = [];
		let fFilter = (pList) =>
		{
			return tmpFilterASTService.toFilterString(pList);
		};
		let fMismatch = (pMismatch) =>
		{
			tmpReport.Checked++;
			tmpReport.Mismatches.push(pMismatch);
		};

		try
		{
			if (typeof(pEnvelope.Total) === 'number')
			{
				// Without Clauses the request's own FilterString goes to the list untouched — unless it
				// has a top-level OR: the stock list appends its soft-delete (and tenancy) terms without
				// parentheses, so 'A~FBVOR~B' leaks deleted rows there (upstream; the facet fences it).
				// A body FilterString is percent-encoded (02 §3.1, decoded once by the service); the
				// list helpers take the RAW string and encode it once, so decode it once here.
				let tmpRawFilter = null;
				if ((!Array.isArray(tmpBody.Clauses) || (tmpBody.Clauses.length < 1)) && (typeof(tmpBody.FilterString) === 'string'))
				{
					try
					{
						tmpRawFilter = decodeURIComponent(tmpBody.FilterString);
					}
					catch (pDecodeError)
					{
						tmpRawFilter = null;
					}
					if ((tmpRawFilter !== null) && /(^|~)(FBVOR|FBLOR|FOPOR)~/.test(tmpRawFilter))
					{
						tmpRawFilter = null;
					}
				}
				tmpChecks.push({ Facet: '#Envelope', Check: 'EnvelopeTotal', Expected: pEnvelope.Total, Filter: (tmpRawFilter !== null) ? tmpRawFilter : fFilter(tmpConjuncts) });
			}

			let tmpSpecs = {};
			(Array.isArray(tmpBody.Facets) ? tmpBody.Facets : []).forEach(
				(pSpec) =>
				{
					let tmpKey = (typeof(pSpec.Key) === 'string') ? pSpec.Key : (Array.isArray(pSpec.Facet) ? pSpec.Facet.join('|') : pSpec.Facet);
					tmpSpecs[tmpKey] = pSpec;
				});

			let tmpFacetKeys = Object.keys(pEnvelope.Facets);
			for (let i = 0; i < tmpFacetKeys.length; i++)
			{
				let tmpFacetKey = tmpFacetKeys[i];
				let tmpFacet = pEnvelope.Facets[tmpFacetKey];
				if (!tmpFacet || (typeof(tmpFacet) !== 'object'))
				{
					continue;
				}
				let tmpExcluded = Array.isArray(tmpFacet.Excluded) ? tmpFacet.Excluded : [];

				// The exclusion derived from the REQUEST, independent of FacetResult.Excluded.
				let tmpExpectedExcluded = expectedExclusion(tmpBody, tmpSpecs[tmpFacetKey]);
				if (tmpExpectedExcluded === null)
				{
					tmpReport.Skipped++;
				}
				else
				{
					tmpReport.Checked++;
					if (JSON.stringify(tmpExpectedExcluded) !== JSON.stringify(tmpExcluded))
					{
						tmpReport.Mismatches.push({ Facet: tmpFacetKey, Check: 'Excluded', Expected: tmpExpectedExcluded, Actual: tmpExcluded });
					}
				}

				let tmpKept = tmpConjuncts.filter(
					(pConjunct) =>
					{
						let tmpHash = (pConjunct.Origin && pConjunct.Origin.Hash) ? pConjunct.Origin.Hash : null;
						return !((tmpHash && (tmpExcluded.indexOf(tmpHash) >= 0)) || (tmpExcluded.indexOf(pConjunct.Id) >= 0));
					});

				if (typeof(tmpFacet.Total) === 'number')
				{
					tmpChecks.push({ Facet: tmpFacetKey, Check: 'FacetTotal', Expected: tmpFacet.Total, Filter: fFilter(tmpKept) });
					if ((tmpFacet.MultiValued !== true) && ((BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0) || (M2_BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0)) && (typeof(tmpFacet.SumOfCounts) === 'number'))
					{
						let tmpSum = tmpFacet.SumOfCounts + (tmpFacet.MissingCount || 0) + (tmpFacet.OtherCount || 0);
						tmpReport.Checked++;
						if (tmpSum !== tmpFacet.Total)
						{
							tmpReport.Mismatches.push({ Facet: tmpFacetKey, Check: 'SumOfCounts+MissingCount+OtherCount', Expected: tmpFacet.Total, Actual: tmpSum });
						}
					}
				}

				if (!tmpFacet.Selectable || !Array.isArray(tmpFacet.Buckets))
				{
					continue;
				}
				let tmpPositive = 0;
				let tmpZero = 0;
				for (let j = 0; j < tmpFacet.Buckets.length; j++)
				{
					let tmpBucket = tmpFacet.Buckets[j];
					if (!tmpBucket)
					{
						continue;
					}
					if ((tmpFacet.Fold === 'Terms') && !tmpFacet.Path && (tmpFacet.MultiValued !== true))
					{
						// UnsafeKey (03 §6.1): a key holding '~' has no Clause; every other Terms key has one.
						let tmpUnsafe = (typeof(tmpBucket.Key) === 'string') && /~|%7e/i.test(tmpBucket.Key);
						if (tmpUnsafe !== (tmpBucket.Clause === null))
						{
							fMismatch({ Facet: tmpFacetKey, Check: 'UnsafeKeyClause', Key: tmpBucket.Key, Expected: tmpUnsafe ? null : 'a Clause', Actual: tmpBucket.Clause });
							continue;
						}
						if (tmpUnsafe)
						{
							tmpReport.Checked++;
							continue;
						}
					}
					if (!tmpBucket.Clause)
					{
						continue;
					}
					if (tmpBucket.Count > 0)
					{
						if (tmpPositive >= tmpMaxBuckets)
						{
							tmpReport.Skipped++;
							continue;
						}
						tmpPositive++;
					}
					else
					{
						if (tmpZero >= tmpZeroSample)
						{
							continue;
						}
						tmpZero++;
					}
					if (PATH_CLAUSE_PATTERN.test(String(tmpBucket.Clause.Type)))
					{
						// A join Clause compiles to a Path-shaped conjunct the list syntax cannot carry: count
						// it with CountVia 'Reference'.
						tmpReport.Skipped++;
						continue;
					}
					let tmpBucketConjuncts;
					try
					{
						tmpBucketConjuncts = tmpClauseCompiler.compile(pEntity, [ tmpBucket.Clause ]).Conjuncts;
					}
					catch (pCompileError)
					{
						// The service offered a Clause it refuses itself: a real mismatch, never skipped.
						fMismatch({ Facet: tmpFacetKey, Check: 'ClauseCompiles', Key: tmpBucket.Key, Expected: 'compiles', Actual: (pCompileError && pCompileError.Code) ? pCompileError.Code : String(pCompileError) });
						continue;
					}
					let tmpFilter;
					try
					{
						tmpFilter = fFilter(tmpKept.concat(tmpBucketConjuncts));
					}
					catch (pRenderError)
					{
						if (!pRenderError || (pRenderError.Code !== 'FACET_FILTER_INVALID'))
						{
							throw pRenderError;
						}
						// A value the meadow-filter list syntax cannot carry: not checkable through the list.
						tmpReport.Skipped++;
						continue;
					}
					tmpChecks.push({ Facet: tmpFacetKey, Check: 'BucketCount', Key: tmpBucket.Key, Expected: tmpBucket.Count, Filter: tmpFilter });
				}
			}
		}
		catch (pPlanError)
		{
			return fCallback(pPlanError, tmpReport);
		}

		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpChecks.length)
			{
				if (tmpReport.Mismatches.length > 0)
				{
					let tmpError = new Error(`Selection round trip: ${tmpReport.Mismatches.length} mismatch(es) of ${tmpReport.Checked}: ${JSON.stringify(tmpReport.Mismatches.slice(0, 5))}`);
					tmpError.Report = tmpReport;
					return fCallback(tmpError, tmpReport);
				}
				return fCallback(null, tmpReport);
			}
			let tmpCheck = tmpChecks[pIndex];
			tmpHarness.listCount(pEntity, tmpCheck.Filter, tmpRequestOptions,
				(pCountError, pCount) =>
				{
					if (pCountError)
					{
						return fCallback(pCountError, tmpReport);
					}
					tmpReport.Checked++;
					if (pCount !== tmpCheck.Expected)
					{
						let tmpMismatch = { Facet: tmpCheck.Facet, Check: tmpCheck.Check, Expected: tmpCheck.Expected, Actual: pCount, Filter: tmpCheck.Filter };
						if (tmpCheck.hasOwnProperty('Key'))
						{
							tmpMismatch.Key = tmpCheck.Key;
						}
						tmpReport.Mismatches.push(tmpMismatch);
					}
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	};

	/**
	 * O2 counted through the Reference (internal-contracts §32.3): every count is the Reference
	 * envelope Total of a modified BODY (the facet's excluded clauses removed by Hash / Id, the bucket
	 * Clause appended, Scopes / Params kept, Records dropped, one probe facet) as the same principal
	 * with the same pinned Now.  An excluded FilterString term, or an excluded Id that cannot be
	 * mapped back to a clause, is Skipped.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {Record<string, any>} pEnvelope
	 * @param {Record<string, any>} pRequestOptions
	 * @param {Function} fCallback
	 */
	let fRoundTripViaReference = (pEntity, pBody, pEnvelope, pRequestOptions, fCallback) =>
	{
		let tmpMaxBuckets = (typeof(pRequestOptions.MaxBuckets) === 'number') ? pRequestOptions.MaxBuckets : Infinity;
		let tmpZeroSample = (typeof(pRequestOptions.ZeroSample) === 'number') ? pRequestOptions.ZeroSample : 2;
		let tmpReport = { Checked: 0, Skipped: 0, CountVia: 'Reference', Mismatches: [] };
		let tmpBody = pBody || {};
		if (!pEnvelope || (typeof(pEnvelope) !== 'object') || (typeof(pEnvelope.Facets) !== 'object'))
		{
			return fCallback(new Error('assertSelectionRoundTrip needs a facet envelope.'), tmpReport);
		}
		let tmpClauses = Array.isArray(tmpBody.Clauses) ? tmpBody.Clauses : [];
		let tmpSimpleClauses = !tmpClauses.some((pClause) => { return !pClause || pClause.GUIDGroup || (pClause.Junction === 'OR') || (pClause.Enabled === false); });
		let tmpSpecs = {};
		let tmpSpecList = Array.isArray(tmpBody.Facets) ? tmpBody.Facets : [];
		tmpSpecList.forEach(
			(pSpec) =>
			{
				let tmpKey = (typeof(pSpec.Key) === 'string') ? pSpec.Key : (Array.isArray(pSpec.Facet) ? pSpec.Facet.join('|') : pSpec.Facet);
				tmpSpecs[tmpKey] = pSpec;
			});

		/**
		 * The body's clauses without the excluded ones, or null when an excluded entry cannot be
		 * removed through the body (a FilterString term, an unmappable Id).
		 */
		let fKeptClauses = (pExcluded) =>
		{
			let tmpRemove = new Set();
			for (let i = 0; i < pExcluded.length; i++)
			{
				let tmpEntry = pExcluded[i];
				let tmpIndex = tmpClauses.findIndex((pClause) => { return pClause && (pClause.Hash === tmpEntry); });
				if (tmpIndex < 0)
				{
					let tmpMatch = /^c([0-9]+)$/.exec(String(tmpEntry));
					if (!tmpMatch || !tmpSimpleClauses || (parseInt(tmpMatch[1], 10) > tmpClauses.length))
					{
						return null;
					}
					tmpIndex = parseInt(tmpMatch[1], 10) - 1;
				}
				tmpRemove.add(tmpIndex);
			}
			return tmpClauses.filter((pClause, pIndex) => { return !tmpRemove.has(pIndex); });
		};
		// The count body: the body's own filter inputs (Scopes, Params, FilterString kept) with the
		// given clauses, Records dropped, and ONE probe facet with Exclude 'None' — its Total is the
		// count of the probe body under that facet's own definition Where (W_def), which is what a
		// facet Total and a bucket Count are (the envelope Total has no W_def).
		let fProbeBody = (pClauseList, pSpec) =>
		{
			let tmpProbe = Object.assign({}, tmpBody);
			delete tmpProbe.Records;
			tmpProbe.Clauses = pClauseList;
			tmpProbe.Total = true;
			let tmpSpec = Object.assign({}, pSpec || tmpSpecList[0] || {});
			tmpSpec.Key = 'Probe';
			tmpSpec.Exclude = 'None';
			delete tmpSpec.Chart;
			tmpProbe.Facets = [ tmpSpec ];
			return tmpProbe;
		};

		let tmpChecks = [];
		if (typeof(pEnvelope.Total) === 'number')
		{
			tmpChecks.push({ Facet: '#Envelope', Check: 'EnvelopeTotal', Expected: pEnvelope.Total, Body: fProbeBody(tmpClauses, null) });
		}
		let tmpFacetKeys = Object.keys(pEnvelope.Facets);
		for (let i = 0; i < tmpFacetKeys.length; i++)
		{
			let tmpFacetKey = tmpFacetKeys[i];
			let tmpFacet = pEnvelope.Facets[tmpFacetKey];
			if (!tmpFacet || (typeof(tmpFacet) !== 'object'))
			{
				continue;
			}
			let tmpExcluded = Array.isArray(tmpFacet.Excluded) ? tmpFacet.Excluded : [];
			let tmpExpectedExcluded = expectedExclusion(tmpBody, tmpSpecs[tmpFacetKey]);
			if (tmpExpectedExcluded === null)
			{
				tmpReport.Skipped++;
			}
			else
			{
				tmpReport.Checked++;
				if (JSON.stringify(tmpExpectedExcluded) !== JSON.stringify(tmpExcluded))
				{
					tmpReport.Mismatches.push({ Facet: tmpFacetKey, Check: 'Excluded', Expected: tmpExpectedExcluded, Actual: tmpExcluded });
				}
			}
			let tmpKept = fKeptClauses(tmpExcluded);
			if (tmpKept === null)
			{
				tmpReport.Skipped++;
				continue;
			}
			let tmpSpec = tmpSpecs[tmpFacetKey];
			if (typeof(tmpFacet.Total) === 'number')
			{
				tmpChecks.push({ Facet: tmpFacetKey, Check: 'FacetTotal', Expected: tmpFacet.Total, Body: fProbeBody(tmpKept, tmpSpec) });
				if ((tmpFacet.MultiValued !== true) && ((BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0) || (M2_BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0)) && (typeof(tmpFacet.SumOfCounts) === 'number'))
				{
					let tmpSum = tmpFacet.SumOfCounts + (tmpFacet.MissingCount || 0) + (tmpFacet.OtherCount || 0);
					tmpReport.Checked++;
					if (tmpSum !== tmpFacet.Total)
					{
						tmpReport.Mismatches.push({ Facet: tmpFacetKey, Check: 'SumOfCounts+MissingCount+OtherCount', Expected: tmpFacet.Total, Actual: tmpSum });
					}
				}
			}
			if (!tmpFacet.Selectable || !Array.isArray(tmpFacet.Buckets))
			{
				continue;
			}
			let tmpPositive = 0;
			let tmpZero = 0;
			for (let j = 0; j < tmpFacet.Buckets.length; j++)
			{
				let tmpBucket = tmpFacet.Buckets[j];
				if (!tmpBucket || !tmpBucket.Clause)
				{
					continue;
				}
				if (tmpBucket.Count > 0)
				{
					if (tmpPositive >= tmpMaxBuckets)
					{
						tmpReport.Skipped++;
						continue;
					}
					tmpPositive++;
				}
				else
				{
					if (tmpZero >= tmpZeroSample)
					{
						continue;
					}
					tmpZero++;
				}
				tmpChecks.push({ Facet: tmpFacetKey, Check: 'BucketCount', Key: tmpBucket.Key, Expected: tmpBucket.Count, Body: fProbeBody(tmpKept.concat([ tmpBucket.Clause ]), tmpSpec) });
			}
		}

		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpChecks.length)
			{
				if (tmpReport.Mismatches.length > 0)
				{
					let tmpError = new Error(`Selection round trip (Reference): ${tmpReport.Mismatches.length} mismatch(es) of ${tmpReport.Checked}: ${JSON.stringify(tmpReport.Mismatches.slice(0, 5))}`);
					tmpError.Report = tmpReport;
					return fCallback(tmpError, tmpReport);
				}
				return fCallback(null, tmpReport);
			}
			let tmpCheck = tmpChecks[pIndex];
			fInProcess(pEntity, tmpCheck.Body, pRequestOptions, internalOptions(pRequestOptions, { ForceEngine: 'Reference' }),
				(pError, pCountEnvelope) =>
				{
					if (pError)
					{
						tmpReport.Checked++;
						tmpReport.Mismatches.push({ Facet: tmpCheck.Facet, Check: tmpCheck.Check, Key: tmpCheck.Key, Expected: tmpCheck.Expected, Actual: (pError && pError.Code) ? pError.Code : String(pError) });
						return fNext(pIndex + 1);
					}
					tmpReport.Checked++;
					let tmpProbe = (pCountEnvelope && pCountEnvelope.Facets) ? pCountEnvelope.Facets.Probe : null;
					let tmpActual = (tmpCheck.Check === 'EnvelopeTotal')
						? (pCountEnvelope ? pCountEnvelope.Total : null)
						: (tmpProbe ? tmpProbe.Total : ((pCountEnvelope && pCountEnvelope.Errors && pCountEnvelope.Errors.Probe) ? pCountEnvelope.Errors.Probe.Code : null));
					if (tmpActual !== tmpCheck.Expected)
					{
						let tmpMismatch = { Facet: tmpCheck.Facet, Check: tmpCheck.Check, Expected: tmpCheck.Expected, Actual: tmpActual };
						if (Object.prototype.hasOwnProperty.call(tmpCheck, 'Key'))
						{
							tmpMismatch.Key = tmpCheck.Key;
						}
						tmpReport.Mismatches.push(tmpMismatch);
					}
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	};

	/**
	 * The entity whose rows a facet's bucket keys come from, and the field: the pivot for a column
	 * facet; the target of the last path step for a path facet (K8 / K9).  null when the harness
	 * cannot tell (tuple facets, unknown steps).
	 *
	 * @param {string} pEntity - the route entity
	 * @param {Record<string, any>} pFacet - FacetResult
	 * @return {{ Entity: string, Field: string }|null}
	 */
	let fKeySource = (pEntity, pFacet) =>
	{
		if ((typeof(pFacet.Field) !== 'string') || (pFacet.Field.indexOf('.') >= 0) || (pFacet.CountMode === 'KeyDistinct'))
		{
			return null;
		}
		if (!Array.isArray(pFacet.Path) || (pFacet.Path.length < 1))
		{
			return { Entity: pEntity, Field: pFacet.Field };
		}
		let tmpLast = String(pFacet.Path[pFacet.Path.length - 1]);
		let tmpMatch = /^([<>=])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(tmpLast);
		if (!tmpMatch)
		{
			return null;
		}
		if (tmpMatch[1] !== '>')
		{
			return { Entity: tmpMatch[2], Field: pFacet.Field };
		}
		let tmpColumn = tmpHarness.fable.RetoldFacetingCatalog.column(tmpMatch[2], tmpMatch[3]);
		return (tmpColumn && tmpColumn.JoinTarget) ? { Entity: tmpColumn.JoinTarget, Field: pFacet.Field } : null;
	};

	/**
	 * Two-tenant isolation (internal-contracts §32.1, O6): for each named principal — Live (HTTP) ==
	 * Reference; every Terms bucket key (column facets and path facets) is a value of a row that
	 * principal can see; a bucket whose label resolved never resolves through another tenant's row;
	 * every Keys key and every record of the first Records page of the body's filter is a row the
	 * principal can see, and the Keys Count equals the envelope Total.
	 *
	 * An optional fourth argument { Keys: false } skips the Keys-route part (the facet checks only):
	 * assertTenantIsolation(pEntity, pBody, pPrincipalNames, [pOptions,] fCallback).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {Array<string>} pPrincipalNames
	 * @param {{ Keys?: boolean }|Function} pOptions
	 * @param {(pError?: Error, pReport?: Record<string, any>) => void} [fCallback]
	 */
	tmpHarness.assertTenantIsolation = (pEntity, pBody, pPrincipalNames, pOptions, fCallback) =>
	{
		if (typeof(pOptions) === 'function')
		{
			fCallback = pOptions;
			pOptions = {};
		}
		let tmpCheckKeys = !(pOptions && (pOptions.Keys === false));
		let tmpReport = { Checked: 0, Skipped: 0, Principals: {}, Mismatches: [] };
		let tmpNames = Array.isArray(pPrincipalNames) ? pPrincipalNames.slice() : Object.keys(tmpHarness.principals);
		let tmpPKOf = (pTable) => { return libBookstoreSeed.primaryKeyOf(tmpHarness.model, pTable); };
		let fMismatch = (pName, pMismatch) =>
		{
			tmpReport.Checked++;
			tmpReport.Mismatches.push(Object.assign({ Principal: pName }, pMismatch));
		};

		let fPrincipal = (pIndex) =>
		{
			if (pIndex >= tmpNames.length)
			{
				if (tmpReport.Mismatches.length > 0)
				{
					let tmpError = new Error(`Tenant isolation: ${tmpReport.Mismatches.length} mismatch(es): ${JSON.stringify(tmpReport.Mismatches.slice(0, 5))}`);
					tmpError.Report = tmpReport;
					return fCallback(tmpError, tmpReport);
				}
				return fCallback(null, tmpReport);
			}
			let tmpName = tmpNames[pIndex];
			let tmpPrincipal = tmpHarness.as(tmpName);
			tmpReport.Principals[tmpName] = { Total: null, Buckets: 0, Keys: 0 };
			tmpHarness.compare(pEntity, pBody, tmpPrincipal,
				(pCompareError, pCompared) =>
				{
					if (pCompareError)
					{
						return fCallback(pCompareError, tmpReport);
					}
					tmpReport.Checked++;
					if (pCompared.Live.Status !== 200)
					{
						fMismatch(tmpName, { Check: 'LiveStatus', Expected: 200, Actual: pCompared.Live.Status, Body: pCompared.Live.Body });
						return fPrincipal(pIndex + 1);
					}
					if (JSON.stringify(pCompared.LiveNormalized) !== JSON.stringify(pCompared.ReferenceNormalized))
					{
						fMismatch(tmpName, { Check: 'LiveEqualsReference', Expected: 'equal envelopes', Actual: 'different' });
					}
					let tmpEnvelope = pCompared.Live.Body;
					tmpReport.Principals[tmpName].Total = tmpEnvelope.Total;
					let tmpFacetKeys = Object.keys(tmpEnvelope.Facets || {});
					for (let i = 0; i < tmpFacetKeys.length; i++)
					{
						let tmpFacet = tmpEnvelope.Facets[tmpFacetKeys[i]];
						if (!tmpFacet || (tmpFacet.Fold !== 'Terms') || !Array.isArray(tmpFacet.Buckets))
						{
							continue;
						}
						let tmpSource = fKeySource(pEntity, tmpFacet);
						if (!tmpSource || !tmpHarness.model.Tables[tmpSource.Entity])
						{
							tmpReport.Skipped++;
							continue;
						}
						let tmpVisible = new Set(tmpHarness.visibleRows(tmpSource.Entity, tmpPrincipal).map((pRow) => { return JSON.stringify(libFacetEnvelope.normalizeKey(pRow[tmpSource.Field], (typeof(pRow[tmpSource.Field]) === 'number') ? 'Numeric' : 'String')); }));
						let tmpColumn = tmpHarness.fable.RetoldFacetingCatalog.column(tmpSource.Entity, tmpSource.Field);
						let tmpLabelTarget = (tmpColumn && tmpColumn.JoinTarget) ? tmpColumn.JoinTarget : ((tmpColumn && tmpColumn.IsPK) ? tmpSource.Entity : null);
						for (let j = 0; j < tmpFacet.Buckets.length; j++)
						{
							let tmpBucket = tmpFacet.Buckets[j];
							if (!tmpBucket || !(tmpBucket.Count > 0))
							{
								continue;
							}
							tmpReport.Principals[tmpName].Buckets++;
							tmpReport.Checked++;
							if (!tmpVisible.has(JSON.stringify(tmpBucket.Key)))
							{
								fMismatch(tmpName, { Facet: tmpFacetKeys[i], Check: 'BucketKeyVisible', Key: tmpBucket.Key, Entity: tmpSource.Entity, Field: tmpSource.Field });
							}
							if ((tmpBucket.LabelResolved === true) && tmpLabelTarget)
							{
								let tmpTargetPK = tmpPKOf(tmpLabelTarget);
								let tmpTargetVisible = tmpHarness.visibleRows(tmpLabelTarget, tmpPrincipal).some((pRow) => { return pRow[tmpTargetPK] === tmpBucket.Key; });
								tmpReport.Checked++;
								if (!tmpTargetVisible)
								{
									fMismatch(tmpName, { Facet: tmpFacetKeys[i], Check: 'LabelFromVisibleRow', Key: tmpBucket.Key, Entity: tmpLabelTarget });
								}
							}
						}
					}
					if (!tmpCheckKeys)
					{
						return fPrincipal(pIndex + 1);
					}
					let tmpKeysBody = Object.assign({}, pBody || {});
					delete tmpKeysBody.Facets;
					delete tmpKeysBody.Records;
					delete tmpKeysBody.Total;
					tmpHarness.keys(pEntity, tmpKeysBody, tmpPrincipal,
						(pKeysError, pKeysResponse) =>
						{
							if (pKeysError)
							{
								return fCallback(pKeysError, tmpReport);
							}
							tmpReport.Checked++;
							if ((pKeysResponse.Status !== 200) || !pKeysResponse.Body || !Array.isArray(pKeysResponse.Body.Keys))
							{
								fMismatch(tmpName, { Check: 'KeysStatus', Expected: 200, Actual: pKeysResponse.Status });
								return fPrincipal(pIndex + 1);
							}
							let tmpPK = tmpPKOf(pEntity);
							let tmpVisibleKeys = new Set(tmpHarness.visibleRows(pEntity, tmpPrincipal).map((pRow) => { return pRow[tmpPK]; }));
							pKeysResponse.Body.Keys.forEach(
								(pKey) =>
								{
									tmpReport.Principals[tmpName].Keys++;
									tmpReport.Checked++;
									if (!tmpVisibleKeys.has(pKey))
									{
										fMismatch(tmpName, { Check: 'KeyVisible', Key: pKey, Entity: pEntity });
									}
								});
							if ((typeof(tmpEnvelope.Total) === 'number') && (pKeysResponse.Body.Truncated !== true))
							{
								tmpReport.Checked++;
								if (pKeysResponse.Body.Count !== tmpEnvelope.Total)
								{
									fMismatch(tmpName, { Check: 'KeysCountEqualsTotal', Expected: tmpEnvelope.Total, Actual: pKeysResponse.Body.Count });
								}
							}
							// The first Records page: every hydrated record is a row the principal can see.
							tmpHarness.records(pEntity, Object.assign({}, tmpKeysBody, { Records: { Begin: 0, Cap: 50 } }), tmpPrincipal,
								(pRecordsError, pRecordsResponse) =>
								{
									if (pRecordsError)
									{
										return fCallback(pRecordsError, tmpReport);
									}
									tmpReport.Checked++;
									if ((pRecordsResponse.Status !== 200) || !Array.isArray(pRecordsResponse.Body))
									{
										fMismatch(tmpName, { Check: 'RecordsStatus', Expected: 200, Actual: pRecordsResponse.Status });
										return fPrincipal(pIndex + 1);
									}
									pRecordsResponse.Body.forEach(
										(pRecord) =>
										{
											tmpReport.Checked++;
											if (!pRecord || !tmpVisibleKeys.has(pRecord[tmpPK]))
											{
												fMismatch(tmpName, { Check: 'RecordVisible', Key: pRecord ? pRecord[tmpPK] : null, Entity: pEntity });
											}
										});
									return fPrincipal(pIndex + 1);
								});
						});
				});
		};
		return fPrincipal(0);
	};

	return tmpHarness;
};

module.exports = (
	{
		TENANT_HEADER: TENANT_HEADER,
		USER_HEADER: USER_HEADER,
		TENANCY_BEHAVIOR_HASHES: TENANCY_BEHAVIOR_HASHES,
		BUCKETED_FOLDS: BUCKETED_FOLDS,
		M2_BUCKETED_FOLDS: M2_BUCKETED_FOLDS,
		DOMAINS: DOMAINS,
		domainSeed: domainSeed,
		domainOptions: domainOptions,
		expectedExclusion: expectedExclusion,
		needsReferenceCount: needsReferenceCount,
		sessionFor: sessionFor,
		syntheticRequest: syntheticRequest,
		internalOptions: internalOptions,
		testTenancyBehavior: testTenancyBehavior,
		policyBehavior: policyBehavior,
		installBehavior: installBehavior,
		meadowEndpointsModule: meadowEndpointsModule,
		bindHost: bindHost,
		start: start
	});
