/**
 * Facet-RAFS-Harness — boots a retold-application-foundation-server (RAFS) app in-process with the
 * faceting installers, for the gated host tests (internal-contracts Part V §80).
 *
 * RAFS is a PRIVATE package: retold-faceting-service never depends on it.  The gate (§80.1):
 *
 *   RFS_TEST_RAFS_PATH=<dir>   use exactly that checkout (an invalid path is reported, never replaced)
 *   (unset)                    the monorepo checkout next to this module:
 *                              <retold>/modules/private/retold-application-foundation-server
 *
 * resolveRAFS() never requires the package (it reads package.json only); load() requires its main and
 * returns the RetoldApplicationServer class.  RAFS's own dependencies resolve from the umbrella
 * node_modules (no install step).
 *
 * The contract of start() and of the harness object is internal-contracts §80.2:
 *
 *   start(
 *   	{
 *   		Port: 19138,                          // registry tag (§80.5); binds 127.0.0.1:0 (an overridden _startOrator)
 *   		FixedPort: false,                     // true: bind 127.0.0.1:<Port> itself (debug/rafs-smoke.js, SMOKE_PORT 19194)
 *   		Fixture: 'LabTrack' | 'ProjectTrack', // the domain seed (internal-contracts §31) + its tenancyConfig() (§80.3)
 *   		Provider: 'SQLite' | 'PostgreSQL',    // DatabaseProvider; PostgreSQL only behind RFS_TEST_POSTGRES (rfs-test-postgres)
 *   		Session: 'Header' | 'Login',          // §80.3: a tenancy resolveSession over SESSION_HEADERS, or real
 *   		                                      // orator-authentication + Auth.Local + Entitlements + Membership
 *   		Overlay: true,                        // add the probe tables (RAFS-Overlay-Model, §80.3)
 *   		Faceting: { },                        // explicit RetoldFaceting options handed to both installers
 *   		Tenancy: { } | false,                 // shallow overrides of the fixture's tenancyConfig() (false: no tenancy)
 *   		Entitlements: 'Auto' | false | { },   // Login mode default: the overlay role tables + ExcludeEntities
 *   		LateMounts: [ 'ProbeLate', … ],       // register meadow-endpoints in pServer.Endpoints from a route
 *   		                                      // installer that runs after tenancy and before foundationRouteInstaller
 *   		Installers: 'Both' | 'RouteOnly' | 'None',
 *   		BeforeListen: (pHarness[, fNext]) => { },   // the route installer right before foundationRouteInstaller
 *   		Seed, Scale, LogLevel,
 *   		Roles: [ { Key, Name, Actions } ],    // Login: the DefaultRoles provisioned per tenant (default DEFAULT_ROLES)
 *   		Grants: { <Principal>: [ roleKey ] }, // Login: role keys per principal (default DEFAULT_GRANTS)
 *   		Denies: { <Principal>: [ action ] },  // Login: UserAction deny rows per principal
 *   		Membership: true | false,             // Login: mount Retold-Membership (signup, tenant switch); default true
 *   		Store: null | 'ClickHouse',           // the ClickHouse store on a fresh rfs_<pid>_<n> database (CH-gated: an
 *   		                                      // unavailable gate calls back .Skip); the materializer backfills before fDone
 *   		StoreOptions: { Store, Materialize, Reconcile, Quiesce, QuiesceTimeoutMS }
 *   	}, (pError, pHarness) => { … });
 *
 *   pHarness:
 *   	server, fable, service (fable.RetoldFacetingService), host (service.Host), rafs { Path, Version },
 *   	port, baseURL, fixture, seed (the generate() result + counts), model, principals, traps,
 *   	tenancy (the tenancyConfig() in force), entitlements (the entitlementsConfig() or null), faceting (the
 *   	installer options), session ('Header' | 'Login'), provider
 *   	as(pName)                                   → { Tenant, User } of a principal (its current tenant)
 *   	sessionFor(pName)                           → { UserRecord } (in-process) — the session the tenancy guard sees
 *   	request(pMethod, pPath, pBody, pName, cb)   → { Status, Headers, JSON, Body, Text } over HTTP as that principal
 *   	facet(pEntity, pBody, pName, cb)            → POST <RoutePrefix>/<Entity>/Query as that principal
 *   	describe(pEntity|null, pName, cb)           → GET <RoutePrefix>/Describe[/<Entity>]
 *   	query(pEntity, pBody, { As, Now, PlanForm }, cb)   → in-process queryInternal with { UserSession: sessionFor(As) }
 *   	reference(…) / compare(…)                   → as the RDS harness (§32.1), same principal and pinned Now
 *   	listCount(pEntity, pFilterString, pName, cb) → the stock RAFS Count route (GET /1.0/<E>s/Count/FilteredTo/…), the O2 oracle
 *   	visibleRows(pTable, pName)                  → the seeded rows that principal's RAFS list shows
 *   	assertTenantIsolation(pEntity, pBody, pNames, [pOptions,] cb)
 *   	login(pName, cb) / switchTenant(pName, pIDCustomer, cb)   (Login mode; switchTenant also emulates in Header mode)
 *   	keys / records (HTTP), toFilterString(pEntity, pBody) (the fenced RAW list filter of a body),
 *   	listRows(pEntity, pFilterString, pName, cb) (every row of the stock RAFS list as that principal),
 *   	allRecords(pEntity, pBody, pName, cb) (every Facet Records page), assertRecordsMatchList(pEntity, pBody, pName, cb),
 *   	assertSelectionRoundTrip(pEntity, pBody, pEnvelope, { As, Now, CountVia, MaxBuckets, ZeroSample }, cb) (O2:
 *   	'List' = the stock RAFS Count route as that principal; 'Reference' = the in-process Reference as that session;
 *   	'Auto' = the list unless the body needs the Reference), principalFor(pName, cb) (Host.resolvePrincipal of the
 *   	principal's session), openChanges(pName, { Headers }, cb) (GET <RoutePrefix>/Changes, SSE),
 *   	quiesce(cb) / storeQuery / compareStore (Store 'ClickHouse')
 *   	stop(cb)                                     → fable.Orator.stopService, then release the database / temp directory
 *
 * Principals: the fixture's (LabTrack: Tech, Colleague, Newbie, OtherTech; ProjectTrack: Lead, Member,
 * Outsider, OtherLead) plus the harness's own: Root (a tenant-1 persona whose account carries the Membership
 * platform marker SystemRole 'root'), Traveler (memberships in tenant 1 and tenant 2, for tenant switches) and
 * TenantZero (Login: an account with no membership; Header: the tenant header '0' — an authenticated tenant-0
 * session either way).  pName null / undefined / 'Anonymous' is the anonymous request.
 *
 * Identity, by Session (§80.3):
 *   'Header'  tenancyConfig().resolveSession reads SESSION_HEADERS ('x-rfs-test-tenant' / 'x-rfs-test-user')
 *             → { UserRecord: { IDCustomer, IDUser } }; no tenant header → {} (anonymous) — the way RAFS's own
 *             tenancy tests drive two tenants (Retold-Tenancy_tests.js).
 *   'Login'   EnableAuthentication with the shared Auth.Local authenticator over RFSAccount + RFSMembership, the
 *             Retold-Entitlements gate (which IDUser-enriches every authenticated request) and Retold-Membership
 *             (tenant switch).  Accounts are seeded with RAFS's AuthLocal.ensureUser (scrypt), memberships through
 *             the DAL, roles with Entitlements.provisionDefaultRoles / grantRole — the helpers RAFS exports for
 *             app seeds — and every principal logs in through POST /1.0/Authenticate, keeping the RetoldSessionID
 *             cookie.  Nothing in RAFS is patched or forged; passwords are random per harness and never leave it.
 *             (Entitlements: false in Login mode leaves UserRecord.IDUser unset — only the entitlements pre-handler
 *             enriches it in RAFS — so a personal scope such as LabForm.OwnerIDUser reads 0.)
 *
 * Database: SQLite in memory (the RAFS fable's own MeadowSQLiteProvider connection), or a fresh rfs_<pid>_<n>
 * database on rfs-test-postgres (PostgreSQL, gated as Facet-Harness-Providers).  The fixture tables are created
 * from the fixture's own nullable DDL BEFORE RAFS's _runSchema (preSchemaSteps on SQLite; before boot on
 * PostgreSQL), so createTables' CREATE TABLE IF NOT EXISTS is a no-op and the seeded NULLs stay NULL — RAFS's
 * generated DDL is NOT NULL DEFAULT, which would reject or rewrite them.  That is exactly an app booting on a
 * populated database.  SQLite rows go in through seedSteps() (after _loadMeadowEndpoints, as the contract says).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');
const libFS = require('fs');
const libHttp = require('http');
const libOS = require('os');
const libPath = require('path');

const libFable = require('fable');

const libRetoldFacetingService = require('../../source/Retold-Faceting-Service.js');
const libOptions = require('../../source/Retold-Faceting-Service-Options.js');
const libFacetEnvelope = require('../../source/contract/Facet-Contract-Envelope.js');
const libBookstoreSeed = require('../fixtures/Bookstore-Seed.js');
const libCommon = require('../fixtures/Domain-Seed-Common.js');
const libLabTrackSeed = require('../fixtures/LabTrack-Seed.js');
const libProjectTrackSeed = require('../fixtures/ProjectTrack-Seed.js');
const libProviders = require('./Facet-Harness-Providers.js');
// The RDS harness's O2 helpers (the request-derived exclusion, the CountVia 'Auto' rule, the fold sets).
const libFacetTestHarness = require('./Facet-Test-Harness.js');

// A join clause compiles to a Path-shaped conjunct the list syntax cannot carry (counted via the Reference).
const PATH_CLAUSE_PATTERN = /^(InternalJoin|ExternalJoin)/;

const ENV_RAFS_PATH = 'RFS_TEST_RAFS_PATH';
const PACKAGE_NAME = 'retold-application-foundation-server';

// <retold>/modules/meadow/retold-faceting-service/test/support → <retold>/modules/private/<package>
const MONOREPO_RAFS_PATH = libPath.resolve(__dirname, '..', '..', '..', '..', 'private', PACKAGE_NAME);

// Header-mode identity (§80.3): the harness's tenancyConfig().resolveSession reads these.  No tenant
// header → anonymous ({}); a tenant header of '0' → an authenticated session in tenant 0 (the 401 case).
const SESSION_HEADERS = Object.freeze({ Tenant: 'x-rfs-test-tenant', User: 'x-rfs-test-user' });

// Registry tags (internal-contracts §80.5); every server binds an ephemeral port on 127.0.0.1.
const PORTS = Object.freeze({ Header: 19138, Login: 19139 });
// debug/rafs-smoke.js (a manual run; FixedPort: true binds it on 127.0.0.1 so it can be curled).
const SMOKE_PORT = 19194;

const SESSIONS = Object.freeze([ 'Header', 'Login' ]);
const INSTALLERS = Object.freeze([ 'Both', 'RouteOnly', 'None' ]);

// The probe overlay and the Kit identity tables (§80.3), Stricture extended.
const OVERLAY_MODEL_PATH = libPath.resolve(__dirname, '..', 'fixtures', 'RAFS-Overlay-Model.json');

// Overlay table roles (§80.3).
const IDENTITY_NO_AUTO_CRUD = Object.freeze([ 'RFSAccount', 'RFSMembership', 'UserAction' ]);
const PROBE_NO_AUTO_CRUD = Object.freeze([ 'ProbeHidden' ]);
const PROBE_EXCLUDED = Object.freeze([ 'ProbeExcluded', 'ProbeGlobal' ]);
const PROBE_DENIED_PREFIXES = Object.freeze([ '/1.0/ProbeDenied' ]);
const PROBE_GLOBAL_ENTITIES = Object.freeze([ 'ProbeGlobal', 'ProbeLateGlobal' ]);
const PROBE_LATE_MOUNTS = Object.freeze([ 'ProbeLate', 'ProbeLateGlobal' ]);
const PROBE_LINK = 'ProbeLink';
// Rows per probe per tenant (the last one soft-deleted) and ProbeLink rows per tenant.
const PROBE_ROWS = 4;

// Fixture → its seed and the RAFS app shape around it (§80.3).  GlobalEntities lists the fixture's global
// lookup and the tenant root (Customer is Installed: listed to prove §78 rule 5 does not hide it).
const FIXTURES = Object.freeze(
	{
		LabTrack: Object.freeze(
			{
				Seed: libLabTrackSeed,
				Global: Object.freeze([ 'LabFormType' ]),
				PersonalScopes: Object.freeze({ LabForm: Object.freeze({ Column: 'OwnerIDUser', SessionField: 'IDUser' }) })
			}),
		ProjectTrack: Object.freeze(
			{
				Seed: libProjectTrackSeed,
				Global: Object.freeze([ 'FormType' ]),
				PersonalScopes: Object.freeze({})
			})
	});

// Login mode: the shared local authenticator over the overlay's identity tables (§80.3).
const AUTH_LOCAL = Object.freeze(
	{
		UserTable: 'RFSAccount',
		LoginField: 'LoginID',
		PasswordField: 'Password',
		IDField: 'IDRFSAccount',
		TenantField: 'IDCustomer',
		MembershipTable: 'RFSMembership',
		MembershipUserField: 'IDRFSAccount',
		MembershipTenantField: 'IDCustomer'
	});

// The roles provisioned in every tenant (Retold-Entitlements DefaultRoles shape).
const DEFAULT_ROLES = Object.freeze(
	[
		Object.freeze({ Key: 'owner', Name: 'Owner', Description: 'Every action.', Actions: Object.freeze([ '*' ]) }),
		Object.freeze({ Key: 'reader', Name: 'Reader', Description: 'Every read.', Actions: Object.freeze([ '*.read' ]) })
	]);

// Role keys per principal (every membership gets them).  The fixture's first principal and the other
// tenant's principal own their tenant; everyone else reads.
const DEFAULT_GRANTS = Object.freeze(
	{
		Tech: [ 'owner' ], OtherTech: [ 'owner' ], Colleague: [ 'reader' ], Newbie: [ 'reader' ],
		Lead: [ 'owner' ], OtherLead: [ 'owner' ], Member: [ 'reader' ], Outsider: [ 'reader' ],
		Root: [ 'owner' ], Traveler: [ 'reader' ], TenantZero: []
	});

// Membership's platform-principal marker (Retold-Membership.js:75-76 defaults).
const SYSTEM_ADMIN_FIELD = 'SystemRole';
const SYSTEM_ADMIN_VALUE = 'root';

/**
 * Where the RAFS checkout is, and whether it can be used.  Never requires the package.
 *
 * @return {{ Available: boolean, Source: string, Path: string, Main?: string, Version?: string, Reason?: string }}
 */
const resolveRAFS = () =>
{
	let tmpFromEnv = (typeof(process.env[ENV_RAFS_PATH]) === 'string') && (process.env[ENV_RAFS_PATH].length > 0);
	let tmpSource = tmpFromEnv ? ENV_RAFS_PATH : 'Monorepo';
	let tmpPath = tmpFromEnv ? libPath.resolve(process.env[ENV_RAFS_PATH]) : MONOREPO_RAFS_PATH;
	let fUnavailable = (pReason) =>
	{
		return { Available: false, Source: tmpSource, Path: tmpPath, Reason: `${pReason} (set ${ENV_RAFS_PATH} to a ${PACKAGE_NAME} checkout to run these tests)` };
	};
	let tmpPackage = null;
	try
	{
		tmpPackage = JSON.parse(libFS.readFileSync(libPath.join(tmpPath, 'package.json'), 'utf8'));
	}
	catch (pError)
	{
		return fUnavailable(`${PACKAGE_NAME} not found at ${tmpPath}`);
	}
	if (!tmpPackage || (tmpPackage.name !== PACKAGE_NAME))
	{
		return fUnavailable(`${tmpPath} is not ${PACKAGE_NAME} (package name '${tmpPackage ? tmpPackage.name : ''}')`);
	}
	let tmpMain = libPath.join(tmpPath, (typeof(tmpPackage.main) === 'string') ? tmpPackage.main : 'source/Retold-Application-Server.js');
	if (!libFS.existsSync(tmpMain))
	{
		return fUnavailable(`${PACKAGE_NAME} at ${tmpPath} has no ${libPath.relative(tmpPath, tmpMain)}`);
	}
	return { Available: true, Source: tmpSource, Path: tmpPath, Main: tmpMain, Version: String(tmpPackage.version || '') };
};

/**
 * Require the RetoldApplicationServer class of a resolved checkout.
 *
 * @param {Record<string, any>} [pResolution] - resolveRAFS() (default: a fresh resolution)
 * @return {any} the class (its statics .Tenancy, .Entitlements, .AuthLocal, …)
 */
const load = (pResolution) =>
{
	let tmpResolution = pResolution || resolveRAFS();
	if (!tmpResolution.Available)
	{
		throw new Error(tmpResolution.Reason);
	}
	return require(tmpResolution.Main);
};

/**
 * An Error a gated suite turns into a skip (as Facet-Harness-Providers).
 *
 * @param {string} pMessage
 * @return {Error}
 */
const skipError = (pMessage) =>
{
	let tmpError = new Error(pMessage);
	tmpError.Skip = true;
	return tmpError;
};

/**
 * The overlay model file (parsed fresh: callers mutate their copy).
 *
 * @return {Record<string, any>}
 */
const overlayModel = () =>
{
	return JSON.parse(libFS.readFileSync(OVERLAY_MODEL_PATH, 'utf8'));
};

/**
 * Live (Deleted 0) primary keys of one tenant's rows of a table, ascending.
 *
 * @param {Record<string, any>} pGenerated
 * @param {string} pTable
 * @param {number} pTenant
 * @return {Array<number>}
 */
const liveKeys = (pGenerated, pTable, pTenant) =>
{
	let tmpPK = libBookstoreSeed.primaryKeyOf(pGenerated.Model, pTable);
	return (pGenerated.Rows[pTable] || [])
		.filter((pRow) => { return (pRow.Deleted === 0) && (pRow[pGenerated.TenantColumn] === pTenant); })
		.map((pRow) => { return pRow[tmpPK]; })
		.sort((pLeft, pRight) => { return pLeft - pRight; });
};

/**
 * Merge the overlay into a generate() result: the identity tables (always in Login mode, with the probes
 * otherwise) and the fixture's probe tables with deterministic rows.  The fixture files are never edited:
 * generate() returns a deep-cloned model, and the overlay comes from its own file.
 *
 * Probe rows: PROBE_ROWS per tenant for a probe with the tenancy column (the last soft-deleted), PROBE_ROWS
 * in all for a global probe (alternating tenants for the anchors), anchored on the tenant's first live
 * rows of the two anchor tables; ProbeLink: PROBE_ROWS per tenant, row k pointing at the k-th row of every
 * probe of its tenant (global probes: the k-th row).
 *
 * @param {Record<string, any>} pGenerated - mutated
 * @param {string} pFixture
 * @param {{ Identity: boolean, Probes: boolean }} pParts
 * @return {Record<string, any>} pGenerated
 */
const mergeOverlay = (pGenerated, pFixture, pParts) =>
{
	let tmpOverlay = overlayModel();
	let tmpModel = pGenerated.Model;
	let fAddTables = (pTables) =>
	{
		Object.keys(pTables).forEach(
			(pTable) =>
			{
				if (tmpModel.Tables[pTable])
				{
					throw new Error(`Facet-RAFS-Harness: the overlay table [${pTable}] collides with a ${pFixture} table.`);
				}
				tmpModel.Tables[pTable] = pTables[pTable];
				if (Array.isArray(tmpModel.TablesSequence))
				{
					tmpModel.TablesSequence.push(pTable);
				}
				pGenerated.Order.push(pTable);
				pGenerated.Rows[pTable] = [];
			});
	};
	if (pParts.Identity)
	{
		fAddTables(tmpOverlay.Identity.Tables);
	}
	if (!pParts.Probes)
	{
		return pGenerated;
	}
	let tmpProbes = tmpOverlay.Probes[pFixture];
	if (!tmpProbes)
	{
		throw new Error(`Facet-RAFS-Harness: the overlay has no probes for [${pFixture}].`);
	}
	fAddTables(tmpProbes.Tables);

	let tmpTenants = pGenerated.Tenants;
	let tmpTenantColumn = pGenerated.TenantColumn;
	let tmpAnchors = {};
	tmpTenants.forEach(
		(pTenant) =>
		{
			tmpAnchors[pTenant] = {};
			tmpProbes.Anchors.forEach((pColumn) => { tmpAnchors[pTenant][pColumn] = liveKeys(pGenerated, pColumn.substring(2), pTenant); });
		});
	let tmpGUID = 0;
	let fGUID = () =>
	{
		tmpGUID++;
		return `00000000-0000-4000-8000-${String(tmpGUID).padStart(12, '0')}`;
	};
	let fRow = (pTable, pID, pK, pTenant, pName, pDeleted) =>
	{
		let tmpRow = {};
		tmpRow[`ID${pTable}`] = pID;
		tmpRow[`GUID${pTable}`] = fGUID();
		tmpRow.CreateDate = `2026-02-0${pK + 1} 09:00:00`;
		tmpRow.CreatingIDUser = 0;
		tmpRow.UpdateDate = `2026-02-0${pK + 1} 10:00:00`;
		tmpRow.UpdatingIDUser = 0;
		tmpRow.Deleted = pDeleted ? 1 : 0;
		tmpRow.DeleteDate = pDeleted ? '2026-03-01 00:00:00' : null;
		tmpRow.DeletingIDUser = 0;
		tmpRow.Name = pName;
		tmpProbes.Anchors.forEach(
			(pColumn) =>
			{
				let tmpKeys = tmpAnchors[pTenant][pColumn];
				tmpRow[pColumn] = (tmpKeys.length > 0) ? tmpKeys[pK % tmpKeys.length] : null;
			});
		return tmpRow;
	};
	// Probe table → tenant ('*' for global) → [ ID by k ]
	let tmpProbeKeys = {};
	let tmpProbeNames = Object.keys(tmpProbes.Tables).filter((pTable) => { return pTable !== PROBE_LINK; });
	tmpProbeNames.forEach(
		(pTable) =>
		{
			let tmpScoped = libCommon.hasColumn(tmpModel, pTable, tmpTenantColumn);
			let tmpID = 0;
			tmpProbeKeys[pTable] = {};
			if (tmpScoped)
			{
				tmpTenants.forEach(
					(pTenant) =>
					{
						tmpProbeKeys[pTable][pTenant] = [];
						for (let k = 0; k < PROBE_ROWS; k++)
						{
							tmpID++;
							let tmpRow = fRow(pTable, tmpID, k, pTenant, `${pTable} T${pTenant} #${k + 1}`, k === (PROBE_ROWS - 1));
							tmpRow[tmpTenantColumn] = pTenant;
							pGenerated.Rows[pTable].push(tmpRow);
							tmpProbeKeys[pTable][pTenant].push(tmpID);
						}
					});
				return;
			}
			tmpProbeKeys[pTable]['*'] = [];
			for (let k = 0; k < PROBE_ROWS; k++)
			{
				tmpID++;
				pGenerated.Rows[pTable].push(fRow(pTable, tmpID, k, tmpTenants[k % tmpTenants.length], `${pTable} #${k + 1}`, k === (PROBE_ROWS - 1)));
				tmpProbeKeys[pTable]['*'].push(tmpID);
			}
		});
	let tmpLinkID = 0;
	tmpTenants.forEach(
		(pTenant) =>
		{
			for (let k = 0; k < PROBE_ROWS; k++)
			{
				tmpLinkID++;
				let tmpRow = fRow(PROBE_LINK, tmpLinkID, k, pTenant, `${PROBE_LINK} T${pTenant} #${k + 1}`, false);
				tmpProbeNames.forEach(
					(pTable) =>
					{
						let tmpKeys = tmpProbeKeys[pTable][pTenant] || tmpProbeKeys[pTable]['*'];
						tmpRow[`ID${pTable}`] = tmpKeys[k];
					});
				tmpRow[tmpTenantColumn] = pTenant;
				pGenerated.Rows[PROBE_LINK].push(tmpRow);
			}
		});
	libCommon.completeRows(tmpModel, pGenerated.Rows);
	return pGenerated;
};

/**
 * The principals of a harness: the fixture's (one membership each) plus Root, Traveler and TenantZero, with
 * their memberships (home first) picked from live users no fixture principal is.
 *
 * @param {Record<string, any>} pGenerated
 * @return {Record<string, any>}
 */
const buildPrincipals = (pGenerated) =>
{
	let tmpPrincipals = {};
	let tmpTaken = new Set();
	Object.keys(pGenerated.Principals || {}).forEach(
		(pName) =>
		{
			let tmpSource = pGenerated.Principals[pName];
			tmpTaken.add(tmpSource.User);
			tmpPrincipals[pName] = { Name: pName, Kind: 'Fixture', Note: tmpSource.Note || '', Memberships: [ { Tenant: tmpSource.Tenant, User: tmpSource.User } ] };
		});
	let tmpSpare = {};
	pGenerated.Tenants.forEach((pTenant) => { tmpSpare[pTenant] = liveKeys(pGenerated, 'User', pTenant).filter((pUser) => { return !tmpTaken.has(pUser); }); });
	let fTake = (pTenant) =>
	{
		let tmpUser = tmpSpare[pTenant].shift();
		if (typeof(tmpUser) !== 'number')
		{
			throw new Error(`Facet-RAFS-Harness: no spare user in tenant ${pTenant} for the harness principals.`);
		}
		return { Tenant: pTenant, User: tmpUser };
	};
	let tmpFirst = pGenerated.Tenants[0];
	let tmpSecond = pGenerated.Tenants[1];
	tmpPrincipals.Root = { Name: 'Root', Kind: 'Platform', Note: `A tenant-${tmpFirst} persona whose account carries ${SYSTEM_ADMIN_FIELD} '${SYSTEM_ADMIN_VALUE}' (the Membership platform marker).`, Memberships: [ fTake(tmpFirst) ] };
	tmpPrincipals.Traveler = { Name: 'Traveler', Kind: 'Traveler', Note: `Memberships in tenants ${tmpFirst} (home) and ${tmpSecond}: switchTenant moves it.`, Memberships: [ fTake(tmpFirst), fTake(tmpSecond) ] };
	tmpPrincipals.TenantZero = { Name: 'TenantZero', Kind: 'TenantZero', Note: 'Authenticated with no membership: a tenant-0 session (401 for facets, 200 + no rows for RAFS lists).', Memberships: [] };
	Object.keys(tmpPrincipals).forEach(
		(pName) =>
		{
			let tmpPrincipal = tmpPrincipals[pName];
			let tmpHome = tmpPrincipal.Memberships[0] || { Tenant: 0, User: 0 };
			tmpPrincipal.Home = { Tenant: tmpHome.Tenant, User: tmpHome.User };
			tmpPrincipal.Tenant = tmpHome.Tenant;
			tmpPrincipal.User = tmpHome.User;
			tmpPrincipal.Platform = (tmpPrincipal.Kind === 'Platform');
			tmpPrincipal.LoginID = `rfs-${pName.toLowerCase()}`;
			tmpPrincipal.Cookie = null;
		});
	return tmpPrincipals;
};

/**
 * HTTP request through fetch; leaves the promise chain before calling back.
 *
 * @param {string} pURL
 * @param {string} pMethod
 * @param {any} pBody - JSON body, a string, or null
 * @param {Record<string, string>} pHeaders
 * @param {(pError?: Error, pResponse?: Record<string, any>) => void} fCallback
 */
const httpRequest = (pURL, pMethod, pBody, pHeaders, fCallback) =>
{
	let tmpHeaders = Object.assign({ accept: 'application/json' }, pHeaders || {});
	let tmpFetchOptions = { method: pMethod, headers: tmpHeaders };
	if ((pBody !== null) && (typeof(pBody) !== 'undefined'))
	{
		tmpHeaders['content-type'] = 'application/json';
		tmpFetchOptions.body = (typeof(pBody) === 'string') ? pBody : JSON.stringify(pBody);
	}
	fetch(pURL, tmpFetchOptions)
		.then(
			(pResponse) =>
			{
				return pResponse.text().then(
					(pText) =>
					{
						let tmpJSON = null;
						try
						{
							tmpJSON = (pText.length > 0) ? JSON.parse(pText) : null;
						}
						catch (pParseError)
						{
							tmpJSON = null;
						}
						let tmpHeadersOut = {};
						pResponse.headers.forEach((pValue, pKey) => { tmpHeadersOut[pKey] = pValue; });
						let tmpSetCookie = (typeof(pResponse.headers.getSetCookie) === 'function') ? pResponse.headers.getSetCookie() : [];
						return { Status: pResponse.status, Headers: tmpHeadersOut, JSON: tmpJSON, Body: (tmpJSON === null) ? pText : tmpJSON, Text: pText, SetCookie: tmpSetCookie };
					});
			})
		.then(
			(pResult) =>
			{
				// Leave the promise chain (assertion errors must not become rejections).
				setImmediate(() => { fCallback(null, pResult); });
			},
			(pError) =>
			{
				setImmediate(() => { fCallback(pError); });
			});
};

/**
 * Boot a RAFS app with the faceting installers (§80.2).  Returns the harness synchronously; fDone(pError,
 * pHarness) when it listens (on an error the harness is still returned, and stop() releases what started).
 * A missing RAFS checkout or an unavailable provider calls back an error with .Skip === true.
 *
 * @param {Record<string, any>} pOptions
 * @param {(pError?: Error, pHarness?: Record<string, any>) => void} fDone
 * @return {Record<string, any>}
 */
const start = (pOptions, fDone) =>
{
	let tmpInput = Object.assign({}, pOptions || {});
	let tmpSession = (typeof(tmpInput.Session) === 'string') ? tmpInput.Session : 'Login';
	let tmpOptions = Object.assign(
		{
			Port: PORTS[tmpSession],
			Fixture: 'LabTrack',
			Provider: 'SQLite',
			Session: tmpSession,
			Overlay: true,
			Faceting: {},
			Tenancy: {},
			Entitlements: (tmpSession === 'Login') ? 'Auto' : false,
			LateMounts: null,
			Installers: 'Both',
			BeforeListen: null,
			Seed: null,
			Scale: 'Small',
			LogLevel: 'fatal',
			Roles: null,
			Grants: {},
			Denies: {},
			Membership: true,
			Store: null,
			StoreOptions: {},
			FixedPort: false
		}, tmpInput);
	let tmpFixture = FIXTURES[tmpOptions.Fixture];
	let tmpRAFS = resolveRAFS();

	let tmpHarness = (
		{
			server: null,
			rafs: { Path: tmpRAFS.Path, Version: tmpRAFS.Version || null, Source: tmpRAFS.Source },
			port: tmpOptions.Port,
			baseURL: null,
			fixture: tmpOptions.Fixture,
			session: tmpOptions.Session,
			provider: tmpOptions.Provider,
			seed: null,
			model: null,
			principals: {},
			traps: {},
			tenancy: null,
			entitlements: null,
			faceting: null,
			options: tmpOptions,
			tempDirectory: null,
			connection: null,
			storeDatabase: null,
			_Streams: [],
			_Stopped: false
		});
	Object.defineProperty(tmpHarness, 'fable', { enumerable: true, get: () => { return tmpHarness.server ? tmpHarness.server.fable : null; } });
	Object.defineProperty(tmpHarness, 'service', { enumerable: true, get: () => { return (tmpHarness.fable && tmpHarness.fable.RetoldFacetingService) ? tmpHarness.fable.RetoldFacetingService : null; } });
	Object.defineProperty(tmpHarness, 'host', { enumerable: true, get: () => { return (tmpHarness.service && tmpHarness.service.Host) ? tmpHarness.service.Host : null; } });

	// Secrets (Login passwords) stay out of the principal objects, so a logged principal never prints one.
	let tmpSecrets = new Map();

	let tmpCalledBack = false;
	let fFinish = (pError) =>
	{
		if (tmpCalledBack)
		{
			return;
		}
		tmpCalledBack = true;
		setImmediate(() => { fDone(pError || undefined, tmpHarness); });
	};
	tmpHarness.stop = (fStopDone) => { tmpHarness._Stopped = true; return fStopDone(); };

	// ---- Validation and the gates ----
	if (!tmpRAFS.Available)
	{
		fFinish(skipError(tmpRAFS.Reason));
		return tmpHarness;
	}
	let tmpUsage = null;
	if (SESSIONS.indexOf(tmpOptions.Session) < 0)
	{
		tmpUsage = `Session must be one of ${SESSIONS.join(' | ')}`;
	}
	else if (!tmpFixture)
	{
		tmpUsage = `Fixture must be one of ${Object.keys(FIXTURES).join(' | ')}`;
	}
	else if (INSTALLERS.indexOf(tmpOptions.Installers) < 0)
	{
		tmpUsage = `Installers must be one of ${INSTALLERS.join(' | ')}`;
	}
	else if ([ PORTS.Header, PORTS.Login, SMOKE_PORT ].indexOf(tmpOptions.Port) < 0)
	{
		tmpUsage = `Port must be a registry tag (${PORTS.Header} | ${PORTS.Login}, internal-contracts §80.5; ${SMOKE_PORT} for debug/rafs-smoke.js)`;
	}
	else if ((tmpOptions.Session === 'Header') && (tmpOptions.Entitlements !== false))
	{
		// The entitlements pre-handler resolves the persona from the account id a header session lacks and
		// would overwrite UserRecord.IDUser with 0 on every request.
		tmpUsage = 'Entitlements need Session \'Login\' (a header session carries no account to enrich)';
	}
	if (tmpUsage)
	{
		throw new Error(`Facet-RAFS-Harness.start: ${tmpUsage}.`);
	}
	let tmpAvailability = libProviders.available(tmpOptions.Provider);
	if (!tmpAvailability.Available)
	{
		fFinish(skipError(`Facet-RAFS-Harness: provider [${tmpOptions.Provider}] is unavailable: ${tmpAvailability.Reason}`));
		return tmpHarness;
	}

	let libRAFS = load(tmpRAFS);
	// The meadow-endpoints RAFS itself mounts with (late mounts must be the same kind of endpoint).
	let libMeadowEndpoints = require(require.resolve('meadow-endpoints', { paths: [ tmpRAFS.Path ] }));

	// ---- The data: fixture rows + the overlay ----
	let tmpSeedModule = tmpFixture.Seed;
	let tmpSeedValue = (typeof(tmpOptions.Seed) === 'number') ? tmpOptions.Seed : tmpSeedModule.DEFAULT_SEED;
	let tmpProbes = (tmpOptions.Overlay !== false);
	let tmpIdentity = tmpProbes || (tmpOptions.Session === 'Login');
	let tmpGenerated = mergeOverlay(tmpSeedModule.generate({ Seed: tmpSeedValue, Scale: tmpOptions.Scale }), tmpOptions.Fixture, { Identity: tmpIdentity, Probes: tmpProbes });
	tmpHarness.model = tmpGenerated.Model;
	tmpHarness.traps = tmpGenerated.Traps || {};
	tmpHarness.principals = buildPrincipals(tmpGenerated);
	Object.keys(tmpHarness.principals).forEach(
		(pName) =>
		{
			tmpSecrets.set(pName, libCrypto.randomBytes(12).toString('hex'));
			// Only a Login account carries the platform marker; a header session has none.
			tmpHarness.principals[pName].Platform = tmpHarness.principals[pName].Platform && (tmpOptions.Session === 'Login');
		});
	[ 'Grants', 'Denies' ].forEach(
		(pKey) =>
		{
			Object.keys(tmpOptions[pKey] || {}).forEach(
				(pName) =>
				{
					if (!Object.prototype.hasOwnProperty.call(tmpHarness.principals, pName) || !Array.isArray(tmpOptions[pKey][pName]))
					{
						throw new Error(`Facet-RAFS-Harness.start: ${pKey} names [${pName}]: it must map a principal (${Object.keys(tmpHarness.principals).join(', ')}) to an array.`);
					}
				});
		});

	let tmpLateMounts = Array.isArray(tmpOptions.LateMounts) ? tmpOptions.LateMounts.slice() : (tmpProbes ? PROBE_LATE_MOUNTS.slice() : []);
	tmpLateMounts.forEach(
		(pTable) =>
		{
			if (!tmpHarness.model.Tables[pTable])
			{
				throw new Error(`Facet-RAFS-Harness.start: LateMounts names [${pTable}], which is not a model table.`);
			}
		});

	// ---- The RAFS app shape (§80.3) ----
	let tmpNoAutoCRUD = {};
	(tmpIdentity ? IDENTITY_NO_AUTO_CRUD : []).concat(tmpProbes ? PROBE_NO_AUTO_CRUD : [], tmpLateMounts).forEach((pTable) => { tmpNoAutoCRUD[pTable] = true; });

	let fResolveHeaderSession = (pRequest, fCallback) =>
	{
		let tmpHeaders = pRequest.headers || {};
		let tmpTenant = tmpHeaders[SESSION_HEADERS.Tenant];
		if ((typeof(tmpTenant) !== 'string') || (tmpTenant.length < 1))
		{
			return fCallback(null, {});
		}
		let tmpUser = tmpHeaders[SESSION_HEADERS.User];
		return fCallback(null, { UserRecord: { IDCustomer: parseInt(tmpTenant, 10) || 0, IDUser: parseInt(tmpUser || '0', 10) || 0 } });
	};
	let tmpTenancy = null;
	if (tmpOptions.Tenancy !== false)
	{
		tmpTenancy = Object.assign(
			{
				Column: tmpGenerated.TenantColumn,
				Exclude: tmpFixture.Global.concat(tmpProbes ? PROBE_EXCLUDED : []),
				PersonalScopes: JSON.parse(JSON.stringify(tmpFixture.PersonalScopes)),
				DeniedPrefixes: tmpProbes ? PROBE_DENIED_PREFIXES.slice() : []
			},
			(tmpOptions.Session === 'Header') ? { resolveSession: fResolveHeaderSession } : {},
			(typeof(tmpOptions.Tenancy) === 'object' && tmpOptions.Tenancy !== null) ? tmpOptions.Tenancy : {});
	}
	tmpHarness.tenancy = tmpTenancy;

	let tmpEntitlements = null;
	if (tmpOptions.Entitlements !== false)
	{
		tmpEntitlements = Object.assign(
			{
				APIPrefix: '/1.0/',
				IdentityTable: 'RFSMembership',
				IdentityAccountField: 'IDRFSAccount',
				IdentityUserField: 'IDUser',
				TenantField: tmpGenerated.TenantColumn,
				RoleTable: 'Role',
				RoleActionTable: 'RoleAction',
				UserRoleTable: 'UserRole',
				UserActionTable: 'UserAction',
				ExcludeEntities: tmpFixture.Global.slice(),
				DefaultRoles: JSON.parse(JSON.stringify(Array.isArray(tmpOptions.Roles) ? tmpOptions.Roles : DEFAULT_ROLES))
			},
			(typeof(tmpOptions.Entitlements) === 'object' && tmpOptions.Entitlements !== null) ? tmpOptions.Entitlements : {});
	}
	tmpHarness.entitlements = tmpEntitlements;

	let tmpMembership = ((tmpOptions.Session === 'Login') && (tmpOptions.Membership !== false))
		? { APIPrefix: '/1.0/', AccountTable: 'RFSAccount', AccountIDField: 'IDRFSAccount', PersonaTable: 'RFSMembership', PersonaAccountField: 'IDRFSAccount', PersonaIDField: 'IDUser', TenantField: tmpGenerated.TenantColumn }
		: null;

	let tmpFaceting = libOptions.deepMerge(
		{
			Catalog: { GlobalEntities: tmpFixture.Global.concat(tmpProbes ? PROBE_GLOBAL_ENTITIES : [], [ 'Customer' ]) },
			Definitions: { Path: false, Files: [ tmpSeedModule.DEFINITIONS_PATH ] }
		}, tmpOptions.Faceting || {});
	tmpHarness.faceting = tmpFaceting;

	// ---- The ClickHouse store (M5, CH-gated): a fresh rfs_<pid>_<n> database, the materializer backfills ----
	let tmpStoreSupport = null;
	let tmpStoreOptions = ((typeof(tmpOptions.StoreOptions) === 'object') && (tmpOptions.StoreOptions !== null)) ? tmpOptions.StoreOptions : {};
	if ((tmpOptions.Store !== null) && (typeof(tmpOptions.Store) !== 'undefined') && (tmpOptions.Store !== false))
	{
		if (tmpOptions.Store !== 'ClickHouse')
		{
			throw new Error('Facet-RAFS-Harness.start: Store must be \'ClickHouse\'.');
		}
		tmpStoreSupport = require('./Facet-ClickHouse-Support.js');
		let tmpGate = tmpStoreSupport.available();
		if (!tmpGate.Available)
		{
			fFinish(skipError(`Facet-RAFS-Harness: the ClickHouse store is unavailable: ${tmpGate.Reason}`));
			return tmpHarness;
		}
		tmpHarness.storeDatabase = tmpStoreSupport.freshDatabase();
		tmpFaceting.Stores = Object.assign({}, tmpFaceting.Stores || {}, { ClickHouse: tmpStoreSupport.storeOptions(tmpHarness.storeDatabase, tmpStoreOptions.Store || {}) });
		tmpFaceting.Materialize = tmpStoreOptions.Materialize || 'All';
		tmpFaceting.Reconcile = libOptions.deepMerge(libOptions.deepMerge({ AutoStart: false }, tmpFaceting.Reconcile || {}), tmpStoreOptions.Reconcile || {});
	}

	// ---- The temp directory (DataDirectory, ClientBundlePath; SQLite stays in memory) ----
	try
	{
		tmpHarness.tempDirectory = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'rfs-rafs-'));
	}
	catch (pTempError)
	{
		fFinish(pTempError);
		return tmpHarness;
	}

	let tmpServerOptions = (
		{
			Product: `rfs-rafs-${tmpOptions.Fixture.toLowerCase()}-${tmpOptions.Session.toLowerCase()}`,
			ProductVersion: '0.0.1',
			// 0: the OS picks a free port; _startOrator binds 127.0.0.1 and reads it back (FixedPort: the tag itself).
			APIServerPort: (tmpOptions.FixedPort === true) ? tmpOptions.Port : 0,
			DataDirectory: libPath.join(tmpHarness.tempDirectory, 'data'),
			ClientBundlePath: libPath.join(tmpHarness.tempDirectory, 'dist'),
			ParimeBinaryStorageRoot: libPath.join(tmpHarness.tempDirectory, 'blobs'),
			// A fresh object: RAFS resolves SQLiteFilePath in place, and _DEFAULT_OPTIONS.SQLite is shared.
			SQLite: { SQLiteFilePath: libPath.join(tmpHarness.tempDirectory, 'unused.sqlite') },
			DatabaseProvider: tmpOptions.Provider,
			LogStreams: [ { streamtype: 'console', level: tmpOptions.LogLevel } ]
		});
	if (tmpOptions.Session === 'Login')
	{
		tmpServerOptions.EnableAuthentication = true;
		tmpServerOptions.Auth = { Local: Object.assign({}, AUTH_LOCAL) };
	}

	/**
	 * The harness app: the fixture model + overlay, the §80.3 tenancy / entitlements / membership configs,
	 * the fixture database built before _runSchema, the identity seeds, the late mounts, and the faceting
	 * installers placed exactly where an app places them (§73.1).
	 */
	class RFSHarnessServer extends libRAFS
	{
		constructor(pServerOptions)
		{
			super(pServerOptions);
			this.MeadowModel = tmpHarness.model;
			this.NoAutoCRUDTables = tmpNoAutoCRUD;
			// In memory: RAFS's constructor path.resolve()s SQLiteFilePath (':memory:' would become a file
			// under the CWD), so the subclass sets it after super(), as the RAFS examples set their config.
			this.options.SQLite.SQLiteFilePath = ':memory:';
		}

		tenancyConfig()
		{
			return tmpTenancy;
		}

		entitlementsConfig()
		{
			return tmpEntitlements;
		}

		membershipConfig()
		{
			return tmpMembership;
		}

		preSchemaSteps()
		{
			return super.preSchemaSteps().concat([ this._rfsCreateFixtureTables.bind(this) ]);
		}

		seedSteps()
		{
			return super.seedSteps().concat([ this._rfsSeedFixtureRows.bind(this), this._rfsSeedIdentity.bind(this) ]);
		}

		hookInstallers()
		{
			let tmpSteps = super.hookInstallers();
			if (tmpOptions.Installers === 'Both')
			{
				// LAST, as an app puts it (§73.1): after every app hook.
				tmpSteps = tmpSteps.concat([ libRetoldFacetingService.foundationHookInstaller(this, tmpFaceting) ]);
			}
			return tmpSteps;
		}

		routeInstallers()
		{
			let tmpSteps = super.routeInstallers().concat([ this._rfsLateMounts.bind(this), this._rfsBeforeListen.bind(this) ]);
			if (tmpOptions.Installers !== 'None')
			{
				tmpSteps.push(libRetoldFacetingService.foundationRouteInstaller(this, tmpFaceting));
			}
			return tmpSteps;
		}

		/**
		 * The fixture's own nullable DDL, so _runSchema's CREATE TABLE IF NOT EXISTS leaves these tables alone
		 * (PostgreSQL: the database was built before boot).
		 */
		_rfsCreateFixtureTables(fStep)
		{
			if (this._DatabaseProvider !== 'SQLite')
			{
				return fStep();
			}
			try
			{
				libCommon.createTables(this.fable.MeadowSQLiteProvider.db, this.MeadowModel);
			}
			catch (pError)
			{
				return fStep(pError);
			}
			return fStep();
		}

		/**
		 * The fixture + probe rows (SQLite; PostgreSQL was loaded before boot), with the indexes and counts of
		 * the fixture build (internal-contracts §31.6).
		 */
		_rfsSeedFixtureRows(fStep)
		{
			if (this._DatabaseProvider !== 'SQLite')
			{
				return fStep();
			}
			try
			{
				tmpHarness.seed = libCommon.buildFromGenerated(this.fable.MeadowSQLiteProvider.db, tmpGenerated);
			}
			catch (pError)
			{
				return fStep(pError);
			}
			return fStep();
		}

		/**
		 * Login mode: accounts (AuthLocal.ensureUser), memberships (DAL), roles per tenant and grants
		 * (Entitlements.provisionDefaultRoles / grantRole), UserAction denies (DAL).
		 */
		_rfsSeedIdentity(fStep)
		{
			if (tmpOptions.Session !== 'Login')
			{
				return fStep();
			}
			let libAuthLocal = this.constructor.AuthLocal;
			let libEntitlements = this.constructor.Entitlements;
			let tmpAnticipate = this.fable.newAnticipate();
			let tmpRoleMaps = {};
			if (tmpEntitlements)
			{
				tmpGenerated.Tenants.forEach(
					(pTenant) =>
					{
						tmpAnticipate.anticipate(
							(fNext) =>
							{
								libEntitlements.provisionDefaultRoles(this, tmpEntitlements, pTenant,
									(pError, pRoleMap) =>
									{
										tmpRoleMaps[pTenant] = pRoleMap || {};
										return fNext(pError || undefined);
									});
							});
					});
			}
			Object.keys(tmpHarness.principals).forEach(
				(pName) =>
				{
					let tmpPrincipal = tmpHarness.principals[pName];
					let tmpAccount = null;
					tmpAnticipate.anticipate(
						(fNext) =>
						{
							let tmpRecord = { LoginID: tmpPrincipal.LoginID, Password: tmpSecrets.get(pName), DisplayName: pName, ShortName: pName.substring(0, 2).toUpperCase() };
							if (tmpPrincipal.Platform)
							{
								tmpRecord[SYSTEM_ADMIN_FIELD] = SYSTEM_ADMIN_VALUE;
							}
							libAuthLocal.ensureUser(this, AUTH_LOCAL, tmpRecord,
								(pError, pAccount) =>
								{
									if (!pError && (!pAccount || !pAccount[AUTH_LOCAL.IDField]))
									{
										pError = new Error(`Facet-RAFS-Harness: the account of [${pName}] was not created.`);
									}
									tmpAccount = pAccount;
									tmpPrincipal.IDRFSAccount = pAccount ? pAccount[AUTH_LOCAL.IDField] : 0;
									return fNext(pError || undefined);
								});
						});
					tmpPrincipal.Memberships.forEach(
						(pMembership) =>
						{
							tmpAnticipate.anticipate(
								(fNext) =>
								{
									let tmpDAL = this.DAL.RFSMembership;
									let tmpQuery = tmpDAL.query.clone().addRecord({ IDRFSAccount: tmpAccount[AUTH_LOCAL.IDField], IDUser: pMembership.User, IDCustomer: pMembership.Tenant, DisplayName: pName, Role: 'Member', Active: 1 });
									tmpDAL.doCreate(tmpQuery, (pError) => { return fNext(pError || undefined); });
								});
							if (!tmpEntitlements)
							{
								return;
							}
							let tmpGrants = Object.prototype.hasOwnProperty.call(tmpOptions.Grants || {}, pName) ? tmpOptions.Grants[pName] : (DEFAULT_GRANTS[pName] || [ 'reader' ]);
							tmpGrants.forEach(
								(pRoleKey) =>
								{
									tmpAnticipate.anticipate(
										(fNext) =>
										{
											let tmpIDRole = (tmpRoleMaps[pMembership.Tenant] || {})[pRoleKey];
											if (!tmpIDRole)
											{
												return fNext(new Error(`Facet-RAFS-Harness: no role [${pRoleKey}] in tenant ${pMembership.Tenant} for [${pName}].`));
											}
											libEntitlements.grantRole(this, tmpEntitlements, pMembership.User, tmpIDRole, pMembership.Tenant, (pError) => { return fNext(pError || undefined); });
										});
								});
							((tmpOptions.Denies || {})[pName] || []).forEach(
								(pAction) =>
								{
									tmpAnticipate.anticipate(
										(fNext) =>
										{
											let tmpDAL = this.DAL[tmpEntitlements.UserActionTable];
											let tmpQuery = tmpDAL.query.clone().addRecord({ IDUser: pMembership.User, ActionKey: pAction, Effect: 'deny', IDCustomer: pMembership.Tenant });
											tmpDAL.doCreate(tmpQuery, (pError) => { return fNext(pError || undefined); });
										});
								});
						});
				});
			tmpAnticipate.wait((pError) => { return fStep(pError || undefined); });
		}

		/**
		 * Register endpoints after tenancy (late mounts, §75.2): exactly what _loadMeadowEndpoints does, from
		 * an app route installer.
		 */
		_rfsLateMounts(fStep)
		{
			try
			{
				tmpLateMounts.forEach(
					(pTable) =>
					{
						let tmpEndpoints = libMeadowEndpoints.new(this.DAL[pTable]);
						tmpEndpoints.connectRoutes(this.fable.OratorServiceServer);
						this.Endpoints[pTable] = tmpEndpoints;
					});
			}
			catch (pError)
			{
				return fStep(pError);
			}
			return fStep();
		}

		_rfsBeforeListen(fStep)
		{
			let fHook = tmpOptions.BeforeListen;
			if (typeof(fHook) !== 'function')
			{
				return fStep();
			}
			if (fHook.length >= 2)
			{
				return fHook(tmpHarness, (pError) => { return fStep(pError || undefined); });
			}
			try
			{
				fHook(tmpHarness);
			}
			catch (pError)
			{
				return fStep(pError);
			}
			return fStep();
		}

		/**
		 * Listen on 127.0.0.1 only (Orator has no host option) on the ephemeral port, and read it back.
		 */
		_startOrator(fStep)
		{
			let tmpServiceServer = this.fable.OratorServiceServer;
			if (tmpServiceServer && tmpServiceServer.server && (typeof(tmpServiceServer.server.listen) === 'function'))
			{
				tmpServiceServer.listen = function (pPort, fCallback)
				{
					this.server.listen(pPort, '127.0.0.1',
						(pError) =>
						{
							this.Active = true;
							this.Port = this.server.address() ? this.server.address().port : pPort;
							return fCallback(pError);
						});
				};
			}
			return super._startOrator(
				(pError) =>
				{
					let tmpAddress = (tmpServiceServer && tmpServiceServer.server && (typeof(tmpServiceServer.server.address) === 'function')) ? tmpServiceServer.server.address() : null;
					if (tmpAddress && (typeof(tmpAddress.port) === 'number'))
					{
						tmpHarness.port = tmpAddress.port;
						tmpHarness.baseURL = `http://127.0.0.1:${tmpAddress.port}`;
					}
					return fStep(pError || undefined);
				});
		}
	}

	// ---- Helpers ----

	/**
	 * A principal by name (null for anonymous).
	 *
	 * @param {any} pName
	 * @return {Record<string, any>|null}
	 */
	let fPrincipal = (pName) =>
	{
		if ((pName === null) || (typeof(pName) === 'undefined') || (pName === 'Anonymous'))
		{
			return null;
		}
		if ((typeof(pName) !== 'string') || !Object.prototype.hasOwnProperty.call(tmpHarness.principals, pName))
		{
			throw new Error(`Facet-RAFS-Harness: unknown principal [${pName}] (${Object.keys(tmpHarness.principals).join(', ')}, or null for anonymous).`);
		}
		return tmpHarness.principals[pName];
	};

	/**
	 * The principal name of a helper's "as" argument: a name, null, or { As }.
	 *
	 * @param {any} pAs
	 * @return {string|null}
	 */
	let fAsName = (pAs) =>
	{
		if ((typeof(pAs) === 'object') && (pAs !== null))
		{
			return (typeof(pAs.As) === 'string') ? pAs.As : null;
		}
		return (typeof(pAs) === 'string') ? pAs : null;
	};

	/**
	 * The identity headers of a principal (Header: the session headers; Login: its session cookie).
	 *
	 * @param {any} pAs
	 * @return {Record<string, string>}
	 */
	let fIdentityHeaders = (pAs) =>
	{
		let tmpHeaders = ((typeof(pAs) === 'object') && (pAs !== null) && (typeof(pAs.Headers) === 'object') && (pAs.Headers !== null)) ? Object.assign({}, pAs.Headers) : {};
		let tmpPrincipal = fPrincipal(fAsName(pAs));
		if (!tmpPrincipal)
		{
			return tmpHeaders;
		}
		if (tmpOptions.Session === 'Header')
		{
			tmpHeaders[SESSION_HEADERS.Tenant] = String(tmpPrincipal.Tenant);
			tmpHeaders[SESSION_HEADERS.User] = String(tmpPrincipal.User);
		}
		else if (tmpPrincipal.Cookie)
		{
			tmpHeaders.cookie = tmpPrincipal.Cookie;
		}
		return tmpHeaders;
	};

	/**
	 * { Tenant, User } of a principal (its current tenant: a switch moves it).
	 *
	 * @param {string} pName
	 * @return {{ Tenant: number, User: number }}
	 */
	tmpHarness.as = (pName) =>
	{
		let tmpPrincipal = fPrincipal(pName);
		if (!tmpPrincipal)
		{
			throw new Error('Facet-RAFS-Harness.as needs a principal name.');
		}
		return { Tenant: tmpPrincipal.Tenant, User: tmpPrincipal.User };
	};

	/**
	 * The session the tenancy guard sees for a principal, for in-process calls: Header mode builds what the
	 * resolver builds; Login mode returns the principal's live orator-authentication session (looked up
	 * through its public getSessionForRequest), so enrichment and switches show exactly as on HTTP.
	 * Anonymous → {} (what the tenancy pre-handler sets).
	 *
	 * @param {any} pName
	 * @return {Record<string, any>}
	 */
	tmpHarness.sessionFor = (pName) =>
	{
		let tmpPrincipal = fPrincipal(pName);
		if (!tmpPrincipal)
		{
			return {};
		}
		if (tmpOptions.Session === 'Header')
		{
			return { UserRecord: { IDCustomer: tmpPrincipal.Tenant, IDUser: tmpPrincipal.User } };
		}
		let tmpAuthentication = tmpHarness.fable ? tmpHarness.fable.OratorAuthentication : null;
		if (!tmpPrincipal.Cookie || !tmpAuthentication)
		{
			return {};
		}
		return tmpAuthentication.getSessionForRequest({ headers: { cookie: tmpPrincipal.Cookie } }) || {};
	};

	/**
	 * HTTP as a principal.
	 *
	 * @param {string} pMethod
	 * @param {string} pPath - starts with '/'
	 * @param {any} pBody
	 * @param {any} pAs - a principal name, null (anonymous), or { As?, Headers? }
	 * @param {(pError?: Error, pResponse?: Record<string, any>) => void} fCallback
	 */
	tmpHarness.request = (pMethod, pPath, pBody, pAs, fCallback) =>
	{
		if (!tmpHarness.baseURL)
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness: the server is not listening.')); });
		}
		let tmpHeaders;
		try
		{
			tmpHeaders = fIdentityHeaders(pAs);
		}
		catch (pError)
		{
			return setImmediate(() => { fCallback(pError); });
		}
		return httpRequest(`${tmpHarness.baseURL}${pPath}`, pMethod, pBody, tmpHeaders, fCallback);
	};

	let fRoutePrefix = () =>
	{
		return (tmpHarness.service && tmpHarness.service.options && tmpHarness.service.options.RoutePrefix) ? tmpHarness.service.options.RoutePrefix : (tmpFaceting.RoutePrefix || libOptions.DEFAULTS.RoutePrefix);
	};

	/**
	 * POST <RoutePrefix>/<Entity>/Query as a principal.
	 */
	tmpHarness.facet = (pEntity, pBody, pAs, fCallback) =>
	{
		return tmpHarness.request('POST', `${fRoutePrefix()}/${pEntity}/Query`, pBody, pAs, fCallback);
	};

	/**
	 * GET <RoutePrefix>/Describe[/<Entity>] as a principal.
	 */
	tmpHarness.describe = (pEntity, pAs, fCallback) =>
	{
		let tmpPath = ((typeof(pEntity) === 'string') && (pEntity.length > 0)) ? `${fRoutePrefix()}/Describe/${pEntity}` : `${fRoutePrefix()}/Describe`;
		return tmpHarness.request('GET', tmpPath, null, pAs, fCallback);
	};

	/**
	 * POST <RoutePrefix>/<Entity>/Keys and /Records (the isolation oracle reads them).
	 */
	tmpHarness.keys = (pEntity, pBody, pAs, fCallback) =>
	{
		return tmpHarness.request('POST', `${fRoutePrefix()}/${pEntity}/Keys`, pBody || {}, pAs, fCallback);
	};
	tmpHarness.records = (pEntity, pBody, pAs, fCallback) =>
	{
		return tmpHarness.request('POST', `${fRoutePrefix()}/${pEntity}/Records`, pBody || {}, pAs, fCallback);
	};

	/**
	 * In-process options (internal-contracts §19.5): Now, PlanForm, plus a base.
	 */
	let fInternal = (pOptions, pBase) =>
	{
		let tmpInternal = Object.assign({}, pBase || {});
		let tmpRequestOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		if ((typeof(tmpRequestOptions.Now) === 'string') || (typeof(tmpRequestOptions.Now) === 'number'))
		{
			tmpInternal.Now = tmpRequestOptions.Now;
		}
		if ((typeof(tmpRequestOptions.PlanForm) === 'object') && (tmpRequestOptions.PlanForm !== null))
		{
			tmpInternal.PlanForm = Object.assign({}, tmpRequestOptions.PlanForm);
		}
		return tmpInternal;
	};

	let fInProcess = (pEntity, pBody, pOptions, pInternal, fCallback) =>
	{
		if (!tmpHarness.service)
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness: the faceting service is not attached.')); });
		}
		let tmpRequest = { params: { Entity: pEntity }, headers: {}, query: {}, body: pBody, UserSession: tmpHarness.sessionFor(fAsName(pOptions)) };
		return tmpHarness.service.queryInternal(pEntity, pBody, tmpRequest, pInternal,
			(pError, pEnvelope, pMeta) =>
			{
				setImmediate(() => { fCallback(pError, pEnvelope, pMeta); });
			});
	};

	/**
	 * The request through the Live engine, in-process, as { As } with pOptions.Now / PlanForm.
	 */
	tmpHarness.query = (pEntity, pBody, pOptions, fCallback) =>
	{
		return fInProcess(pEntity, pBody, pOptions, fInternal(pOptions), fCallback);
	};

	/**
	 * The same through the Reference engine.
	 */
	tmpHarness.reference = (pEntity, pBody, pOptions, fCallback) =>
	{
		return fInProcess(pEntity, pBody, pOptions, fInternal(pOptions, { ForceEngine: 'Reference' }), fCallback);
	};

	/**
	 * Live over HTTP and the Reference in-process, the same principal (and the Reference's pinned Now when
	 * given), normalized for deep-equal (O1).
	 */
	tmpHarness.compare = (pEntity, pBody, pOptions, fCallback) =>
	{
		tmpHarness.facet(pEntity, pBody, fAsName(pOptions),
			(pLiveError, pLiveResponse) =>
			{
				if (pLiveError)
				{
					return fCallback(pLiveError);
				}
				tmpHarness.reference(pEntity, pBody, pOptions,
					(pReferenceError, pReferenceEnvelope) =>
					{
						if (pReferenceError)
						{
							return fCallback(pReferenceError);
						}
						return fCallback(null,
							{
								Live: pLiveResponse,
								Reference: pReferenceEnvelope,
								LiveNormalized: libFacetEnvelope.normalizeForComparison(pLiveResponse.JSON),
								ReferenceNormalized: libFacetEnvelope.normalizeForComparison(pReferenceEnvelope)
							});
					});
			});
	};

	/**
	 * The stock RAFS Count route as a principal: GET /1.0/<E>s/Count[/FilteredTo/<filter>] (pFilterString
	 * RAW; encoded once here).
	 */
	tmpHarness.listCount = (pEntity, pFilterString, pAs, fCallback) =>
	{
		let tmpPath = ((typeof(pFilterString) === 'string') && (pFilterString.length > 0))
			? `/1.0/${pEntity}s/Count/FilteredTo/${encodeURIComponent(pFilterString)}`
			: `/1.0/${pEntity}s/Count`;
		tmpHarness.request('GET', tmpPath, null, pAs,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if ((pResponse.Status !== 200) || !pResponse.JSON || (typeof(pResponse.JSON.Count) !== 'number'))
				{
					let tmpError = new Error(`List count failed: ${pResponse.Status} ${pResponse.Text}`);
					tmpError.Response = pResponse;
					return fCallback(tmpError);
				}
				return fCallback(null, pResponse.JSON.Count);
			});
	};

	/**
	 * The seeded rows of a table the principal's RAFS list shows: soft delete, the tenancy column where
	 * RAFS installed tenancy (mounted at _mountTenancy, not excluded), and the personal scope.
	 *
	 * @param {string} pTable
	 * @param {string} pName
	 * @return {Array<Record<string, any>>}
	 */
	tmpHarness.visibleRows = (pTable, pName) =>
	{
		let tmpPrincipal = fPrincipal(pName) || { Tenant: 0, User: 0 };
		let tmpTable = tmpHarness.model.Tables[pTable];
		if (!tmpTable)
		{
			return [];
		}
		let fHas = (pColumn) => { return tmpTable.Columns.some((pEntry) => { return pEntry.Column === pColumn; }); };
		let tmpGuarded = !!tmpTenancy && !tmpNoAutoCRUD[pTable] && ((tmpTenancy.Exclude || []).indexOf(pTable) < 0);
		let tmpPersonal = (tmpGuarded && tmpTenancy.PersonalScopes && tmpTenancy.PersonalScopes[pTable]) ? tmpTenancy.PersonalScopes[pTable] : null;
		return (tmpGenerated.Rows[pTable] || []).filter(
			(pRow) =>
			{
				if (fHas('Deleted') && (pRow.Deleted !== 0))
				{
					return false;
				}
				if (tmpGuarded && fHas(tmpTenancy.Column) && (pRow[tmpTenancy.Column] !== tmpPrincipal.Tenant))
				{
					return false;
				}
				if (tmpPersonal && (pRow[tmpPersonal.Column] !== tmpPrincipal.User))
				{
					return false;
				}
				return true;
			});
	};

	/**
	 * The entity + field a Terms facet's keys come from (a root column, or the last step of its Path).
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
		let tmpMatch = /^([<>=])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(pFacet.Path[pFacet.Path.length - 1]));
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
	 * Two-tenant isolation (internal-contracts §32.1, O6) on RAFS: per principal, Live (HTTP) == Reference;
	 * every Terms bucket key is a value of a row that principal's RAFS list shows; a resolved label never comes
	 * from a row it cannot see; every Keys key and every first-page record is a visible row, and the Keys
	 * Count equals the envelope Total.  pOptions { Keys: false } skips the Keys / Records part.  pNames
	 * defaults to the fixture's principals.
	 */
	tmpHarness.assertTenantIsolation = (pEntity, pBody, pNames, pOptions, fCallback) =>
	{
		if (typeof(pOptions) === 'function')
		{
			fCallback = pOptions;
			pOptions = {};
		}
		let tmpCheckKeys = !(pOptions && (pOptions.Keys === false));
		let tmpReport = { Checked: 0, Skipped: 0, Principals: {}, Mismatches: [] };
		let tmpNames = Array.isArray(pNames) ? pNames.slice() : Object.keys(tmpHarness.principals).filter((pName) => { return tmpHarness.principals[pName].Kind === 'Fixture'; });
		let fPK = (pTable) => { return libBookstoreSeed.primaryKeyOf(tmpHarness.model, pTable); };
		let fMismatch = (pName, pMismatch) =>
		{
			tmpReport.Checked++;
			tmpReport.Mismatches.push(Object.assign({ Principal: pName }, pMismatch));
		};
		let fNextPrincipal = (pIndex) =>
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
			tmpReport.Principals[tmpName] = { Total: null, Buckets: 0, Keys: 0 };
			tmpHarness.compare(pEntity, pBody, { As: tmpName },
				(pCompareError, pCompared) =>
				{
					if (pCompareError)
					{
						return fCallback(pCompareError, tmpReport);
					}
					tmpReport.Checked++;
					if (pCompared.Live.Status !== 200)
					{
						fMismatch(tmpName, { Check: 'LiveStatus', Expected: 200, Actual: pCompared.Live.Status, Body: pCompared.Live.JSON });
						return fNextPrincipal(pIndex + 1);
					}
					if (JSON.stringify(pCompared.LiveNormalized) !== JSON.stringify(pCompared.ReferenceNormalized))
					{
						fMismatch(tmpName, { Check: 'LiveEqualsReference', Expected: 'equal envelopes', Actual: 'different' });
					}
					let tmpEnvelope = pCompared.Live.JSON;
					tmpReport.Principals[tmpName].Total = tmpEnvelope.Total;
					Object.keys(tmpEnvelope.Facets || {}).forEach(
						(pFacetKey) =>
						{
							let tmpFacet = tmpEnvelope.Facets[pFacetKey];
							if (!tmpFacet || (tmpFacet.Fold !== 'Terms') || !Array.isArray(tmpFacet.Buckets))
							{
								return;
							}
							let tmpSource = fKeySource(pEntity, tmpFacet);
							if (!tmpSource || !tmpHarness.model.Tables[tmpSource.Entity])
							{
								tmpReport.Skipped++;
								return;
							}
							let tmpVisible = new Set(tmpHarness.visibleRows(tmpSource.Entity, tmpName).map((pRow) => { return JSON.stringify(libFacetEnvelope.normalizeKey(pRow[tmpSource.Field], (typeof(pRow[tmpSource.Field]) === 'number') ? 'Numeric' : 'String')); }));
							let tmpColumn = tmpHarness.fable.RetoldFacetingCatalog.column(tmpSource.Entity, tmpSource.Field);
							let tmpLabelTarget = (tmpColumn && tmpColumn.JoinTarget) ? tmpColumn.JoinTarget : ((tmpColumn && tmpColumn.IsPK) ? tmpSource.Entity : null);
							tmpFacet.Buckets.forEach(
								(pBucket) =>
								{
									if (!pBucket || !(pBucket.Count > 0))
									{
										return;
									}
									tmpReport.Principals[tmpName].Buckets++;
									tmpReport.Checked++;
									if (!tmpVisible.has(JSON.stringify(pBucket.Key)))
									{
										fMismatch(tmpName, { Facet: pFacetKey, Check: 'BucketKeyVisible', Key: pBucket.Key, Entity: tmpSource.Entity, Field: tmpSource.Field });
									}
									if ((pBucket.LabelResolved === true) && tmpLabelTarget)
									{
										let tmpTargetPK = fPK(tmpLabelTarget);
										tmpReport.Checked++;
										if (!tmpHarness.visibleRows(tmpLabelTarget, tmpName).some((pRow) => { return pRow[tmpTargetPK] === pBucket.Key; }))
										{
											fMismatch(tmpName, { Facet: pFacetKey, Check: 'LabelFromVisibleRow', Key: pBucket.Key, Entity: tmpLabelTarget });
										}
									}
								});
						});
					if (!tmpCheckKeys)
					{
						return fNextPrincipal(pIndex + 1);
					}
					let tmpKeysBody = Object.assign({}, pBody || {});
					delete tmpKeysBody.Facets;
					delete tmpKeysBody.Records;
					delete tmpKeysBody.Total;
					tmpHarness.keys(pEntity, tmpKeysBody, tmpName,
						(pKeysError, pKeysResponse) =>
						{
							if (pKeysError)
							{
								return fCallback(pKeysError, tmpReport);
							}
							tmpReport.Checked++;
							if ((pKeysResponse.Status !== 200) || !pKeysResponse.JSON || !Array.isArray(pKeysResponse.JSON.Keys))
							{
								fMismatch(tmpName, { Check: 'KeysStatus', Expected: 200, Actual: pKeysResponse.Status });
								return fNextPrincipal(pIndex + 1);
							}
							let tmpPK = fPK(pEntity);
							let tmpVisibleKeys = new Set(tmpHarness.visibleRows(pEntity, tmpName).map((pRow) => { return pRow[tmpPK]; }));
							pKeysResponse.JSON.Keys.forEach(
								(pKey) =>
								{
									tmpReport.Principals[tmpName].Keys++;
									tmpReport.Checked++;
									if (!tmpVisibleKeys.has(pKey))
									{
										fMismatch(tmpName, { Check: 'KeyVisible', Key: pKey, Entity: pEntity });
									}
								});
							if ((typeof(tmpEnvelope.Total) === 'number') && (pKeysResponse.JSON.Truncated !== true))
							{
								tmpReport.Checked++;
								if (pKeysResponse.JSON.Count !== tmpEnvelope.Total)
								{
									fMismatch(tmpName, { Check: 'KeysCountEqualsTotal', Expected: tmpEnvelope.Total, Actual: pKeysResponse.JSON.Count });
								}
							}
							tmpHarness.records(pEntity, Object.assign({}, tmpKeysBody, { Records: { Begin: 0, Cap: 50 } }), tmpName,
								(pRecordsError, pRecordsResponse) =>
								{
									if (pRecordsError)
									{
										return fCallback(pRecordsError, tmpReport);
									}
									tmpReport.Checked++;
									if ((pRecordsResponse.Status !== 200) || !Array.isArray(pRecordsResponse.JSON))
									{
										fMismatch(tmpName, { Check: 'RecordsStatus', Expected: 200, Actual: pRecordsResponse.Status });
										return fNextPrincipal(pIndex + 1);
									}
									pRecordsResponse.JSON.forEach(
										(pRecord) =>
										{
											tmpReport.Checked++;
											if (!pRecord || !tmpVisibleKeys.has(pRecord[tmpPK]))
											{
												fMismatch(tmpName, { Check: 'RecordVisible', Key: pRecord ? pRecord[tmpPK] : null, Entity: pEntity });
											}
										});
									return fNextPrincipal(pIndex + 1);
								});
						});
				});
		};
		return fNextPrincipal(0);
	};

	// ---- O2, Records, SSE and the store: the end-to-end suites (internal-contracts §80.4) ----

	/**
	 * The fenced, RAW meadow-filter string of a body's Clauses + FilterString (the list oracle's input);
	 * throws when the body holds a conjunct the list syntax cannot carry (a join, a named scope).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @return {string}
	 */
	tmpHarness.toFilterString = (pEntity, pBody) =>
	{
		let tmpBody = pBody || {};
		let tmpFilterAST = tmpHarness.fable.RetoldFacetingFilterAST.build(pEntity, { Clauses: tmpBody.Clauses || [], FilterString: tmpBody.FilterString || null });
		return tmpHarness.fable.RetoldFacetingFilterAST.toFilterString(tmpFilterAST.Conjuncts);
	};

	/**
	 * GET /1.0/<E>s[/FilteredTo/<filter>]/0/0 as a principal: every row its stock RAFS list returns
	 * (pFilterString RAW; encoded once here).
	 *
	 * @param {string} pEntity
	 * @param {string|null} pFilterString
	 * @param {any} pAs
	 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	tmpHarness.listRows = (pEntity, pFilterString, pAs, fCallback) =>
	{
		let tmpPath = ((typeof(pFilterString) === 'string') && (pFilterString.length > 0))
			? `/1.0/${pEntity}s/FilteredTo/${encodeURIComponent(pFilterString)}/0/0`
			: `/1.0/${pEntity}s/0/0`;
		tmpHarness.request('GET', tmpPath, null, pAs,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if ((pResponse.Status !== 200) || !Array.isArray(pResponse.JSON))
				{
					let tmpError = new Error(`List read failed: ${pResponse.Status} ${pResponse.Text}`);
					tmpError.Response = pResponse;
					return fCallback(tmpError);
				}
				return fCallback(null, pResponse.JSON);
			});
	};

	/**
	 * Every record of POST <RoutePrefix>/<E>/Records for a body's filter, page by page (MaxRecordsPage).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody - filter inputs (Facets / Records / Total are ignored)
	 * @param {any} pAs
	 * @param {(pError?: Error, pRecords?: Array<Record<string, any>>) => void} fCallback
	 */
	tmpHarness.allRecords = (pEntity, pBody, pAs, fCallback) =>
	{
		let tmpPage = 500;
		let tmpRecords = [];
		let tmpFilterBody = Object.assign({}, pBody || {});
		delete tmpFilterBody.Facets;
		delete tmpFilterBody.Total;
		let fPage = (pBegin) =>
		{
			tmpHarness.records(pEntity, Object.assign({}, tmpFilterBody, { Records: Object.assign({}, (pBody && pBody.Records && Array.isArray(pBody.Records.Sort)) ? { Sort: pBody.Records.Sort } : {}, { Begin: pBegin, Cap: tmpPage }) }), pAs,
				(pError, pResponse) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					if ((pResponse.Status !== 200) || !Array.isArray(pResponse.JSON))
					{
						let tmpError = new Error(`Records failed: ${pResponse.Status} ${pResponse.Text}`);
						tmpError.Response = pResponse;
						return fCallback(tmpError);
					}
					tmpRecords = tmpRecords.concat(pResponse.JSON);
					if (pResponse.JSON.length < tmpPage)
					{
						return fCallback(null, tmpRecords);
					}
					return fPage(pBegin + tmpPage);
				});
		};
		return fPage(0);
	};

	/**
	 * Records == the stock list: every Facet Records row of the body's filter equals (whole row, by
	 * primary key) the row the principal's RAFS list returns for the same filter (the body must be
	 * list-expressible: column clauses / a FilterString).  Calls back (Error, Report) on any mismatch.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {any} pAs
	 * @param {(pError?: Error, pReport?: { Records: number, Listed: number }) => void} fCallback
	 */
	tmpHarness.assertRecordsMatchList = (pEntity, pBody, pAs, fCallback) =>
	{
		let tmpFilter;
		try
		{
			tmpFilter = tmpHarness.toFilterString(pEntity, pBody);
		}
		catch (pFilterError)
		{
			return setImmediate(() => { fCallback(pFilterError); });
		}
		let tmpPK = libBookstoreSeed.primaryKeyOf(tmpHarness.model, pEntity);
		let fByKey = (pRows) =>
		{
			let tmpMap = {};
			pRows.forEach((pRow) => { tmpMap[String(pRow[tmpPK])] = pRow; });
			return tmpMap;
		};
		tmpHarness.allRecords(pEntity, pBody, pAs,
			(pRecordsError, pRecords) =>
			{
				if (pRecordsError)
				{
					return fCallback(pRecordsError);
				}
				tmpHarness.listRows(pEntity, tmpFilter, pAs,
					(pListError, pRows) =>
					{
						if (pListError)
						{
							return fCallback(pListError);
						}
						let tmpReport = { Records: pRecords.length, Listed: pRows.length, Filter: tmpFilter, Mismatches: [] };
						let tmpRecords = fByKey(pRecords);
						let tmpListed = fByKey(pRows);
						if (Object.keys(tmpRecords).length !== pRecords.length)
						{
							tmpReport.Mismatches.push({ Check: 'DuplicateRecord' });
						}
						Object.keys(tmpListed).forEach(
							(pKey) =>
							{
								if (!Object.prototype.hasOwnProperty.call(tmpRecords, pKey))
								{
									tmpReport.Mismatches.push({ Check: 'MissingRecord', Key: pKey });
								}
								else if (JSON.stringify(tmpRecords[pKey]) !== JSON.stringify(tmpListed[pKey]))
								{
									tmpReport.Mismatches.push({ Check: 'RowDiffers', Key: pKey });
								}
							});
						Object.keys(tmpRecords).forEach(
							(pKey) =>
							{
								if (!Object.prototype.hasOwnProperty.call(tmpListed, pKey))
								{
									tmpReport.Mismatches.push({ Check: 'ExtraRecord', Key: pKey });
								}
							});
						if (tmpReport.Mismatches.length > 0)
						{
							let tmpError = new Error(`Records != list (${pEntity}, ${tmpFilter || 'no filter'}): ${JSON.stringify(tmpReport.Mismatches.slice(0, 5))}`);
							tmpError.Report = tmpReport;
							return fCallback(tmpError, tmpReport);
						}
						return fCallback(null, tmpReport);
					});
			});
	};

	/**
	 * O2 on RAFS (internal-contracts §10.7, §32.1), checked against the REQUEST: the exclusion derived from
	 * the request equals FacetResult.Excluded; then, for every selectable bucket with a Count (and a sample
	 * of zero buckets), replacing the facet's excluded conjuncts with the Bucket.Clause and counting equals
	 * Bucket.Count; each facet Total and the envelope Total are counted the same way.
	 *
	 * Counting (pOptions.CountVia): 'List' — the stock RAFS Count route (GET /1.0/<E>s/Count/FilteredTo/…) as
	 * the same principal; 'Reference' — the in-process Reference envelope of the modified BODY (Scopes kept,
	 * one probe facet with Exclude 'None') as the same session and pinned Now: the entity's own route-bound
	 * list waterfall (Reads-QueryConfiguration with RAFS's tenancy guards → doReads), for bodies the list
	 * syntax cannot carry; 'Auto' (default) — the list unless the body has Scopes, a NamedScope / join
	 * clause, or the envelope a declared facet (its definition Where).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {Record<string, any>} pEnvelope
	 * @param {{ As?: string, Now?: string, CountVia?: string, MaxBuckets?: number, ZeroSample?: number }} pOptions
	 * @param {(pError?: Error, pReport?: Record<string, any>) => void} fCallback
	 */
	tmpHarness.assertSelectionRoundTrip = (pEntity, pBody, pEnvelope, pOptions, fCallback) =>
	{
		let tmpOptions = pOptions || {};
		let tmpAs = fAsName(tmpOptions);
		let tmpCountVia = tmpOptions.CountVia || 'Auto';
		if (tmpCountVia === 'Auto')
		{
			tmpCountVia = libFacetTestHarness.needsReferenceCount(pBody, pEnvelope) ? 'Reference' : 'List';
		}
		let tmpMaxBuckets = (typeof(tmpOptions.MaxBuckets) === 'number') ? tmpOptions.MaxBuckets : Infinity;
		let tmpZeroSample = (typeof(tmpOptions.ZeroSample) === 'number') ? tmpOptions.ZeroSample : 2;
		let tmpReport = { Checked: 0, Skipped: 0, CountVia: tmpCountVia, Mismatches: [] };
		let tmpBody = pBody || {};
		if (!pEnvelope || (typeof(pEnvelope) !== 'object') || (typeof(pEnvelope.Facets) !== 'object') || ((tmpCountVia !== 'List') && (tmpCountVia !== 'Reference')))
		{
			return setImmediate(() => { fCallback(new Error(`assertSelectionRoundTrip needs a facet envelope and CountVia List | Reference (got ${tmpCountVia}).`), tmpReport); });
		}
		let tmpFilterAST = tmpHarness.fable.RetoldFacetingFilterAST;
		let tmpClauseCompiler = tmpHarness.fable.RetoldFacetingClauseCompiler;
		let tmpClauses = Array.isArray(tmpBody.Clauses) ? tmpBody.Clauses : [];
		let tmpSimpleClauses = !tmpClauses.some((pClause) => { return !pClause || pClause.GUIDGroup || (pClause.Junction === 'OR') || (pClause.Enabled === false); });
		let tmpSpecList = Array.isArray(tmpBody.Facets) ? tmpBody.Facets : [];
		let tmpSpecs = {};
		tmpSpecList.forEach(
			(pSpec) =>
			{
				let tmpKey = (typeof(pSpec.Key) === 'string') ? pSpec.Key : (Array.isArray(pSpec.Facet) ? pSpec.Facet.join('|') : pSpec.Facet);
				tmpSpecs[tmpKey] = pSpec;
			});
		let fMismatch = (pMismatch) =>
		{
			tmpReport.Checked++;
			tmpReport.Mismatches.push(pMismatch);
		};

		// List mode works on conjuncts (rendered to a filter string); Reference mode on clauses (a body).
		let tmpConjuncts = null;
		if (tmpCountVia === 'List')
		{
			try
			{
				tmpConjuncts = tmpFilterAST.build(pEntity, { Clauses: tmpClauses, FilterString: tmpBody.FilterString || null }).Conjuncts;
			}
			catch (pBuildError)
			{
				return setImmediate(() => { fCallback(pBuildError, tmpReport); });
			}
		}
		let fKeptConjuncts = (pExcluded) =>
		{
			return tmpConjuncts.filter(
				(pConjunct) =>
				{
					let tmpHash = (pConjunct.Origin && pConjunct.Origin.Hash) ? pConjunct.Origin.Hash : null;
					return !((tmpHash && (pExcluded.indexOf(tmpHash) >= 0)) || (pExcluded.indexOf(pConjunct.Id) >= 0));
				});
		};
		let fKeptClauses = (pExcluded) =>
		{
			let tmpRemove = new Set();
			for (let i = 0; i < pExcluded.length; i++)
			{
				let tmpIndex = tmpClauses.findIndex((pClause) => { return pClause && (pClause.Hash === pExcluded[i]); });
				if (tmpIndex < 0)
				{
					let tmpMatch = /^c([0-9]+)$/.exec(String(pExcluded[i]));
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

		// The work list: [ { Facet, Check, Key?, Expected, Filter | Body } ]
		let tmpChecks = [];
		try
		{
			if (typeof(pEnvelope.Total) === 'number')
			{
				tmpChecks.push((tmpCountVia === 'List')
					? { Facet: '#Envelope', Check: 'EnvelopeTotal', Expected: pEnvelope.Total, Filter: tmpFilterAST.toFilterString(tmpConjuncts) }
					: { Facet: '#Envelope', Check: 'EnvelopeTotal', Expected: pEnvelope.Total, Body: fProbeBody(tmpClauses, null) });
			}
			Object.keys(pEnvelope.Facets).forEach(
				(pFacetKey) =>
				{
					let tmpFacet = pEnvelope.Facets[pFacetKey];
					if (!tmpFacet || (typeof(tmpFacet) !== 'object'))
					{
						return;
					}
					let tmpExcluded = Array.isArray(tmpFacet.Excluded) ? tmpFacet.Excluded : [];
					let tmpExpectedExcluded = libFacetTestHarness.expectedExclusion(tmpBody, tmpSpecs[pFacetKey]);
					if (tmpExpectedExcluded === null)
					{
						tmpReport.Skipped++;
					}
					else
					{
						tmpReport.Checked++;
						if (JSON.stringify(tmpExpectedExcluded) !== JSON.stringify(tmpExcluded))
						{
							tmpReport.Mismatches.push({ Facet: pFacetKey, Check: 'Excluded', Expected: tmpExpectedExcluded, Actual: tmpExcluded });
						}
					}
					let tmpKept = (tmpCountVia === 'List') ? fKeptConjuncts(tmpExcluded) : fKeptClauses(tmpExcluded);
					if (tmpKept === null)
					{
						tmpReport.Skipped++;
						return;
					}
					let tmpSpec = tmpSpecs[pFacetKey];
					if (typeof(tmpFacet.Total) === 'number')
					{
						tmpChecks.push((tmpCountVia === 'List')
							? { Facet: pFacetKey, Check: 'FacetTotal', Expected: tmpFacet.Total, Filter: tmpFilterAST.toFilterString(tmpKept) }
							: { Facet: pFacetKey, Check: 'FacetTotal', Expected: tmpFacet.Total, Body: fProbeBody(tmpKept, tmpSpec) });
						let tmpBucketed = (libFacetTestHarness.BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0) || (libFacetTestHarness.M2_BUCKETED_FOLDS.indexOf(tmpFacet.Fold) >= 0);
						if ((tmpFacet.MultiValued !== true) && tmpBucketed && (typeof(tmpFacet.SumOfCounts) === 'number'))
						{
							let tmpSum = tmpFacet.SumOfCounts + (tmpFacet.MissingCount || 0) + (tmpFacet.OtherCount || 0);
							tmpReport.Checked++;
							if (tmpSum !== tmpFacet.Total)
							{
								tmpReport.Mismatches.push({ Facet: pFacetKey, Check: 'SumOfCounts+MissingCount+OtherCount', Expected: tmpFacet.Total, Actual: tmpSum });
							}
						}
					}
					if (!tmpFacet.Selectable || !Array.isArray(tmpFacet.Buckets))
					{
						return;
					}
					let tmpPositive = 0;
					let tmpZero = 0;
					tmpFacet.Buckets.forEach(
						(pBucket) =>
						{
							if (!pBucket || !pBucket.Clause)
							{
								return;
							}
							if (pBucket.Count > 0)
							{
								if (tmpPositive >= tmpMaxBuckets)
								{
									tmpReport.Skipped++;
									return;
								}
								tmpPositive++;
							}
							else
							{
								if (tmpZero >= tmpZeroSample)
								{
									return;
								}
								tmpZero++;
							}
							if (tmpCountVia === 'Reference')
							{
								tmpChecks.push({ Facet: pFacetKey, Check: 'BucketCount', Key: pBucket.Key, Expected: pBucket.Count, Body: fProbeBody(tmpKept.concat([ pBucket.Clause ]), tmpSpec) });
								return;
							}
							if (PATH_CLAUSE_PATTERN.test(String(pBucket.Clause.Type)))
							{
								tmpReport.Skipped++;
								return;
							}
							let tmpBucketConjuncts;
							try
							{
								tmpBucketConjuncts = tmpClauseCompiler.compile(pEntity, [ pBucket.Clause ]).Conjuncts;
							}
							catch (pCompileError)
							{
								// The service offered a Clause it refuses itself: a real mismatch, never skipped.
								fMismatch({ Facet: pFacetKey, Check: 'ClauseCompiles', Key: pBucket.Key, Actual: (pCompileError && pCompileError.Code) ? pCompileError.Code : String(pCompileError) });
								return;
							}
							let tmpFilter;
							try
							{
								tmpFilter = tmpFilterAST.toFilterString(tmpKept.concat(tmpBucketConjuncts));
							}
							catch (pRenderError)
							{
								if (!pRenderError || (pRenderError.Code !== 'FACET_FILTER_INVALID'))
								{
									throw pRenderError;
								}
								// A value the meadow-filter list syntax cannot carry: not checkable through the list.
								tmpReport.Skipped++;
								return;
							}
							tmpChecks.push({ Facet: pFacetKey, Check: 'BucketCount', Key: pBucket.Key, Expected: pBucket.Count, Filter: tmpFilter });
						});
				});
		}
		catch (pPlanError)
		{
			return setImmediate(() => { fCallback(pPlanError, tmpReport); });
		}

		let fCount = (pCheck, fCounted) =>
		{
			if (tmpCountVia === 'List')
			{
				return tmpHarness.listCount(pEntity, pCheck.Filter, tmpAs, fCounted);
			}
			return tmpHarness.reference(pEntity, pCheck.Body, { As: tmpAs, Now: tmpOptions.Now },
				(pError, pCountEnvelope) =>
				{
					if (pError)
					{
						return fCounted(null, (pError && pError.Code) ? pError.Code : String(pError));
					}
					let tmpProbe = (pCountEnvelope && pCountEnvelope.Facets) ? pCountEnvelope.Facets.Probe : null;
					if (pCheck.Check === 'EnvelopeTotal')
					{
						return fCounted(null, pCountEnvelope ? pCountEnvelope.Total : null);
					}
					return fCounted(null, tmpProbe ? tmpProbe.Total : ((pCountEnvelope && pCountEnvelope.Errors && pCountEnvelope.Errors.Probe) ? pCountEnvelope.Errors.Probe.Code : null));
				});
		};
		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpChecks.length)
			{
				if (tmpReport.Mismatches.length > 0)
				{
					let tmpError = new Error(`Selection round trip (${tmpCountVia}): ${tmpReport.Mismatches.length} mismatch(es) of ${tmpReport.Checked}: ${JSON.stringify(tmpReport.Mismatches.slice(0, 5))}`);
					tmpError.Report = tmpReport;
					return fCallback(tmpError, tmpReport);
				}
				return fCallback(null, tmpReport);
			}
			let tmpCheck = tmpChecks[pIndex];
			fCount(tmpCheck,
				(pCountError, pCount) =>
				{
					if (pCountError)
					{
						return fCallback(pCountError, tmpReport);
					}
					tmpReport.Checked++;
					if (pCount !== tmpCheck.Expected)
					{
						let tmpMismatch = { Facet: tmpCheck.Facet, Check: tmpCheck.Check, Expected: tmpCheck.Expected, Actual: pCount };
						if (Object.prototype.hasOwnProperty.call(tmpCheck, 'Key'))
						{
							tmpMismatch.Key = tmpCheck.Key;
						}
						if (tmpCheck.Filter)
						{
							tmpMismatch.Filter = tmpCheck.Filter;
						}
						tmpReport.Mismatches.push(tmpMismatch);
					}
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	};

	/**
	 * The principal the faceting host resolves for a principal's current session (Host.resolvePrincipal,
	 * §76): RoleSetHash / Actions with entitlements, the tenancy getValue results.
	 *
	 * @param {any} pName
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	tmpHarness.principalFor = (pName, fCallback) =>
	{
		if (!tmpHarness.host)
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness: the faceting host is not bound.')); });
		}
		let tmpSession;
		try
		{
			tmpSession = tmpHarness.sessionFor(fAsName(pName));
		}
		catch (pError)
		{
			return setImmediate(() => { fCallback(pError); });
		}
		return tmpHarness.host.resolvePrincipal({ UserSession: tmpSession }, (pError, pPrincipal) => { setImmediate(() => { fCallback(pError || null, pPrincipal); }); });
	};

	/**
	 * GET <RoutePrefix>/Changes (SSE) as a principal.  Calls back once the answer is known: a 200 after the
	 * 'ready' event, else after the error body.  The stream: { Status, Frames, Body, Ended, events(type),
	 * generations(entity), close() }; stop() closes every stream still open.
	 *
	 * @param {any} pAs
	 * @param {{ Headers?: Record<string, string> }} [pOptions]
	 * @param {(pError?: Error, pStream?: Record<string, any>) => void} fCallback
	 */
	tmpHarness.openChanges = (pAs, pOptions, fCallback) =>
	{
		if (typeof(pOptions) === 'function')
		{
			fCallback = pOptions;
			pOptions = {};
		}
		let tmpHeaders;
		try
		{
			tmpHeaders = Object.assign({ accept: 'text/event-stream' }, fIdentityHeaders(pAs), (pOptions && pOptions.Headers) || {});
		}
		catch (pError)
		{
			return setImmediate(() => { fCallback(pError); });
		}
		let tmpStream = { Status: null, Headers: null, Buffer: '', Text: '', Frames: [], Body: null, Ended: false, Error: null, Request: null };
		let tmpCalledBack = false;
		let fDone = (pError) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			setImmediate(() => { fCallback(pError || null, tmpStream); });
		};
		let fParse = () =>
		{
			let tmpIndex = tmpStream.Buffer.indexOf('\n\n');
			while (tmpIndex >= 0)
			{
				let tmpBlock = tmpStream.Buffer.slice(0, tmpIndex);
				tmpStream.Buffer = tmpStream.Buffer.slice(tmpIndex + 2);
				let tmpFrame = { Event: null, Data: null, ID: null, Comment: null };
				let tmpData = [];
				tmpBlock.split('\n').forEach(
					(pLine) =>
					{
						if (pLine.indexOf(':') === 0)
						{
							tmpFrame.Comment = pLine.slice(1).trim();
							return;
						}
						let tmpColon = pLine.indexOf(':');
						let tmpField = (tmpColon < 0) ? pLine : pLine.slice(0, tmpColon);
						let tmpValue = (tmpColon < 0) ? '' : pLine.slice(tmpColon + 1).replace(/^ /, '');
						if (tmpField === 'event')
						{
							tmpFrame.Event = tmpValue;
						}
						else if (tmpField === 'data')
						{
							tmpData.push(tmpValue);
						}
						else if (tmpField === 'id')
						{
							tmpFrame.ID = tmpValue;
						}
					});
				if (tmpData.length > 0)
				{
					try
					{
						tmpFrame.Data = JSON.parse(tmpData.join('\n'));
					}
					catch (pParseError)
					{
						tmpFrame.Data = tmpData.join('\n');
					}
				}
				tmpStream.Frames.push(tmpFrame);
				tmpIndex = tmpStream.Buffer.indexOf('\n\n');
			}
		};
		tmpStream.events = (pType) => { return tmpStream.Frames.filter((pFrame) => { return pFrame.Event === pType; }); };
		tmpStream.generations = (pEntity) => { return tmpStream.events('generation').filter((pFrame) => { return !pEntity || (pFrame.Data && (pFrame.Data.Entity === pEntity)); }); };
		tmpStream.close = () =>
		{
			if (tmpStream.Request && !tmpStream.Request.destroyed)
			{
				tmpStream.Request.destroy();
			}
		};
		if (!tmpHarness.port || !tmpHarness.baseURL)
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness: the server is not listening.')); });
		}
		tmpStream.Request = libHttp.get(
			{ hostname: '127.0.0.1', port: tmpHarness.port, path: `${fRoutePrefix()}/Changes`, headers: tmpHeaders, agent: false },
			(pResponse) =>
			{
				tmpStream.Status = pResponse.statusCode;
				tmpStream.Headers = pResponse.headers;
				pResponse.setEncoding('utf8');
				pResponse.on('data',
					(pChunk) =>
					{
						tmpStream.Text += pChunk;
						if (tmpStream.Status === 200)
						{
							tmpStream.Buffer += pChunk;
							fParse();
							if (tmpStream.events('ready').length > 0)
							{
								fDone();
							}
						}
					});
				pResponse.on('end',
					() =>
					{
						tmpStream.Ended = true;
						if (tmpStream.Status !== 200)
						{
							try
							{
								tmpStream.Body = JSON.parse(tmpStream.Text);
							}
							catch (pParseError)
							{
								tmpStream.Body = tmpStream.Text;
							}
						}
						fDone();
					});
				pResponse.on('error', () => { tmpStream.Ended = true; });
				pResponse.on('close', () => { tmpStream.Ended = true; });
			});
		tmpStream.Request.on('error',
			(pError) =>
			{
				tmpStream.Error = pError;
				tmpStream.Ended = true;
				fDone(tmpCalledBack ? null : pError);
			});
		tmpHarness._Streams.push(tmpStream);
	};

	/**
	 * Store 'ClickHouse': wait until the materializer has applied everything (the backfill, a write).
	 *
	 * @param {(pError?: Error) => void} fCallback
	 * @param {number} [pTimeoutMS]
	 */
	tmpHarness.quiesce = (fCallback, pTimeoutMS) =>
	{
		let tmpMaterializer = tmpHarness.fable ? tmpHarness.fable.RetoldFacetingMaterializer : null;
		if (!tmpMaterializer || !tmpStoreSupport)
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness.quiesce: no store / materializer.')); });
		}
		return tmpMaterializer.quiesce('ClickHouse', null, (typeof(pTimeoutMS) === 'number') ? pTimeoutMS : 30000, (pError) => { setImmediate(() => { fCallback(pError || null); }); });
	};

	/**
	 * Store 'ClickHouse', O3 in one call: the same body as the same session and pinned Now (default the
	 * fixture's TestNow) on the store (PreferEngine 'ClickHouse': every Agg the store engine can answer),
	 * on Live (PreferEngine 'Live') and through the Reference.  Engines: { Key: 'ClickHouse' | 'Live' }.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pBody
	 * @param {{ As?: string, Now?: string }} pOptions
	 * @param {(pError?: Error, pResult?: Record<string, any>) => void} fCallback
	 */
	tmpHarness.compareStore = (pEntity, pBody, pOptions, fCallback) =>
	{
		let tmpOptions = Object.assign({}, pOptions || {});
		if ((typeof(tmpOptions.Now) !== 'string') && (typeof(tmpOptions.Now) !== 'number'))
		{
			tmpOptions.Now = tmpHarness.traps.TestNow || new Date().toISOString();
		}
		fInProcess(pEntity, pBody, tmpOptions, fInternal(tmpOptions, { PreferEngine: 'ClickHouse' }),
			(pStoreError, pStoreEnvelope, pStoreMeta) =>
			{
				if (pStoreError)
				{
					return fCallback(pStoreError);
				}
				fInProcess(pEntity, pBody, tmpOptions, fInternal(tmpOptions, { PreferEngine: 'Live' }),
					(pLiveError, pLiveEnvelope) =>
					{
						if (pLiveError)
						{
							return fCallback(pLiveError);
						}
						fInProcess(pEntity, pBody, tmpOptions, fInternal(tmpOptions, { ForceEngine: 'Reference' }),
							(pReferenceError, pReferenceEnvelope) =>
							{
								if (pReferenceError)
								{
									return fCallback(pReferenceError);
								}
								let tmpEngines = {};
								let tmpBlock = (pStoreEnvelope && pStoreEnvelope.Store && pStoreEnvelope.Store.Facets) ? pStoreEnvelope.Store.Facets : {};
								Object.keys(tmpBlock).forEach((pKey) => { tmpEngines[pKey] = tmpBlock[pKey].Engine; });
								return fCallback(null,
									{
										Store: pStoreEnvelope,
										Live: pLiveEnvelope,
										Reference: pReferenceEnvelope,
										StoreNormalized: libFacetEnvelope.normalizeForComparison(pStoreEnvelope),
										LiveNormalized: libFacetEnvelope.normalizeForComparison(pLiveEnvelope),
										ReferenceNormalized: libFacetEnvelope.normalizeForComparison(pReferenceEnvelope),
										Engines: tmpEngines,
										StoreMeta: (pStoreMeta && pStoreMeta.Store) ? pStoreMeta.Store : null
									});
							});
					});
			});
	};

	/**
	 * Login mode: POST /1.0/Authenticate as the principal (its account and random password), keep the
	 * RetoldSessionID cookie, then one authenticated GET /1.0/CheckSession so the entitlements pre-handler
	 * IDUser-enriches the stored session (in-process calls see the same session).  Resets the principal to
	 * its home tenant.
	 *
	 * @param {string} pName
	 * @param {(pError?: Error, pResponse?: Record<string, any>) => void} fCallback - the Authenticate response
	 */
	tmpHarness.login = (pName, fCallback) =>
	{
		let tmpPrincipal;
		try
		{
			tmpPrincipal = fPrincipal(pName);
		}
		catch (pError)
		{
			return setImmediate(() => { fCallback(pError); });
		}
		if (!tmpPrincipal || (tmpOptions.Session !== 'Login'))
		{
			return setImmediate(() => { fCallback(new Error('Facet-RAFS-Harness.login needs a principal and Session \'Login\'.')); });
		}
		httpRequest(`${tmpHarness.baseURL}/1.0/Authenticate`, 'POST', { UserName: tmpPrincipal.LoginID, Password: tmpSecrets.get(pName) }, {},
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpCookieName = (tmpHarness.server && tmpHarness.server.options.OratorAuthenticationCookieName) || 'RetoldSessionID';
				let tmpCookie = (pResponse.SetCookie || []).map((pCookie) => { return String(pCookie).split(';')[0]; }).filter((pCookie) => { return pCookie.indexOf(`${tmpCookieName}=`) === 0; })[0];
				if ((pResponse.Status !== 200) || !pResponse.JSON || (pResponse.JSON.LoggedIn !== true) || !tmpCookie)
				{
					let tmpLoginError = new Error(`Facet-RAFS-Harness: [${pName}] could not log in: ${pResponse.Status} ${pResponse.Text}`);
					tmpLoginError.Response = pResponse;
					return fCallback(tmpLoginError, pResponse);
				}
				tmpPrincipal.Cookie = tmpCookie;
				tmpHarness.request('GET', '/1.0/CheckSession', null, pName,
					(pCheckError) =>
					{
						// The tenant is what Auth.Local resolved (its first membership read), the persona what the
						// enrichment wrote: the principal follows the session, never the other way round.
						let tmpRecord = tmpHarness.sessionFor(pName).UserRecord || {};
						let tmpTenant = tmpRecord[AUTH_LOCAL.TenantField] || 0;
						let tmpMembership = tmpPrincipal.Memberships.find((pEntry) => { return pEntry.Tenant === tmpTenant; });
						tmpPrincipal.Tenant = tmpTenant;
						tmpPrincipal.User = tmpMembership ? tmpMembership.User : 0;
						return fCallback(pCheckError || null, pResponse);
					});
			});
	};

	/**
	 * Move a principal to another tenant.  Login: POST /1.0/Session/Context/<IDCustomer> (Retold-Membership's
	 * verified switch; it resets the persona, re-enriched on the principal's next request).  Header: the
	 * principal's headers move to its membership in that tenant (refused without one), as a resolver would.
	 *
	 * @param {string} pName
	 * @param {number} pIDCustomer
	 * @param {(pError?: Error, pResponse?: Record<string, any>) => void} fCallback - { Status, JSON: { Switched, … } }
	 */
	tmpHarness.switchTenant = (pName, pIDCustomer, fCallback) =>
	{
		let tmpPrincipal;
		try
		{
			tmpPrincipal = fPrincipal(pName);
		}
		catch (pError)
		{
			return setImmediate(() => { fCallback(pError); });
		}
		let tmpMembership = tmpPrincipal ? tmpPrincipal.Memberships.find((pEntry) => { return pEntry.Tenant === pIDCustomer; }) : null;
		if (tmpOptions.Session === 'Header')
		{
			if (tmpMembership)
			{
				tmpPrincipal.Tenant = tmpMembership.Tenant;
				tmpPrincipal.User = tmpMembership.User;
			}
			return setImmediate(() => { fCallback(null, { Status: 200, JSON: { Switched: !!tmpMembership } }); });
		}
		tmpHarness.request('POST', `/1.0/Session/Context/${encodeURIComponent(String(pIDCustomer))}`, null, pName,
			(pError, pResponse) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pResponse.JSON && (pResponse.JSON.Switched === true) && tmpMembership)
				{
					tmpPrincipal.Tenant = tmpMembership.Tenant;
					tmpPrincipal.User = tmpMembership.User;
				}
				return fCallback(null, pResponse);
			});
	};

	/**
	 * Stop listening (fable.Orator.stopService runs the faceting shutdown hook first, §73.4), shut the service
	 * down if its routes never connected, then release the database and the temp directory.  Idempotent.
	 *
	 * @param {(pError?: Error) => void} fStopDone
	 */
	tmpHarness.stop = (fStopDone) =>
	{
		if (tmpHarness._Stopped)
		{
			return fStopDone();
		}
		tmpHarness._Stopped = true;
		tmpHarness._Streams.forEach((pStream) => { pStream.close(); });
		let fRemoveTemp = () =>
		{
			try
			{
				if (tmpHarness.tempDirectory)
				{
					libFS.rmSync(tmpHarness.tempDirectory, { recursive: true, force: true });
				}
			}
			catch (pRemoveError)
			{
				// best effort
			}
			if (!tmpStoreSupport || !tmpHarness.storeDatabase)
			{
				return fStopDone();
			}
			return tmpStoreSupport.release(tmpHarness.storeDatabase, () => { return fStopDone(); });
		};
		// A test store database about to be dropped is abandoned (the RDS harness's rule): the materializer
		// crashes (every timer cleared, nothing written) and the client's sockets close BEFORE the shutdown
		// hook, so a graceful drain never waits on it.
		let tmpMaterializer = (tmpStoreSupport && tmpHarness.fable) ? tmpHarness.fable.RetoldFacetingMaterializer : null;
		if (tmpMaterializer)
		{
			try
			{
				tmpMaterializer.crash();
			}
			catch (pCrashError)
			{
				// stopping anyway
			}
			try
			{
				let tmpStoreService = tmpHarness.fable.RetoldFacetingStoreClickHouse;
				if (tmpStoreService && (typeof(tmpStoreService.close) === 'function'))
				{
					tmpStoreService.close();
				}
			}
			catch (pCloseError)
			{
				// stopping anyway
			}
		}
		let fRelease = () =>
		{
			let tmpFable = tmpHarness.fable;
			if (tmpOptions.Provider === 'PostgreSQL')
			{
				let tmpPool = (tmpFable && tmpFable.MeadowPostgreSQLProvider) ? tmpFable.MeadowPostgreSQLProvider.pool : null;
				let fDrop = () =>
				{
					if (!tmpHarness.connection)
					{
						return fRemoveTemp();
					}
					return libProviders.release(tmpHarness.connection, () => { return fRemoveTemp(); });
				};
				if (!tmpPool || tmpPool.ended || tmpPool.ending)
				{
					return fDrop();
				}
				return tmpPool.end(() => { return fDrop(); });
			}
			try
			{
				if (tmpFable && tmpFable.MeadowSQLiteProvider && tmpFable.MeadowSQLiteProvider.db && (typeof(tmpFable.MeadowSQLiteProvider.db.close) === 'function'))
				{
					tmpFable.MeadowSQLiteProvider.db.close();
				}
			}
			catch (pCloseError)
			{
				// already closed
			}
			return fRemoveTemp();
		};
		let fShutdownService = () =>
		{
			let tmpService = tmpHarness.service;
			if (!tmpService || (typeof(tmpService.shutdown) !== 'function'))
			{
				return fRelease();
			}
			try
			{
				return tmpService.shutdown(() => { return fRelease(); });
			}
			catch (pShutdownError)
			{
				return fRelease();
			}
		};
		let tmpOrator = tmpHarness.fable ? tmpHarness.fable.Orator : null;
		if (!tmpOrator || !tmpOrator.serviceServer || !tmpOrator.serviceServer.Active)
		{
			return fShutdownService();
		}
		// Orator calls back with a message (not an error) when nothing listens; either way release.
		tmpOrator.stopService(() => { return fShutdownService(); });
	};

	// ---- Boot ----
	let fBoot = () =>
	{
		let tmpServer;
		try
		{
			tmpServer = new RFSHarnessServer(tmpServerOptions);
		}
		catch (pConstructError)
		{
			return fFinish(pConstructError);
		}
		tmpHarness.server = tmpServer;
		tmpServer.start(
			(pStartError) =>
			{
				if (pStartError)
				{
					return fFinish(pStartError);
				}
				let fReady = () =>
				{
					if (!tmpStoreSupport || (tmpStoreOptions.Quiesce === false))
					{
						return fFinish();
					}
					tmpHarness.quiesce((pQuiesceError) => { return fFinish(pQuiesceError || undefined); }, (typeof(tmpStoreOptions.QuiesceTimeoutMS) === 'number') ? tmpStoreOptions.QuiesceTimeoutMS : 90000);
				};
				if (tmpOptions.Session !== 'Login')
				{
					return fReady();
				}
				let tmpNames = Object.keys(tmpHarness.principals);
				let fLogin = (pIndex) =>
				{
					if (pIndex >= tmpNames.length)
					{
						return fReady();
					}
					tmpHarness.login(tmpNames[pIndex], (pLoginError) => { return pLoginError ? fFinish(pLoginError) : fLogin(pIndex + 1); });
				};
				return fLogin(0);
			});
	};

	// The ClickHouse container (when the store is on) before anything boots.
	let fEnsureStore = (fNext) =>
	{
		if (!tmpStoreSupport)
		{
			return fNext();
		}
		return tmpStoreSupport.ensure((pEnsureError) => { return pEnsureError ? fFinish(pEnsureError) : fNext(); });
	};

	if (tmpOptions.Provider !== 'PostgreSQL')
	{
		fEnsureStore(fBoot);
		return tmpHarness;
	}

	// PostgreSQL: a fresh rfs_<pid>_<n> database loaded with the fixture's DDL and rows before boot (the
	// provider hook's connect + seed), then RAFS connects its own pool to it.
	let tmpLoaderFable = new libFable({ Product: 'RFSRAFSHarnessLoader', LogStreams: [ { streamtype: 'console', level: tmpOptions.LogLevel } ], PostgreSQL: { database: libProviders.nextDatabaseName() } });
	fEnsureStore(() => { libProviders.connect('PostgreSQL', tmpLoaderFable, {},
		(pConnectError, pConnection) =>
		{
			if (pConnectError)
			{
				return fFinish(pConnectError);
			}
			tmpHarness.connection = pConnection;
			libProviders.seed(pConnection, { generate: () => { return tmpGenerated; } }, {},
				(pSeedError, pSeedResult) =>
				{
					if (pSeedError)
					{
						return fFinish(pSeedError);
					}
					tmpHarness.seed = pSeedResult;
					let tmpInfo = pConnection._Info;
					tmpServerOptions.PostgreSQL = { Server: tmpInfo.host, Port: tmpInfo.port, User: tmpInfo.user, Password: tmpInfo.password, Database: pConnection.Database, ConnectionPoolLimit: 4 };
					return fBoot();
				});
		}); });
	return tmpHarness;
};

module.exports = (
	{
		ENV_RAFS_PATH: ENV_RAFS_PATH,
		PACKAGE_NAME: PACKAGE_NAME,
		MONOREPO_RAFS_PATH: MONOREPO_RAFS_PATH,
		SESSION_HEADERS: SESSION_HEADERS,
		PORTS: PORTS,
		SMOKE_PORT: SMOKE_PORT,
		SESSIONS: SESSIONS,
		INSTALLERS: INSTALLERS,
		OVERLAY_MODEL_PATH: OVERLAY_MODEL_PATH,
		FIXTURES: FIXTURES,
		AUTH_LOCAL: AUTH_LOCAL,
		DEFAULT_ROLES: DEFAULT_ROLES,
		DEFAULT_GRANTS: DEFAULT_GRANTS,
		PROBE_LATE_MOUNTS: PROBE_LATE_MOUNTS,
		PROBE_GLOBAL_ENTITIES: PROBE_GLOBAL_ENTITIES,
		resolveRAFS: resolveRAFS,
		load: load,
		overlayModel: overlayModel,
		mergeOverlay: mergeOverlay,
		start: start
	});
