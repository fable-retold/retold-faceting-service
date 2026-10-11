/**
 * Unit tests for RetoldFacetingHostApplicationServer and the foundation installers (internal-contracts
 * Part V, §73–§79), against STUB RetoldApplicationServer-shaped objects — no RAFS checkout needed:
 *
 *   1. the host on a hand-made stub (fake DALs, meadow-endpoints-shaped endpoints whose controllers carry
 *      or lack the Retold-Tenancy layer marker): discovery and the coverage classes, the scope policy
 *      from tenancyConfig(), isFacetable (NoAutoCRUD object map, DeniedPrefixes, Exclude / global,
 *      late mounts, root / identity tables), the bind refusals and warnings, the principal (tenant 0 and
 *      owner 0 → 401 through the real PrincipalResolver), the entitlements authorizer per referenced
 *      entity, the action-set cache and its invalidation, the raw writers;
 *   2. the installers on a stub whose DALs and endpoints are REAL meadow / meadow-endpoints objects over
 *      in-memory SQLite (a RAFS-like tenancy guard on the guarded controllers): RAFS's step convention
 *      run through fable Anticipate in boot order, late mounts, idempotence, boot failures, Options.Host,
 *      and in-process facet queries end to end (tenant isolation, tenant 0 / owner 0 / anonymous → 401,
 *      the entitlement gate at the root).
 *
 * No server listens (the stub's service server records route registrations); no port is used.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libMeadow = require('meadow');
const libMeadowEndpoints = require('meadow-endpoints');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libRetoldFacetingService = require('../source/Retold-Faceting-Service.js');
const libRetoldFacetingHostApplicationServer = require('../source/host/Retold-Faceting-Host-ApplicationServer.js');
const libRetoldFacetingHostDataService = require('../source/host/Retold-Faceting-Host-DataService.js');
const libRetoldFacetingInstallers = require('../source/Retold-Faceting-Installers.js');
const libRetoldFacetingPrincipalResolver = require('../source/security/Retold-Faceting-PrincipalResolver.js');
const libRetoldFacetingAuthorizer = require('../source/security/Retold-Faceting-Authorizer.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');
const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');

const COVERAGE = libRetoldFacetingHostApplicationServer.COVERAGE;
const MARKER = libRetoldFacetingHostApplicationServer.TENANCY_LAYERS_MARKER;

// ---------------------------------------------------------------- model and stub builders

const TENANT_COLUMN = Object.freeze({ Column: 'IDCustomer', DataType: 'Numeric', Size: 'int' });
const OWNER_COLUMN = Object.freeze({ Column: 'OwnerIDUser', DataType: 'Numeric', Size: 'int' });
const NAME_COLUMN = Object.freeze({ Column: 'Name', DataType: 'String', Size: '64' });
const COLOR_COLUMN = Object.freeze({ Column: 'Color', DataType: 'String', Size: '32' });

/**
 * A Stricture-extended model table: ID<Name>, Deleted, then pColumns.
 *
 * @param {string} pName
 * @param {Array<Record<string, any>>} pColumns
 * @return {Record<string, any>}
 */
const tableOf = (pName, pColumns) =>
{
	let tmpColumns = [ { Column: `ID${pName}`, DataType: 'ID' }, { Column: 'Deleted', DataType: 'Boolean' } ]
		.concat((pColumns || []).map((pColumn) => { return Object.assign({}, pColumn); }));
	let tmpSchema = tmpColumns.map(
		(pColumn) =>
		{
			if (pColumn.DataType === 'ID')
			{
				return { Column: pColumn.Column, Type: 'AutoIdentity', Size: 'Default' };
			}
			if (pColumn.Column === 'Deleted')
			{
				return { Column: 'Deleted', Type: 'Deleted', Size: 'Default' };
			}
			if (pColumn.DataType === 'Numeric')
			{
				return { Column: pColumn.Column, Type: 'Integer', Size: 'int' };
			}
			return { Column: pColumn.Column, Type: 'String', Size: pColumn.Size || '64' };
		});
	let tmpDefault = {};
	tmpColumns.forEach((pColumn) => { tmpDefault[pColumn.Column] = (pColumn.DataType === 'String') ? '' : ((pColumn.Column === 'Deleted') ? false : 0); });
	return (
		{
			TableName: pName,
			Columns: tmpColumns,
			MeadowSchema: { Scope: pName, DefaultIdentifier: `ID${pName}`, Schema: tmpSchema, DefaultObject: tmpDefault, JsonSchema: { title: pName, type: 'object', properties: {}, required: [] } }
		});
};

/**
 * A meadow-endpoints-shaped endpoint over a fake controller (Suite 1).
 *
 * @param {Record<string, any>} pDAL
 * @param {Record<string, any>} pTableSpec - { Mount: 'Guarded' | 'Plain', Settings, Version, Reads }
 * @return {Record<string, any>}
 */
const fakeEndpoint = (pDAL, pTableSpec) =>
{
	let tmpInjection = (
		{
			_BehaviorFunctions: {},
			setBehavior: function (pHash, fBehavior)
			{
				this._BehaviorFunctions[pHash] = fBehavior;
			}
		});
	if (pTableSpec.Mount === 'Guarded')
	{
		tmpInjection[MARKER] = [ {} ];
	}
	let tmpController = { DAL: pDAL, BehaviorInjection: tmpInjection, settings: pTableSpec.Settings || {} };
	let tmpVersion = pTableSpec.Version || '1.0';
	// As meadow-endpoints: EndpointName = DAL.scope, EndpointPrefix = '/<version>/<EndpointName>' (Meadow-Endpoints.js:43-47).
	let tmpName = pTableSpec.Scope || pDAL.scope;
	let tmpEndpoint = { _Controller: tmpController, EndpointVersion: tmpVersion, EndpointName: tmpName, EndpointPrefix: `/${tmpVersion}/${tmpName}`, _EnabledBehaviorSets: { Reads: (pTableSpec.Reads !== false) } };
	Object.defineProperty(tmpEndpoint, 'controller', { get: function () { return this._Controller; }, enumerable: false });
	return tmpEndpoint;
};

/**
 * Add one table to a stub server the way RAFS's _loadMeadowEndpoints does: a DAL always, an endpoint
 * unless Mount 'None' (a NoAutoCRUDTables entry).
 *
 * @param {Record<string, any>} pServer
 * @param {string} pName
 * @param {Record<string, any>} pTableSpec - { Columns, Mount, Settings, Version, Reads }
 */
const mountStubTable = (pServer, pName, pTableSpec) =>
{
	let tmpTable = tableOf(pName, pTableSpec.Columns);
	pServer.MeadowModel.Tables[pName] = tmpTable;
	let tmpDAL = { scope: pName, providerName: 'SQLite', defaultIdentifier: `ID${pName}`, schema: tmpTable.MeadowSchema.Schema };
	pServer.DAL[pName] = tmpDAL;
	if (pTableSpec.Mount === 'None')
	{
		pServer.NoAutoCRUDTables[pName] = true;
		return;
	}
	pServer.Endpoints[pName] = fakeEndpoint(tmpDAL, pTableSpec);
};

/**
 * A fake Retold-Entitlements module: grants keyed 'IDUser|IDCustomer' → [ action ].
 *
 * @param {Record<string, Array<string>>} pGrants
 * @param {Record<string, any>} [pControl] - { Fail: true } makes resolveActions fail; { Defer: [] } queues callbacks
 * @return {Record<string, any>}
 */
const fakeEntitlementsModule = (pGrants, pControl) =>
{
	let tmpControl = pControl || {};
	let tmpModule = (
		{
			Calls: [],
			can: (pActions, pAction) => { return !!(pActions && (typeof(pActions.has) === 'function') && pActions.has(pAction)); },
			resolveActions: (pServer, pConfig, pIDUser, pIDCustomer, fCallback) =>
			{
				tmpModule.Calls.push([ pIDUser, pIDCustomer ]);
				let fAnswer = () =>
				{
					if (tmpControl.Fail)
					{
						return fCallback(new Error('role tables unavailable'));
					}
					return fCallback(null, { RoleIDs: [], Actions: new Set(pGrants[`${pIDUser}|${pIDCustomer}`] || []) });
				};
				if (Array.isArray(tmpControl.Defer))
				{
					tmpControl.Defer.push(fAnswer);
					return;
				}
				return fAnswer();
			}
		});
	return tmpModule;
};

/**
 * A stub RetoldApplicationServer (Suite 1): a class instance (so .constructor.Entitlements / .manifest
 * resolve the way they do on a RAFS subclass) whose boot "reached the hook phase".
 *
 * @param {Record<string, any>} pSpec - { Tables, Tenancy, Entitlements, EntitlementsModule, Membership,
 *                                        RecordLevel, Comms, Profile, Auth, Manifest, Options, NoAutoCRUDArray }
 * @return {Record<string, any>}
 */
const stubServer = (pSpec) =>
{
	let tmpSpec = pSpec || {};
	class StubApplicationServer
	{
		constructor()
		{
			this.fable = libBuilders.newFable('RetoldFacetingRAFSStub');
			// As on RAFS, the options object IS the fable settings (Retold-Application-Server.js:208).
			Object.assign(this.fable.settings, tmpSpec.Options || {});
			this.options = this.fable.settings;
			this.DAL = {};
			this.Endpoints = {};
			this.MeadowModel = { Tables: {} };
			this.NoAutoCRUDTables = {};
		}

		tenancyConfig()
		{
			return (typeof(tmpSpec.Tenancy) === 'undefined') ? null : tmpSpec.Tenancy;
		}

		entitlementsConfig()
		{
			return tmpSpec.Entitlements || null;
		}

		authConfig()
		{
			return tmpSpec.Auth || {};
		}

		profileConfig()
		{
			return tmpSpec.Profile || null;
		}
	}
	StubApplicationServer.Entitlements = tmpSpec.EntitlementsModule || null;
	if (tmpSpec.Manifest)
	{
		StubApplicationServer.manifest = tmpSpec.Manifest;
	}
	let tmpServer = new StubApplicationServer();
	if (tmpSpec.Membership)
	{
		tmpServer.MembershipConfig = tmpSpec.Membership;
	}
	if (tmpSpec.RecordLevel)
	{
		tmpServer.RecordLevelConfig = tmpSpec.RecordLevel;
	}
	if (tmpSpec.Comms)
	{
		tmpServer.CommsConfig = tmpSpec.Comms;
	}
	let tmpTables = tmpSpec.Tables || {};
	Object.keys(tmpTables).forEach((pName) => { mountStubTable(tmpServer, pName, tmpTables[pName]); });
	if (tmpSpec.NoAutoCRUDArray)
	{
		tmpServer.NoAutoCRUDTables = Object.keys(tmpServer.NoAutoCRUDTables);
	}
	return tmpServer;
};

// The standard probe set (Suite 1): one table per coverage class and §78 rule.
const standardTables = () =>
{
	return (
		{
			Customer: { Columns: [ NAME_COLUMN ], Mount: 'Plain' },                          // Excluded root (IDCustomer is its key)
			Widget: { Columns: [ TENANT_COLUMN, OWNER_COLUMN, NAME_COLUMN, COLOR_COLUMN ], Mount: 'Guarded' },   // Installed + personal
			Gadget: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' },           // Installed
			WidgetType: { Columns: [ NAME_COLUMN ], Mount: 'Plain' },                        // Excluded, global
			TenantNote: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Plain' },         // Excluded with the column, not global
			Hidden: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'None' },              // NoAutoCRUD → Controllerless
			Denied: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' },           // Installed, denied by prefix
			DeniedNote: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' },       // indexOf === 0: hidden by '/1.0/Denied' too
			Broken: { Columns: [ NAME_COLUMN ], Mount: 'Guarded' },                          // a layer, no tenancy column → Misconfigured
			Stray: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Plain' },              // Unguarded WITH the column
			Lookup: { Columns: [ NAME_COLUMN ], Mount: 'Plain' },                            // Unguarded, global by opt-in
			Account: { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' }           // NEVER_FACETABLE
		});
};

const standardTenancy = () =>
{
	return (
		{
			Column: 'IDCustomer',
			Exclude: [ 'Customer', 'WidgetType', 'TenantNote' ],
			PersonalScopes: { Widget: { Column: 'OwnerIDUser', SessionField: 'IDUser' } },
			DeniedPrefixes: [ '/1.0/Denied' ]
		});
};

// Customer (keyed by the tenancy column) is the tenant root: never listed, since naming a global root /
// identity table in GlobalEntities is a boot refusal (§78 rule 5).
const standardFaceting = (pExtra) =>
{
	return libRetoldFacetingUtil.isPlainObject(pExtra)
		? Object.assign({ Catalog: { GlobalEntities: [ 'WidgetType', 'Lookup', 'Stray', 'TenantNote' ] } }, pExtra)
		: { Catalog: { GlobalEntities: [ 'WidgetType', 'Lookup', 'Stray' ] } };
};

/**
 * An entitlements config in the Kit shape (every field RAFS reads raw, §73.5), plus overrides.
 *
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const standardEntitlements = (pExtra) =>
{
	return Object.assign(
		{
			APIPrefix: '/1.0/',
			IdentityTable: 'Persona',
			IdentityAccountField: 'IDAccount',
			IdentityUserField: 'IDUser',
			TenantField: 'IDCustomer',
			RoleTable: 'Role',
			RoleActionTable: 'RoleAction',
			UserRoleTable: 'UserRole',
			UserActionTable: 'UserAction',
			ExcludeEntities: []
		}, pExtra || {});
};

/**
 * Construct a host on the server's fable and bind it (bind is synchronous on a stub).
 *
 * @param {Record<string, any>} pServer
 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
 * @return {{ Host: any, Error: Error|null, Warnings: Array<string> }}
 */
const bindNow = (pServer, pOptions) =>
{
	let tmpWarnings = [];
	let fWarn = pServer.fable.log.warn;
	pServer.fable.log.warn = (pMessage) => { tmpWarnings.push(String(pMessage)); };
	let tmpHost = new libRetoldFacetingHostApplicationServer(pServer.fable, pOptions || {});
	let tmpResult = null;
	try
	{
		tmpHost.bind(pServer, (pError) => { tmpResult = { Host: tmpHost, Error: pError || null, Warnings: tmpWarnings }; });
	}
	finally
	{
		pServer.fable.log.warn = fWarn;
	}
	Expect(tmpResult, 'bind called back synchronously').to.not.equal(null);
	return tmpResult;
};

/**
 * resolvePrincipal for an in-process request carrying pUserSession (synchronous on a stub).
 *
 * @param {any} pHost
 * @param {any} pUserSession
 * @return {{ Error: Error|null, Principal: Record<string, any>|null }}
 */
const resolveNow = (pHost, pUserSession) =>
{
	let tmpResult = null;
	pHost.resolvePrincipal({ UserSession: pUserSession },
		(pError, pPrincipal) =>
		{
			tmpResult = { Error: pError || null, Principal: pPrincipal || null };
		});
	Expect(tmpResult, 'resolvePrincipal called back synchronously').to.not.equal(null);
	return tmpResult;
};

/**
 * The PrincipalResolver's decision (the 401 gate) for a session on this host.
 *
 * @param {any} pHost
 * @param {any} pUserSession
 * @param {string} pEntity
 * @return {{ Error: Error|null, Principal: Record<string, any>|null }}
 */
const gateNow = (pHost, pUserSession, pEntity) =>
{
	let tmpResolver = new libRetoldFacetingPrincipalResolver(pHost.fable, pHost.options);
	let tmpResult = null;
	tmpResolver.resolve({ Host: pHost, Request: { UserSession: pUserSession }, Options: pHost.options, Entity: pEntity, RequestID: 'unit' },
		(pError, pPrincipal) =>
		{
			tmpResult = { Error: pError || null, Principal: pPrincipal || null };
		});
	Expect(tmpResult).to.not.equal(null);
	return tmpResult;
};

// ---------------------------------------------------------------- the database-backed stub (Suite 2)

/**
 * A RAFS-like tenancy guard (the 401, then Column = getValue(UserSession) per spec, read from
 * pRequest.UserSession exactly as Retold-Tenancy.js fGuard does — without the outer-group fence, which
 * the capture-side peeling handles and the RAFS-gated suite pins).
 *
 * @param {Array<{ Column: string, getValue: (pSession: any) => any }>} pSpecs
 * @return {Function}
 */
const rafsLikeGuard = (pSpecs) =>
{
	return function (pRequest, pRequestState, fCallback)
	{
		if (!pRequest.UserSession || !pRequest.UserSession.UserRecord)
		{
			return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
		}
		for (let i = 0; i < pSpecs.length; i++)
		{
			pRequestState.Query.addFilter(pSpecs[i].Column, pSpecs[i].getValue(pRequest.UserSession), '=', 'AND', `Tenant${pSpecs[i].Column}`);
		}
		return fCallback();
	};
};

const recordValue = (pField) =>
{
	return (pSession) => { return (pSession && pSession.UserRecord) ? (pSession.UserRecord[pField] || 0) : 0; };
};

/**
 * A recording Orator service server (no listener).
 *
 * @return {Record<string, any>}
 */
const recordingServiceServer = () =>
{
	let tmpServer = (
		{
			Routes: [],
			Closed: 0,
			post: function (pRoute) { this.Routes.push(`POST ${pRoute}`); },
			get: function (pRoute) { this.Routes.push(`GET ${pRoute}`); },
			put: function (pRoute) { this.Routes.push(`PUT ${pRoute}`); },
			del: function (pRoute) { this.Routes.push(`DEL ${pRoute}`); },
			pre: function () { },
			use: function () { },
			close: function (fCallback)
			{
				this.Closed++;
				if (typeof(fCallback) === 'function')
				{
					return fCallback();
				}
			}
		});
	return tmpServer;
};

// Suite 2 model: two tenants of Widgets (owner-scoped), Gadgets, a global WidgetType, a role table.
const DB_TABLES = Object.freeze(
	{
		Widget: [ TENANT_COLUMN, OWNER_COLUMN, NAME_COLUMN, COLOR_COLUMN ],
		Gadget: [ TENANT_COLUMN, NAME_COLUMN ],
		WidgetType: [ NAME_COLUMN ],
		UserRole: [ TENANT_COLUMN, { Column: 'IDUser', DataType: 'Numeric', Size: 'int' }, { Column: 'IDRole', DataType: 'Numeric', Size: 'int' } ],
		Late: [ NAME_COLUMN ]
	});

// Widget rows: [ IDCustomer, OwnerIDUser, Color, Deleted ]
const WIDGET_ROWS = Object.freeze(
	[
		[ 1, 7, 'Red', 0 ], [ 1, 7, 'Red', 0 ], [ 1, 7, 'Blue', 0 ], [ 1, 8, 'Green', 0 ], [ 1, 7, 'Red', 1 ],
		[ 2, 9, 'Red', 0 ], [ 2, 9, 'Yellow', 0 ], [ 2, 9, 'Yellow', 0 ]
	]);

/**
 * Boot a database-backed stub: real meadow DALs and meadow-endpoints controllers over in-memory SQLite,
 * the RAFS-like guard + layer marker on the guarded tables (Widget: tenant + owner; Gadget, UserRole:
 * tenant), WidgetType excluded.  'Late' gets a DAL but no endpoint until pServer.mountLate() runs.
 *
 * @param {Record<string, any>} pSpec - { Entitlements, EntitlementsModule, Options }
 * @param {(pError?: Error, pServer?: Record<string, any>) => void} fCallback
 */
const bootDatabaseStub = (pSpec, fCallback) =>
{
	let tmpSpec = pSpec || {};
	let tmpFable = libBuilders.newFable('RetoldFacetingRAFSDatabaseStub');
	tmpFable.settings.SQLite = { SQLiteFilePath: ':memory:' };
	tmpFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
	tmpFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
	tmpFable.MeadowSQLiteProvider.connectAsync(
		(pConnectError) =>
		{
			if (pConnectError)
			{
				return fCallback(pConnectError);
			}
			let tmpModel = { Tables: {} };
			Object.keys(DB_TABLES).forEach((pName) => { tmpModel.Tables[pName] = tableOf(pName, DB_TABLES[pName]); });
			let tmpDB = tmpFable.MeadowSQLiteProvider.db;
			libBookstoreSeed.createTables(tmpDB, tmpModel);
			WIDGET_ROWS.forEach((pRow) => { tmpDB.exec(`INSERT INTO Widget (Deleted, IDCustomer, OwnerIDUser, Name, Color) VALUES (${pRow[3]}, ${pRow[0]}, ${pRow[1]}, 'w', '${pRow[2]}')`); });
			tmpDB.exec(`INSERT INTO Gadget (Deleted, IDCustomer, Name) VALUES (0, 1, 'g1'), (0, 2, 'g2'), (0, 2, 'g3')`);
			tmpDB.exec(`INSERT INTO WidgetType (Deleted, Name) VALUES (0, 'Small'), (0, 'Large')`);
			tmpDB.exec(`INSERT INTO Late (Deleted, Name) VALUES (0, 'late')`);

			let tmpServiceServer = recordingServiceServer();
			tmpFable.OratorServiceServer = tmpServiceServer;
			tmpFable.Orator = { serviceServer: tmpServiceServer };

			class DatabaseStubServer
			{
				constructor()
				{
					this.fable = tmpFable;
					this.options = tmpSpec.Options || {};
					this.DAL = {};
					this.Endpoints = {};
					this.MeadowModel = tmpModel;
					this.NoAutoCRUDTables = { Late: true };
				}

				tenancyConfig()
				{
					return { Column: 'IDCustomer', Exclude: [ 'WidgetType' ], PersonalScopes: { Widget: { Column: 'OwnerIDUser', SessionField: 'IDUser' } } };
				}

				entitlementsConfig()
				{
					return tmpSpec.Entitlements || null;
				}

				/**
				 * A route installer that mounts the 'Late' endpoint (after tenancy: no guard, no marker).
				 */
				mountLate()
				{
					this.Endpoints.Late = libMeadowEndpoints.new(this.DAL.Late);
				}
			}
			DatabaseStubServer.Entitlements = tmpSpec.EntitlementsModule || null;
			let tmpServer = new DatabaseStubServer();
			let tmpMeadow = libMeadow.new(tmpFable);
			Object.keys(tmpModel.Tables).forEach(
				(pName) =>
				{
					let tmpDAL = tmpMeadow.loadFromPackageObject(tmpModel.Tables[pName].MeadowSchema);
					tmpDAL.setProvider('SQLite');
					tmpServer.DAL[pName] = tmpDAL;
					if (pName === 'Late')
					{
						return;
					}
					tmpServer.Endpoints[pName] = libMeadowEndpoints.new(tmpDAL);
				});
			// The tenancy layers RAFS's _mountTenancy would install (minus the outer group).
			let fGuard = (pName, pSpecs) =>
			{
				let tmpInjection = tmpServer.Endpoints[pName].controller.BehaviorInjection;
				[ 'Reads-QueryConfiguration', 'Read-QueryConfiguration', 'Count-QueryConfiguration' ].forEach(
					(pHash) =>
					{
						tmpInjection.setBehavior(pHash, rafsLikeGuard(pSpecs));
					});
				tmpInjection[MARKER] = [ {} ];
			};
			fGuard('Widget', [ { Column: 'IDCustomer', getValue: recordValue('IDCustomer') }, { Column: 'OwnerIDUser', getValue: recordValue('IDUser') } ]);
			fGuard('Gadget', [ { Column: 'IDCustomer', getValue: recordValue('IDCustomer') } ]);
			fGuard('UserRole', [ { Column: 'IDCustomer', getValue: recordValue('IDCustomer') } ]);
			return fCallback(null, tmpServer);
		});
};

/**
 * Run steps exactly as RAFS's start() does: fable Anticipate, one callback each, wait().
 *
 * @param {any} pFable
 * @param {Array<Function>} pSteps
 * @param {(pError?: Error) => void} fCallback
 */
const runBoot = (pFable, pSteps, fCallback) =>
{
	let tmpAnticipate = pFable.newAnticipate();
	pSteps.forEach((fStep) => { tmpAnticipate.anticipate(fStep); });
	tmpAnticipate.wait(fCallback);
};

/**
 * An in-process facet query as a session.
 *
 * @param {any} pService
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {any} pUserSession
 * @param {(pError?: Error, pEnvelope?: Record<string, any>) => void} fCallback
 */
const facetAs = (pService, pEntity, pBody, pUserSession, fCallback) =>
{
	return pService.query(pEntity, pBody, { params: {}, headers: {}, query: {}, UserSession: pUserSession }, fCallback);
};

const bucketCounts = (pEnvelope, pKey) =>
{
	let tmpCounts = {};
	pEnvelope.Facets[pKey].Buckets.forEach((pBucket) => { tmpCounts[pBucket.Key] = pBucket.Count; });
	return tmpCounts;
};

suite
(
	'Facet-Host-ApplicationServer-Unit',
	() =>
	{
		suite
		(
			'the host on a stub RetoldApplicationServer (no database)',
			() =>
			{
				test('discovery: DALs, endpoints, model and service server come from the server object; the coverage classes follow the layer marker, never Endpoints − Exclude (§74, §75.1–§75.2)',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						let tmpServiceServer = recordingServiceServer();
						tmpServer.fable.Orator = { serviceServer: tmpServiceServer };
						let tmpBound = bindNow(tmpServer, standardFaceting());
						Expect(tmpBound.Error).to.equal(null);
						let tmpHost = tmpBound.Host;
						Expect(tmpHost).to.be.an.instanceof(libRetoldFacetingHostDataService);
						Expect(tmpHost.isBound()).to.equal(true);
						Expect(tmpHost.getHostKind()).to.equal('ApplicationServer');
						Expect(tmpHost.getApplicationServer()).to.equal(tmpServer);
						Expect(tmpHost.getModelSync()).to.equal(tmpServer.MeadowModel);
						Expect(tmpHost.getServiceServer()).to.equal(tmpServiceServer);
						// NoAutoCRUD tables have a DAL (listEntities) but no route-bound controller.
						Expect(tmpHost.listEntities()).to.include('Hidden');
						Expect(tmpHost.getDAL('Hidden')).to.equal(tmpServer.DAL.Hidden);
						Expect(tmpHost.getRouteBoundController('Hidden')).to.equal(null);
						Expect(tmpHost.getRouteBoundController('Widget')).to.equal(tmpServer.Endpoints.Widget._Controller);
						Expect(tmpHost.getExecutionDAL('Widget')).to.equal(tmpServer.DAL.Widget);
						Expect(tmpHost.getDialectProfile('Widget')).to.deep.equal({ Name: 'SQLite', Provider: 'SQLite', Supported: true });
						Expect(tmpHost.getPrimaryKey('Widget')).to.equal('IDWidget');
						Expect(tmpHost.getDeleteColumn('Widget')).to.equal('Deleted');

						let tmpSnapshot = tmpHost.tenancySnapshot();
						Expect(tmpSnapshot.Phase).to.equal('Hook');
						Expect(tmpSnapshot.Source).to.equal('Marker');
						Expect(tmpSnapshot.Column).to.equal('IDCustomer');
						Expect(Array.from(tmpSnapshot.Installed).sort()).to.deep.equal([ 'Account', 'Broken', 'Denied', 'DeniedNote', 'Gadget', 'Widget' ]);
						Expect(Array.from(tmpSnapshot.Excluded).sort()).to.deep.equal([ 'Customer', 'TenantNote', 'WidgetType' ]);
						Expect(tmpSnapshot.DeniedPrefixes).to.deep.equal([ '/1.0/Denied' ]);
						Expect(tmpSnapshot.PersonalScopes).to.deep.equal({ Widget: { Column: 'OwnerIDUser', SessionField: 'IDUser', CustomGetValue: false } });
						Expect(tmpSnapshot.Classes).to.deep.equal(
							{
								Customer: COVERAGE.Excluded,
								Widget: COVERAGE.Installed,
								Gadget: COVERAGE.Installed,
								WidgetType: COVERAGE.Excluded,
								TenantNote: COVERAGE.Excluded,
								Hidden: COVERAGE.Controllerless,
								Denied: COVERAGE.Installed,
								DeniedNote: COVERAGE.Installed,
								Broken: COVERAGE.Misconfigured,
								Stray: COVERAGE.Unguarded,
								Lookup: COVERAGE.Unguarded,
								Account: COVERAGE.Installed
							});
						Expect(tmpHost.tenancyCoverage('Widget')).to.equal(COVERAGE.Installed);
						Expect(tmpHost.tenancyCoverage('NoSuchTable')).to.equal(COVERAGE.Controllerless);
						Expect(tmpHost.fenceProfile()).to.deep.equal({ Swap: { IS: '=' } });

						// Boot warnings name the misconfigured and the unguarded-with-column tables.
						Expect(tmpBound.Warnings.some((pWarning) => { return pWarning.indexOf('Broken') >= 0 && pWarning.indexOf('Misconfigured') >= 0; })).to.equal(true);
						Expect(tmpBound.Warnings.some((pWarning) => { return pWarning.indexOf('Stray') >= 0 && pWarning.indexOf('no tenancy layer') >= 0; })).to.equal(true);
					});

				test('the RAFS-1 export wins over the marker when the server has tenancyScopedEntities(); a throwing export refuses the bind (§75.1)',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						tmpServer.tenancyScopedEntities = () => { return [ 'Widget', 'Stray' ]; };
						let tmpBound = bindNow(tmpServer, standardFaceting());
						Expect(tmpBound.Error).to.equal(null);
						Expect(tmpBound.Host.tenancySnapshot().Source).to.equal('Export');
						Expect(tmpBound.Host.tenancyCoverage('Stray')).to.equal(COVERAGE.Installed);
						// Gadget carries the marker but the host said it did not install it there.
						Expect(tmpBound.Host.tenancyCoverage('Gadget')).to.equal(COVERAGE.Unguarded);
						Expect(tmpBound.Host.isFacetable('Gadget')).to.equal(false);

						let tmpThrowing = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						tmpThrowing.tenancyScopedEntities = () => { throw new Error('not ready'); };
						let tmpRefused = bindNow(tmpThrowing, standardFaceting());
						Expect(tmpRefused.Error.Code).to.equal('FACET_INTERNAL');
						Expect(tmpRefused.Error.message).to.contain('not ready');
						Expect(tmpRefused.Host.isBound()).to.equal(false);
						Expect(tmpRefused.Host.isFacetable('Widget')).to.equal(false);
					});

				test('the scope policy comes from tenancyConfig(): Column, SessionField = Column, Exclude = every non-Installed entity, PersonalScopes only on Installed entities (§75.3)',
					() =>
					{
						let tmpTenancy = standardTenancy();
						// A personal scope on a table tenancy did not guard never reaches the policy.
						tmpTenancy.PersonalScopes.Stray = { Column: 'OwnerIDUser', SessionField: 'IDUser' };
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: tmpTenancy });
						let tmpHost = bindNow(tmpServer, standardFaceting({ Scope: { Required: { Gadget: [ { Column: 'Name', From: '$CurrentUser.Name' } ] }, UserRecordFields: [ 'IDUser', 'IDCustomer', 'Name' ] } })).Host;
						let tmpPolicy = tmpHost.getScopePolicy();
						Expect(tmpPolicy.Kind).to.equal('Policy');
						Expect(tmpPolicy.Column).to.equal('IDCustomer');
						Expect(tmpPolicy.SessionField).to.equal('IDCustomer');
						Expect(tmpPolicy.Guard).to.equal('Strict');
						Expect(tmpPolicy.Exclude.slice().sort()).to.deep.equal([ 'Broken', 'Customer', 'Hidden', 'Lookup', 'Stray', 'TenantNote', 'WidgetType' ]);
						Expect(tmpPolicy.PersonalScopes).to.deep.equal({ Widget: { Column: 'OwnerIDUser', SessionField: 'OwnerIDUser' } });
						Expect(tmpPolicy.isScoped('Widget')).to.equal(true);
						Expect(tmpPolicy.isScoped('WidgetType')).to.equal(false);
						Expect(tmpPolicy.isScoped('Stray')).to.equal(false);
						let tmpPrincipal = { ScopeValues: { IDCustomer: 1, OwnerIDUser: 7, Name: 'n' } };
						Expect(tmpPolicy.requiredFor('Widget', tmpPrincipal)).to.deep.equal([ { Column: 'IDCustomer', Value: 1 }, { Column: 'OwnerIDUser', Value: 7 } ]);
						Expect(tmpPolicy.requiredFor('Gadget', tmpPrincipal)).to.deep.equal([ { Column: 'IDCustomer', Value: 1 }, { Column: 'Name', Value: 'n' } ]);
						Expect(tmpPolicy.requiredFor('Lookup', tmpPrincipal)).to.deep.equal([]);
						Expect(tmpHost.getScopePolicy()).to.equal(tmpPolicy);
						// Change capture reads the same classes (internal-contracts §41.2).
						Expect(tmpHost.entityScopeColumns('Widget').Kind).to.equal('Personal');
						Expect(tmpHost.entityScopeColumns('Gadget').Kind).to.equal('Tenant');
						Expect(tmpHost.entityScopeColumns('Stray').Kind).to.equal('Global');
						Expect(tmpHost.entityScopeColumns('TenantNote').TenantColumn).to.equal(null);
						Expect(tmpHost.scopeAssurance()).to.equal('Guarded');
						Expect(tmpHost.scopeAssurance('Lookup')).to.equal('Global');
					});

				test('isFacetable (§78): NoAutoCRUD, DeniedPrefixes (indexOf semantics, endpoint version), Exclude / global opt-in, unguarded with the column, misconfigured, NEVER_FACETABLE, NeverFacet, Reads off',
					() =>
					{
						let tmpTables = standardTables();
						tmpTables.Versioned = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded', Version: '2.0' };
						tmpTables.NoReads = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded', Reads: false };
						tmpTables.Muted = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' };
						// Its MeadowSchema.Scope differs from the model key: meadow-endpoints mounted it at /1.0/DeniedRenamed.
						tmpTables.Renamed = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded', Scope: 'DeniedRenamed' };
						let tmpTenancy = standardTenancy();
						tmpTenancy.DeniedPrefixes.push('/2.0/Versioned');
						let tmpServer = stubServer({ Tables: tmpTables, Tenancy: tmpTenancy });
						let tmpBound = bindNow(tmpServer, standardFaceting({ Catalog: { GlobalEntities: [ 'WidgetType', 'Lookup', 'Stray', 'Hidden', 'Broken' ], NeverFacet: [ 'Muted' ] } }));
						Expect(tmpBound.Error).to.equal(null);
						let tmpHost = tmpBound.Host;
						let tmpExpected =
						{
							Widget: true, Gadget: true,                // Installed
							WidgetType: true, Lookup: true,            // Global by opt-in
							TenantNote: false,                         // Excluded, not opted in
							Stray: false,                              // Unguarded with the column, even when listed
							Hidden: false,                             // NoAutoCRUD (Controllerless), even when listed
							Broken: false,                             // Misconfigured, even when listed
							Denied: false, DeniedNote: false,          // '/1.0/Denied' hides both
							Renamed: false,                            // its real route /1.0/DeniedRenamed is denied (RAFS 404s it)
							Versioned: false,                          // '/2.0/Versioned' on a 2.0 endpoint
							NoReads: false,                            // Reads routes not connected
							Muted: false,                              // Catalog.NeverFacet
							Account: false,                            // NEVER_FACETABLE
							Customer: false,                           // the tenant root (keyed by IDCustomer), global here: rule 5
							NoSuchTable: false
						};
						Object.keys(tmpExpected).forEach((pEntity) => { Expect(tmpHost.isFacetable(pEntity), pEntity).to.equal(tmpExpected[pEntity]); });
						Expect(tmpHost.isFacetable('Widget; DROP')).to.equal(false);
						// Principal-independent.
						Expect(tmpHost.isFacetable('Widget', { Kind: 'Anonymous' })).to.equal(true);
						// The route name differs from the model key: warned at bind.
						Expect(tmpBound.Warnings.some((pWarning) => { return (pWarning.indexOf('Renamed') >= 0) && (pWarning.indexOf('/1.0/DeniedRenamed') >= 0); })).to.equal(true);
						Expect(libRetoldFacetingHostApplicationServer.deniedByPrefixes('Renamed', [ '/1.0/Denied' ], '1.0', '/1.0/DeniedRenamed')).to.equal(true);
						Expect(libRetoldFacetingHostApplicationServer.deniedByPrefixes('Renamed', [ '/1.0/Denied' ], '1.0')).to.equal(false);
						Expect(libRetoldFacetingHostApplicationServer.deniedByPrefixes('Renamed', [ '/1.0/Renameds' ], '1.0', '/1.0/Other')).to.equal(true);

						// An ARRAY NoAutoCRUDTables never matched in RAFS (it mounted public routes, a warning), but
						// the app meant to hide those tables: never facetable, even guarded or listed as global.
						let tmpArrayServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						tmpArrayServer.NoAutoCRUDTables = [ 'Gadget', 'Lookup' ];
						let tmpArray = bindNow(tmpArrayServer, standardFaceting());
						Expect(tmpArray.Error).to.equal(null);
						Expect(tmpArray.Host.getRouteBoundController('Gadget')).to.not.equal(null);
						Expect(tmpArray.Host.isFacetable('Gadget')).to.equal(false);
						Expect(tmpArray.Host.isFacetable('Lookup')).to.equal(false);
						Expect(tmpArray.Host.isFacetable('Widget')).to.equal(true);
						Expect(tmpArray.Warnings.some((pWarning) => { return (pWarning.indexOf('NoAutoCRUDTables is an array') >= 0) && (pWarning.indexOf('never facetable') >= 0); })).to.equal(true);
					});

				test('root and identity tables are never facetable while Global, and listing one in GlobalEntities refuses the boot: the tenancy-keyed root, Customer / User, tenancyConfig() Root/IdentityTable, membership, entitlements, auth, a manifest; Installed ones are ordinary (§78 rule 5)',
					() =>
					{
						let fBind = (pSpec, pGlobal, pTenancyExtra) =>
						{
							let tmpTables = standardTables();
							tmpTables.Persona = { Columns: [ NAME_COLUMN ], Mount: 'Plain' };
							tmpTables.Login = { Columns: [ NAME_COLUMN ], Mount: 'Plain' };
							tmpTables.User = { Columns: [ NAME_COLUMN ], Mount: 'Plain' };
							let tmpTenancy = Object.assign(standardTenancy(), pTenancyExtra || {});
							tmpTenancy.Exclude = tmpTenancy.Exclude.concat([ 'Persona', 'Login', 'User' ]);
							return bindNow(stubServer(Object.assign({ Tables: tmpTables, Tenancy: tmpTenancy }, pSpec)), standardFaceting({ Catalog: { GlobalEntities: pGlobal } }));
						};
						let fRefuses = (pSpec, pEntity, pTenancyExtra) =>
						{
							let tmpBound = fBind(pSpec, [ 'Lookup', pEntity ], pTenancyExtra);
							Expect(tmpBound.Error, `${pEntity} ${JSON.stringify(Object.keys(pSpec))}`).to.be.an('error');
							Expect(tmpBound.Error.message).to.contain('root / identity');
							Expect(tmpBound.Error.message).to.contain(pEntity);
						};
						let fAccepts = (pSpec, pEntity, pTenancyExtra) =>
						{
							let tmpBound = fBind(pSpec, [ 'Lookup', pEntity ], pTenancyExtra);
							Expect(tmpBound.Error, `${pEntity} ${JSON.stringify(Object.keys(pSpec))}`).to.equal(null);
							Expect(tmpBound.Host.isFacetable(pEntity), pEntity).to.equal(true);
						};
						// Always, with tenancy: the table keyed by the tenancy column (Customer: IDCustomer) and a
						// 'User' table; Persona / Login are ordinary global tables without another rule.
						fRefuses({}, 'Customer');
						fRefuses({}, 'User');
						fAccepts({}, 'Persona');
						fAccepts({}, 'Login');
						// Unlisted, they are simply not facetable (Global needs the opt-in).
						let tmpUnlisted = fBind({}, [ 'Lookup' ]);
						Expect(tmpUnlisted.Error).to.equal(null);
						Expect(tmpUnlisted.Host.isFacetable('Customer')).to.equal(false);
						Expect(tmpUnlisted.Host.isFacetable('Lookup')).to.equal(true);
						// tenancyConfig() RootTable / IdentityTable.
						fRefuses({}, 'Login', { IdentityTable: 'Login' });
						fRefuses({}, 'Persona', { RootTable: 'Persona' });
						// Membership.
						let tmpMembership = { Membership: { CustomerTable: 'Customer', AccountTable: 'Login', PersonaTable: 'Persona', SystemAdminField: 'SystemRole', SystemAdminValue: 'root' } };
						fRefuses(tmpMembership, 'Login');
						fRefuses(tmpMembership, 'Persona');
						// entitlements IdentityTable.
						let tmpEntitlements = { Entitlements: standardEntitlements({ IdentityTable: 'Persona', ExcludeEntities: [ 'Customer', 'Login', 'Persona', 'Lookup' ] }), EntitlementsModule: fakeEntitlementsModule({}) };
						fRefuses(tmpEntitlements, 'Persona');
						fAccepts(tmpEntitlements, 'Login');
						// Auth.Local.
						fRefuses({ Auth: { Local: { UserTable: 'Login', MembershipTable: 'Persona' } } }, 'Login');
						fRefuses({ Auth: { Local: { UserTable: 'Login', MembershipTable: 'Persona' } } }, 'Persona');
						// A manifest's tenancy root / identity (unless ScopeRootAndIdentity).
						fRefuses({ Manifest: { Tenancy: { RootTable: 'Customer', IdentityTable: 'Persona' } } }, 'Persona');
						fAccepts({ Manifest: { Tenancy: { ScopeRootAndIdentity: true } } }, 'Persona');

						// Kit shape: Customer guarded by tenancy is an ordinary scoped entity even with membership on;
						// listing it in GlobalEntities is only a "not Global here" warning.
						let tmpTables = standardTables();
						tmpTables.Customer.Mount = 'Guarded';
						let tmpTenancy = standardTenancy();
						tmpTenancy.Exclude = [ 'WidgetType', 'TenantNote' ];
						let tmpKit = bindNow(stubServer({ Tables: tmpTables, Tenancy: tmpTenancy, Membership: { CustomerTable: 'Customer', AccountTable: 'Login', PersonaTable: 'Persona' } }), standardFaceting({ Catalog: { GlobalEntities: [ 'Customer' ] } }));
						Expect(tmpKit.Error).to.equal(null);
						Expect(tmpKit.Host.tenancyCoverage('Customer')).to.equal(COVERAGE.Installed);
						Expect(tmpKit.Host.isFacetable('Customer')).to.equal(true);
						Expect(tmpKit.Warnings.some((pWarning) => { return pWarning.indexOf('GlobalEntities names Customer, which is not Global here') >= 0; })).to.equal(true);
					});

				test('without tenancyConfig(): every entity is None, the policy is Scope.Required only, facetable as on plain RDS, no fence swap (§75.2, §78 rule 4)',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: null });
						let tmpBound = bindNow(tmpServer, {});
						Expect(tmpBound.Error).to.equal(null);
						let tmpHost = tmpBound.Host;
						Expect(tmpHost.tenancySnapshot().Source).to.equal('None');
						Expect(tmpHost.tenancyCoverage('Widget')).to.equal(COVERAGE.None);
						Expect(tmpHost.tenancyCoverage('Hidden')).to.equal(COVERAGE.None);
						Expect(tmpHost.getScopePolicy().Kind).to.equal('None');
						Expect(tmpHost.scopeAssurance()).to.equal('Unscoped');
						Expect(tmpHost.fenceProfile()).to.equal(null);
						Expect(tmpHost.isFacetable('Widget')).to.equal(true);
						Expect(tmpHost.isFacetable('Stray')).to.equal(true);
						Expect(tmpHost.isFacetable('Hidden')).to.equal(false);
						Expect(tmpHost.isFacetable('Denied')).to.equal(true);
						Expect(tmpBound.Warnings.some((pWarning) => { return pWarning.indexOf(`'Unscoped'`) >= 0; })).to.equal(true);
						let tmpPrincipal = resolveNow(tmpHost, { UserRecord: { IDUser: 4, IDCustomer: 2 } }).Principal;
						Expect(tmpPrincipal.Kind).to.equal('User');
						Expect(tmpPrincipal.IDCustomer).to.equal(2);
						Expect(tmpPrincipal.ScopeValues).to.deep.equal({});

						// A Scope.Required-only policy: Required entities scoped, the rest only via GlobalEntities.
						let tmpRequired = bindNow(stubServer({ Tables: standardTables(), Tenancy: null }), { Scope: { Required: { Widget: [ { Column: 'IDCustomer', From: '$CurrentUser.IDCustomer' } ] } }, Catalog: { GlobalEntities: [ 'Lookup' ] } }).Host;
						Expect(tmpRequired.getScopePolicy().Kind).to.equal('Policy');
						Expect(tmpRequired.isFacetable('Widget')).to.equal(true);
						Expect(tmpRequired.isFacetable('Lookup')).to.equal(true);
						Expect(tmpRequired.isFacetable('Gadget')).to.equal(false);
					});

				test('bind refusals (§73.5): not a RAFS, Role, a Scope.Policy object, Guard Off / Repair with tenancy, an unguarded Scope.Behavior, an unknown Strategy, personal-scope column conflicts on guarded entities only, a hook that ran too early, a second server',
					() =>
					{
						let fRefused = (pServer, pOptions, pText) =>
						{
							let tmpBound = bindNow(pServer, pOptions);
							Expect(tmpBound.Error, pText).to.be.an('error');
							Expect(tmpBound.Error.Code).to.equal('FACET_INTERNAL');
							Expect(tmpBound.Error.message).to.contain(pText);
							Expect(tmpBound.Host.isBound()).to.equal(false);
							Expect(tmpBound.Host.isFacetable('Widget')).to.equal(false);
							Expect(tmpBound.Host.tenancySnapshot()).to.equal(null);
							return tmpBound;
						};
						let fStandard = () => { return stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }); };

						let tmpHost = new libRetoldFacetingHostApplicationServer(libBuilders.newFable('RetoldFacetingRAFSRefusals'), {});
						tmpHost.bind({ fable: {} }, (pError) => { Expect(pError.message).to.contain('needs a RetoldApplicationServer'); });

						fRefused(fStandard(), { Role: 'Agent' }, `Role 'Agent'`);
						fRefused(fStandard(), { Scope: { Policy: { Column: 'IDCustomer' } } }, 'tenancyConfig()');
						fRefused(fStandard(), { Scope: { Guard: 'Off' } }, `Scope.Guard 'Off'`);
						// Strict only with tenancy: Repair would fill in a displaced RAFS guard on the facet side.
						fRefused(fStandard(), { Scope: { Guard: 'Repair' } }, `Scope.Guard 'Repair'`);
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: null }), { Scope: { Guard: 'Repair' } }).Error).to.equal(null);
						fRefused(fStandard(), { Authorization: { Strategy: 'Roles' } }, 'Authorization.Strategy');
						// Every Installed entity is captured through a behavior RAFS tenancy guards.
						fRefused(fStandard(), { Scope: { Behavior: 'Custom-QueryConfiguration' } }, 'Scope.Behavior is Custom-QueryConfiguration');
						fRefused(fStandard(), { Scope: { BehaviorOverrides: { Gadget: 'Custom-QueryConfiguration' } } }, 'Scope.BehaviorOverrides.Gadget');
						Expect(bindNow(fStandard(), { Scope: { BehaviorOverrides: { Gadget: 'Count-QueryConfiguration', WidgetType: 'Custom-QueryConfiguration' } } }).Error).to.equal(null);

						let tmpSameColumn = standardTenancy();
						tmpSameColumn.PersonalScopes.Gadget = { Column: 'IDCustomer' };
						fRefused(stubServer({ Tables: standardTables(), Tenancy: tmpSameColumn }), {}, 'uses the tenancy column');
						let tmpConflict = standardTenancy();
						tmpConflict.PersonalScopes.Gadget = { Column: 'OwnerIDUser', SessionField: 'IDPersona' };
						fRefused(stubServer({ Tables: standardTables(), Tenancy: tmpConflict }), {}, 'share the column OwnerIDUser');
						// Entries RAFS never evaluates (an excluded table, an unguarded one) never fail the boot.
						let tmpUnused = standardTenancy();
						tmpUnused.PersonalScopes.TenantNote = { Column: 'OwnerIDUser', SessionField: 'IDPersona' };
						tmpUnused.PersonalScopes.Stray = { Column: 'IDCustomer' };
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpUnused }), {}).Error).to.equal(null);
						// App getValue functions cannot be compared: accepted (the first entry's is used for the column,
						// the guard asserts the others), with a warning that they must agree.
						let tmpFunctions = standardTenancy();
						tmpFunctions.PersonalScopes.Widget.getValue = (pSession) => { return pSession.UserRecord.IDUser; };
						tmpFunctions.PersonalScopes.Gadget = { Column: 'OwnerIDUser', getValue: (pSession) => { return pSession.UserRecord.IDUser; } };
						let tmpFunctionsBound = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpFunctions }), {});
						Expect(tmpFunctionsBound.Error).to.equal(null);
						Expect(tmpFunctionsBound.Warnings.some((pWarning) => { return (pWarning.indexOf('share the column OwnerIDUser') >= 0) && (pWarning.indexOf('must agree') >= 0); })).to.equal(true);
						// The same source twice is fine (no warning).
						let tmpShared = standardTenancy();
						tmpShared.PersonalScopes.Gadget = { Column: 'OwnerIDUser', SessionField: 'IDUser' };
						let tmpSharedBound = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpShared }), {});
						Expect(tmpSharedBound.Error).to.equal(null);
						Expect(tmpSharedBound.Warnings.some((pWarning) => { return pWarning.indexOf('must agree') >= 0; })).to.equal(false);

						// The hook installer ran too early (seedSteps / preSchemaSteps): endpoints without any tenancy
						// layer although tenancyConfig() is set, or membershipConfig() without the stamped MembershipConfig.
						let tmpEarlyTables = standardTables();
						Object.keys(tmpEarlyTables).forEach((pName) => { if (tmpEarlyTables[pName].Mount === 'Guarded') { tmpEarlyTables[pName].Mount = 'Plain'; } });
						fRefused(stubServer({ Tables: tmpEarlyTables, Tenancy: standardTenancy() }), {}, '_mountTenancy');
						let tmpEarlyMembership = fStandard();
						tmpEarlyMembership.membershipConfig = () => { return { AccountTable: 'Login' }; };
						fRefused(tmpEarlyMembership, {}, '_mountMembership');
						tmpEarlyMembership.MembershipConfig = { AccountTable: 'Login' };
						Expect(bindNow(tmpEarlyMembership, standardFaceting()).Error).to.equal(null);

						// One host binds one server.
						let tmpBound = bindNow(fStandard(), {});
						Expect(tmpBound.Error).to.equal(null);
						tmpBound.Host.bind(fStandard(), (pError) => { Expect(pError.message).to.contain('different RetoldApplicationServer'); });
						tmpBound.Host.bind(tmpBound.Host.getApplicationServer(), (pError) => { Expect(pError).to.equal(undefined); });
						// A refused re-bind leaves nothing half-bound (fail closed).
						let tmpServer = tmpBound.Host.getApplicationServer();
						tmpServer.tenancyConfig = () => { throw new Error('tenancy hook broke'); };
						tmpBound.Host.bind(tmpServer, (pError) => { Expect(pError.message).to.contain('tenancy hook broke'); });
						Expect(tmpBound.Host.isBound()).to.equal(false);
						Expect(tmpBound.Host.getApplicationServer()).to.equal(null);
						Expect(tmpBound.Host.isFacetable('Widget')).to.equal(false);
					});

				test('bind refusals (§73.5): header sessions (AllowHeaderSession is not accepted on RAFS); entitlements without a module (a Strategy function too) or without the fields RAFS reads raw, Strategy None, a colliding RoutePrefix',
					() =>
					{
						let tmpTables = standardTables();
						tmpTables.Gadget.Settings = { MeadowEndpointsSessionDataSource: 'Header' };
						let tmpHeader = bindNow(stubServer({ Tables: tmpTables, Tenancy: standardTenancy() }), {});
						Expect(tmpHeader.Error.message).to.contain(`MeadowEndpointsSessionDataSource is 'Header'`);
						// The principal and the guard would read different sessions: refused even when "allowed".
						let tmpAllowed = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Options: { MeadowEndpointsSessionDataSource: 'Header' } }), { Scope: { AllowHeaderSession: true } });
						Expect(tmpAllowed.Error.message).to.contain('AllowHeaderSession is not accepted here');
						Expect(tmpAllowed.Host.isBound()).to.equal(false);

						let tmpEntitlements = standardEntitlements();
						let tmpNoModule = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements }), {});
						Expect(tmpNoModule.Error.message).to.contain('no Retold-Entitlements module');
						// A Strategy function only narrows the entitlements check, so it needs the module too.
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements }), { Authorization: { Strategy: () => { return true; } } }).Error.message).to.contain('no Retold-Entitlements module');
						// The persona fields RAFS reads with no default must be configured.
						[ 'IdentityUserField', 'IdentityAccountField', 'TenantField' ].forEach(
							(pField) =>
							{
								let tmpPartial = standardEntitlements();
								delete tmpPartial[pField];
								let tmpMissing = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpPartial, EntitlementsModule: fakeEntitlementsModule({}) }), {});
								Expect(tmpMissing.Error.message, pField).to.contain(`lacks [${pField}]`);
							});
						// The module can come from Authorization.Entitlements.
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements }), { Authorization: { Entitlements: fakeEntitlementsModule({}) } }).Error).to.equal(null);
						let tmpModule = fakeEntitlementsModule({});
						let tmpNone = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }), { Authorization: { Strategy: 'None' } });
						Expect(tmpNone.Error.message).to.contain(`Strategy 'None'`);
						// 'None' without entitlements is fine (no authorizer).
						let tmpNoneAlone = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), { Authorization: { Strategy: 'None' } });
						Expect(tmpNoneAlone.Error).to.equal(null);
						Expect(tmpNoneAlone.Host.getAuthorizer()).to.equal(null);

						let fPrefix = (pRoutePrefix) =>
						{
							return bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }), { RoutePrefix: pRoutePrefix }).Error;
						};
						Expect(fPrefix('/1.0/Facet')).to.equal(null);
						Expect(fPrefix('/1.0/Widget').message).to.contain('Widget.<verb>');
						Expect(fPrefix('/1.0/Gadgets/Facet').message).to.contain('Gadget.<verb>');
						// '/1.0' puts the entity itself right after the prefix: /1.0/Widget/Query → Widget.create.
						Expect(fPrefix('/1.0').message).to.contain('RoutePrefix');
						Expect(fPrefix('/api/Facet')).to.equal(null);
						// Without entitlements there is no gate to collide with.
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), { RoutePrefix: '/1.0/Widget' }).Error).to.equal(null);
					});

				test('bind warnings (§73.5): a NoAutoCRUDTables array, a DeniedPrefixes entry over the RoutePrefix, AllowAnonymous on an Installed entity, GlobalEntities naming a scoped entity, Controllerless declarations',
					() =>
					{
						let tmpTenancy = standardTenancy();
						tmpTenancy.DeniedPrefixes.push('/1.0/Fac');
						let tmpBound = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpTenancy, NoAutoCRUDArray: true }),
							{ Catalog: { GlobalEntities: [ 'Widget', 'WidgetType' ], AllowAnonymous: [ 'Gadget' ], Controllerless: { Hidden: { AuthorizeAs: 'Widget.read' } } } });
						Expect(tmpBound.Error).to.equal(null);
						let fWarned = (pText) => { return tmpBound.Warnings.some((pWarning) => { return pWarning.indexOf(pText) >= 0; }); };
						Expect(fWarned('NoAutoCRUDTables is an array')).to.equal(true);
						Expect(fWarned('/1.0/Fac')).to.equal(true);
						Expect(fWarned('AllowAnonymous names Gadget')).to.equal(true);
						Expect(fWarned('GlobalEntities names Widget')).to.equal(true);
						Expect(fWarned('GlobalEntities names WidgetType')).to.equal(false);
						Expect(fWarned('Controllerless declarations [Hidden]')).to.equal(true);
					});

				test('the principal (§76.1): from pRequest.UserSession through the tenancy getValue functions; Kind, IDUser, IDCustomer, ScopeValues, UserRecord, RoleSetHash, Platform; frozen; the same key as a write (§76.4)',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						let tmpHost = bindNow(tmpServer, standardFaceting({ Scope: { UserRecordFields: [ 'IDUser', 'IDCustomer', 'Email' ] } })).Host;
						let tmpSession = { SessionID: 's-1', UserRecord: { IDCustomer: 1, IDUser: 7, Email: 'a@b.c', Password: 'never' } };
						let tmpResolved = resolveNow(tmpHost, tmpSession);
						Expect(tmpResolved.Error).to.equal(null);
						let tmpPrincipal = tmpResolved.Principal;
						Expect(tmpPrincipal.Kind).to.equal('User');
						Expect(tmpPrincipal.Source).to.equal('InProcess');
						Expect(tmpPrincipal.IDUser).to.equal(7);
						Expect(tmpPrincipal.IDCustomer).to.equal(1);
						Expect(tmpPrincipal.ScopeValues).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 7 });
						Expect(tmpPrincipal.UserRecord).to.deep.equal({ IDUser: 7, IDCustomer: 1, Email: 'a@b.c' });
						Expect(tmpPrincipal.RoleSetHash).to.equal('');
						Expect(tmpPrincipal.Platform).to.equal(false);
						Expect(Object.isFrozen(tmpPrincipal)).to.equal(true);
						Expect(tmpPrincipal.Actions).to.equal(undefined);
						// The write's principal (the intake Actor) from the same UserSession has the same key; pSessionData is ignored.
						let tmpWrite = tmpHost.buildPrincipal({ LoggedIn: true, CustomerID: 99, UserID: 99 }, { UserSession: tmpSession });
						Expect(libRetoldFacetingUtil.principalKey(tmpWrite)).to.equal(libRetoldFacetingUtil.principalKey(tmpPrincipal));
						Expect(tmpWrite.RoleSetHash).to.equal('');
						// The guard reads the meadow-endpoints-extended copy of the session: same values.
						let tmpExtended = Object.assign({ LoggedIn: false, UserID: 0 }, tmpSession);
						Expect(resolveNow(tmpHost, tmpExtended).Principal.ScopeValues).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 7 });

						// Anonymous: UserSession {} (the tenancy pre-handler's anonymous session) and no request at all.
						let tmpAnonymous = resolveNow(tmpHost, {}).Principal;
						Expect(tmpAnonymous.Kind).to.equal('Anonymous');
						// The guard never calls getValue for it; the columns read as Retold-Tenancy's anonymous default (0: unset).
						Expect(tmpAnonymous.ScopeValues).to.deep.equal({ IDCustomer: 0, OwnerIDUser: 0 });
						let tmpNoRequest = null;
						tmpHost.resolvePrincipal(null, (pError, pPrincipal) => { tmpNoRequest = pPrincipal; });
						Expect(tmpNoRequest.Kind).to.equal('Anonymous');
						Expect(tmpHost.buildPrincipal({ LoggedIn: true, UserID: 3 }, null).Kind).to.equal('Anonymous');
					});

				test(`the principal uses the app's own getValue functions (called only for an authenticated session, as the guard does); one that throws is FACET_INTERNAL`,
					() =>
					{
						let tmpCalls = [];
						let tmpTenancy = standardTenancy();
						tmpTenancy.Column = 'IDCustomer';
						tmpTenancy.getValue = (pSession) => { tmpCalls.push('tenant'); return pSession.UserRecord.TenantRef * 10; };
						tmpTenancy.PersonalScopes.Widget = { Column: 'OwnerIDUser', getValue: (pSession) => { tmpCalls.push('owner'); return pSession.UserRecord.PersonaRef; } };
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpTenancy }), standardFaceting()).Host;
						let tmpPrincipal = resolveNow(tmpHost, { UserRecord: { TenantRef: 3, PersonaRef: 12 } }).Principal;
						Expect(tmpPrincipal.ScopeValues).to.deep.equal({ IDCustomer: 30, OwnerIDUser: 12 });
						Expect(tmpPrincipal.IDCustomer).to.equal(30);
						Expect(tmpCalls).to.deep.equal([ 'tenant', 'owner' ]);
						tmpCalls.length = 0;
						Expect(resolveNow(tmpHost, {}).Principal.Kind).to.equal('Anonymous');
						Expect(tmpCalls).to.deep.equal([]);

						let tmpThrowing = standardTenancy();
						tmpThrowing.getValue = () => { throw new Error('no tenant'); };
						let tmpThrowHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpThrowing }), standardFaceting()).Host;
						let tmpResolved = resolveNow(tmpThrowHost, { UserRecord: { IDCustomer: 1 } });
						Expect(tmpResolved.Error.Code).to.equal('FACET_INTERNAL');
						Expect(tmpResolved.Principal).to.equal(null);
						Expect(() => { tmpThrowHost.buildPrincipal(null, { UserSession: { UserRecord: { IDCustomer: 1 } } }); }).to.throw('no tenant');
					});

				test('tenant 0 and anonymous are 401 FACET_UNAUTHENTICATED on every route; owner 0 only where the entity needs it (root 401, other references denied); a throwing personal getValue fails only its entities; a scoped session passes (§75.5, §76.2)',
					() =>
					{
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), standardFaceting()).Host;
						let fCode = (pSession, pEntity) =>
						{
							let tmpGate = gateNow(tmpHost, pSession, pEntity || 'Widget');
							return tmpGate.Error ? tmpGate.Error.Code : 'OK';
						};
						Expect(fCode({ UserRecord: { IDCustomer: 1, IDUser: 7 } })).to.equal('OK');
						// A membership-less login: an authenticated tenant-0 session (RAFS lists answer it over tenant-0 rows).
						Expect(fCode({ UserRecord: { IDCustomer: 0, IDUser: 7 } })).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({ UserRecord: { IDUser: 7 } })).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({ UserRecord: { IDCustomer: '0', IDUser: 7 } })).to.equal('FACET_UNAUTHENTICATED');
						// Owner 0 (no persona: entitlements off and no IDUser on the record) — no DAL fallback.  The owner
						// column is Widget's (its PersonalScopes entry): 401 with Widget as the root …
						Expect(fCode({ UserRecord: { IDCustomer: 1 } })).to.equal('FACET_UNAUTHENTICATED');
						// … but not on an entity that does not need it (RAFS's Gadget list answers that session too).
						Expect(fCode({ UserRecord: { IDCustomer: 1 } }, 'Gadget')).to.equal('OK');
						Expect(fCode({ UserRecord: { IDCustomer: 1 } }, 'WidgetType')).to.equal('OK');
						// The tenant-0 401 never depends on the entity (unknown and hidden look the same).
						Expect(fCode({ UserRecord: { IDCustomer: 0, IDUser: 7 } }, 'NoSuchTable')).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({ UserRecord: { IDCustomer: 0, IDUser: 7 } }, 'Gadget')).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({})).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({}, 'WidgetType')).to.equal('FACET_UNAUTHENTICATED');
						// Referenced elsewhere (a hop, a scope, a label target), Widget is denied for the owner-0 principal.
						let tmpOwnerZero = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1 } }).Principal;
						let tmpAuthorizer = new libRetoldFacetingAuthorizer(tmpHost.fable, tmpHost.options);
						let tmpContext = { Host: tmpHost, Principal: tmpOwnerZero, Options: tmpHost.options };
						Expect(tmpAuthorizer.canRead(tmpContext, 'Widget')).to.equal(false);
						Expect(tmpAuthorizer.canRead(tmpContext, 'Gadget')).to.equal(true);
						Expect(tmpAuthorizer.canRead({ Host: tmpHost, Principal: resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal, Options: tmpHost.options }, 'Widget')).to.equal(true);

						// A personal getValue that throws: only the entities that need that column fail (500 as the root,
						// denied elsewhere); the error is logged once.
						let tmpThrowing = standardTenancy();
						tmpThrowing.PersonalScopes.Widget.getValue = () => { throw new Error('persona store down'); };
						let tmpThrowHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpThrowing }), standardFaceting()).Host;
						let tmpErrors = [];
						tmpThrowHost.fable.log.error = (pMessage) => { tmpErrors.push(String(pMessage)); };
						let tmpThrowGate = (pEntity) =>
						{
							let tmpGate = gateNow(tmpThrowHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }, pEntity);
							return tmpGate.Error ? tmpGate.Error.Code : 'OK';
						};
						Expect(tmpThrowGate('Widget')).to.equal('FACET_INTERNAL');
						Expect(tmpThrowGate('Gadget')).to.equal('OK');
						Expect(tmpThrowGate('WidgetType')).to.equal('OK');
						let tmpUnresolved = resolveNow(tmpThrowHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal;
						Expect(tmpUnresolved.UnresolvedScopeColumns).to.deep.equal([ 'OwnerIDUser' ]);
						Expect(Object.keys(tmpUnresolved)).to.not.include('UnresolvedScopeColumns');
						Expect(tmpAuthorizer.canRead({ Host: tmpThrowHost, Principal: tmpUnresolved, Options: tmpThrowHost.options }, 'Widget')).to.equal(false);
						Expect(tmpAuthorizer.canRead({ Host: tmpThrowHost, Principal: tmpUnresolved, Options: tmpThrowHost.options }, 'Gadget')).to.equal(true);
						Expect(tmpErrors.filter((pMessage) => { return pMessage.indexOf('persona store down') >= 0; })).to.have.lengthOf(1);
						// A platform principal in tenant 0 is still 401.
						let tmpPlatformHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Membership: { SystemAdminField: 'SystemRole', SystemAdminValue: 'root' } }), standardFaceting()).Host;
						let tmpPlatformGate = gateNow(tmpPlatformHost, { UserRecord: { IDCustomer: 0, IDUser: 7, SystemRole: 'root' } }, 'Widget');
						Expect(tmpPlatformGate.Error.Code).to.equal('FACET_UNAUTHENTICATED');
					});

				test('entitlements (§77.2): <E>.read per referenced entity, ExcludeEntities need only authentication, Controllerless never, RequireAction on every entity; RoleSetHash and the non-enumerable Actions',
					() =>
					{
						let tmpModule = fakeEntitlementsModule(
							{
								'7|1': [ 'Widget.read', 'Hidden.read', 'Report.export' ],
								'8|1': [ 'Gadget.read' ],
								'9|1': []
							});
						let tmpEntitlements = standardEntitlements({ ExcludeEntities: [ 'WidgetType' ] });
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule });
						let tmpHost = bindNow(tmpServer, standardFaceting()).Host;
						let tmpAuthorizer = tmpHost.getAuthorizer();
						Expect(tmpAuthorizer.Strategy).to.equal('Entitlements');

						let tmpReader = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal;
						let tmpOther = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 8 } }).Principal;
						let tmpNobody = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 9 } }).Principal;
						Expect(tmpReader.RoleSetHash).to.match(/^r:[0-9a-f]{12}$/);
						Expect(tmpReader.RoleSetHash).to.equal(libRetoldFacetingHostApplicationServer.roleSetHash(new Set([ 'Report.export', 'Hidden.read', 'Widget.read' ])));
						Expect(tmpOther.RoleSetHash).to.not.equal(tmpReader.RoleSetHash);
						Expect(tmpNobody.RoleSetHash).to.match(/^r:[0-9a-f]{12}$/);
						Expect(tmpReader.Actions.has('Widget.read')).to.equal(true);
						Expect(Object.keys(tmpReader)).to.not.include('Actions');
						Expect(JSON.stringify(tmpReader)).to.not.contain('Widget.read');
						// Different role sets → different principal keys (cache Gate), the same identity (read-your-writes).
						Expect(libRetoldFacetingUtil.principalKey(tmpReader)).to.not.equal(libRetoldFacetingUtil.principalKey(Object.assign({}, tmpReader, { RoleSetHash: tmpOther.RoleSetHash })));

						Expect(tmpAuthorizer.canRead('Widget', tmpReader)).to.equal(true);
						Expect(tmpAuthorizer.canRead('Gadget', tmpReader)).to.equal(false);
						Expect(tmpAuthorizer.canRead('Gadget', tmpOther)).to.equal(true);
						Expect(tmpAuthorizer.canRead('Widget', tmpOther)).to.equal(false);
						// ExcludeEntities: ungated (the RAFS gate maps it to nothing) — any authenticated principal.
						Expect(tmpAuthorizer.canRead('WidgetType', tmpNobody)).to.equal(true);
						// Global data is not a bypass: a gated global entity needs its read.
						Expect(tmpAuthorizer.canRead('Lookup', tmpReader)).to.equal(false);
						// Not in pServer.Endpoints: never, whatever the grant.
						Expect(tmpAuthorizer.canRead('Hidden', tmpReader)).to.equal(false);
						Expect(tmpAuthorizer.canRead('Widget', { Kind: 'User' })).to.equal(false);
						Expect(tmpAuthorizer.canRead('Widget', null)).to.equal(false);

						// Through the service Authorizer (fails closed, AllowAnonymous rule first).
						let tmpServiceAuthorizer = new libRetoldFacetingAuthorizer(tmpServer.fable, tmpHost.options);
						Expect(tmpServiceAuthorizer.canRead({ Host: tmpHost, Principal: tmpReader, Options: tmpHost.options }, 'Widget')).to.equal(true);
						Expect(tmpServiceAuthorizer.canRead({ Host: tmpHost, Principal: tmpOther, Options: tmpHost.options }, 'Widget')).to.equal(false);

						// RequireAction applies to every entity, ExcludeEntities included.
						let tmpRequire = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }), standardFaceting({ Authorization: { RequireAction: 'Report.export' } })).Host;
						let tmpRequireReader = resolveNow(tmpRequire, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal;
						let tmpRequireOther = resolveNow(tmpRequire, { UserRecord: { IDCustomer: 1, IDUser: 8 } }).Principal;
						Expect(tmpRequire.getAuthorizer().canRead('Widget', tmpRequireReader)).to.equal(true);
						Expect(tmpRequire.getAuthorizer().canRead('Gadget', tmpRequireOther)).to.equal(false);
						Expect(tmpRequire.getAuthorizer().canRead('WidgetType', tmpRequireOther)).to.equal(false);

						// With entitlements a Strategy function only narrows the RAFS gate (it is asked only for entities the
						// principal can read); `() => true` cannot widen it.  The actions are resolved for RoleSetHash.
						let tmpSeen = [];
						let tmpFunctionHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }),
							standardFaceting({ Authorization: { Strategy: (pEntity, pPrincipal) => { tmpSeen.push(pEntity); return pEntity !== 'WidgetType'; } } })).Host;
						let tmpFunctionPrincipal = resolveNow(tmpFunctionHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal;
						Expect(tmpFunctionPrincipal.RoleSetHash).to.equal(tmpReader.RoleSetHash);
						Expect(tmpFunctionHost.getAuthorizer().Strategy).to.equal('EntitlementsAndFunction');
						Expect(tmpFunctionHost.getAuthorizer().canRead('Widget', tmpFunctionPrincipal)).to.equal(true);
						Expect(tmpFunctionHost.getAuthorizer().canRead('Gadget', tmpFunctionPrincipal)).to.equal(false);
						Expect(tmpFunctionHost.getAuthorizer().canRead('WidgetType', tmpFunctionPrincipal)).to.equal(false);
						Expect(tmpSeen).to.deep.equal([ 'Widget', 'WidgetType' ]);
						let tmpWide = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }),
							standardFaceting({ Authorization: { Strategy: () => { return true; } } })).Host;
						Expect(tmpWide.getAuthorizer().canRead('Gadget', resolveNow(tmpWide, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal)).to.equal(false);
						// ExcludeEntities need an authenticated principal (never an anonymous one).
						Expect(tmpAuthorizer.canRead('WidgetType', { Kind: 'Anonymous' })).to.equal(false);
						// Without entitlements a function decides alone.
						let tmpAlone = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), standardFaceting({ Authorization: { Strategy: (pEntity) => { return pEntity === 'Gadget'; } } })).Host;
						Expect(tmpAlone.getAuthorizer().Strategy).to.equal('Function');
						Expect(tmpAlone.getAuthorizer().canRead('Gadget', { Kind: 'User' })).to.equal(true);
						Expect(tmpAlone.getAuthorizer().canRead('Widget', { Kind: 'User' })).to.equal(false);
					});

				test('the action set is resolved once per persona (IDUser|IDCustomer) and cached for EntitlementCacheMS; 0 disables; IDUser 0 is the empty set; a resolution error is FACET_INTERNAL (§77.3)',
					() =>
					{
						let tmpModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ], '17|2': [ 'Gadget.read' ] });
						let tmpEntitlements = standardEntitlements();
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }), standardFaceting({ Authorization: { EntitlementCacheMS: 10000 } })).Host;
						resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						Expect(tmpModule.Calls).to.deep.equal([ [ 7, 1 ] ]);
						// A tenant switch changes the persona key: a fresh resolution, never the old tenant's set.
						let tmpSwitched = resolveNow(tmpHost, { UserRecord: { IDCustomer: 2, IDUser: 17 } }).Principal;
						Expect(tmpSwitched.Actions.has('Gadget.read')).to.equal(true);
						Expect(tmpSwitched.Actions.has('Widget.read')).to.equal(false);
						Expect(tmpModule.Calls).to.deep.equal([ [ 7, 1 ], [ 17, 2 ] ]);
						// No persona yet (IDUser 0): the empty set, no read.
						let tmpNoPersona = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 0 } }).Principal;
						Expect(tmpNoPersona.Actions.size).to.equal(0);
						Expect(tmpModule.Calls).to.have.lengthOf(2);
						// A consumer mutating its principal's set does not reach the cache.
						let tmpPrincipal = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal;
						tmpPrincipal.Actions.add('Gadget.read');
						Expect(resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }).Principal.Actions.has('Gadget.read')).to.equal(false);

						// The default (0): resolved on every request, as RAFS's own gate does; with a warning when positive.
						let tmpUncachedModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ] });
						let tmpUncachedBound = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpUncachedModule }), standardFaceting());
						let tmpUncached = tmpUncachedBound.Host;
						resolveNow(tmpUncached, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						resolveNow(tmpUncached, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						Expect(tmpUncachedModule.Calls).to.have.lengthOf(2);
						Expect(tmpUncachedBound.Warnings.some((pWarning) => { return pWarning.indexOf('EntitlementCacheMS') >= 0; })).to.equal(false);
						Expect(bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpUncachedModule }), standardFaceting({ Authorization: { EntitlementCacheMS: 5000 } })).Warnings.some((pWarning) => { return pWarning.indexOf('cached per process') >= 0; })).to.equal(true);

						let tmpFailing = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: fakeEntitlementsModule({}, { Fail: true }) }), standardFaceting()).Host;
						let tmpResolved = resolveNow(tmpFailing, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						Expect(tmpResolved.Error.Code).to.equal('FACET_INTERNAL');
						Expect(tmpResolved.Principal).to.equal(null);
					});

				test('invalidation (§77.3, §79.3): installChangeIntake subscribes RAFSEntitlements; a role-table event drops its tenants, * drops all, other entities nothing; a resolution racing an invalidation is not stored',
					() =>
					{
						let tmpControl = {};
						let tmpModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ], '17|2': [ 'Gadget.read' ] }, tmpControl);
						let tmpEntitlements = standardEntitlements();
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Entitlements: tmpEntitlements, EntitlementsModule: tmpModule }), standardFaceting({ Authorization: { EntitlementCacheMS: 10000 } })).Host;
						let tmpSubscribers = new Map();
						let tmpIntake = { subscribe: (pName, fListener) => { tmpSubscribers.set(pName, fListener); } };
						Expect(tmpHost.installChangeIntake(tmpIntake)).to.equal(true);
						Expect(Array.from(tmpSubscribers.keys())).to.deep.equal([ libRetoldFacetingHostApplicationServer.ENTITLEMENT_SUBSCRIBER ]);
						let fEvent = tmpSubscribers.get('RAFSEntitlements');

						let fPrime = () =>
						{
							resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
							resolveNow(tmpHost, { UserRecord: { IDCustomer: 2, IDUser: 17 } });
						};
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(2);
						fEvent({ Entity: 'Widget', Tenants: [ 1 ] });
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(2);
						fEvent({ Entity: 'UserRole', Tenants: [ 1 ] });
						fPrime();
						Expect(tmpModule.Calls.slice(2)).to.deep.equal([ [ 7, 1 ] ]);
						Expect(tmpHost.onEntitlementChange({ Entity: 'RoleAction', Tenants: [ '*' ] })).to.equal(2);
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(5);

						// A resolution in flight when a revocation lands: answered, but not cached.
						tmpHost.clearEntitlementCache();
						tmpControl.Defer = [];
						let tmpLate = null;
						tmpHost.resolvePrincipal({ UserSession: { UserRecord: { IDCustomer: 1, IDUser: 7 } } }, (pError, pPrincipal) => { tmpLate = pPrincipal; });
						Expect(tmpLate).to.equal(null);
						fEvent({ Entity: 'UserAction', Tenants: [ 1 ] });
						tmpControl.Defer.shift()();
						Expect(tmpLate.Actions.has('Widget.read')).to.equal(true);
						delete tmpControl.Defer;
						resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						Expect(tmpModule.Calls).to.have.lengthOf(7);

						// Without entitlements nothing is subscribed.
						let tmpPlain = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), standardFaceting()).Host;
						Expect(tmpPlain.installChangeIntake(tmpIntake)).to.equal(false);
					});

				test('invalidation does not depend on facetability (§79.3): every write through a role table\'s DAL — NeverFacet, NoAutoCRUD, DAL-direct, armed or not — drops the cached action sets and revalidates open streams; the wrapper sits under the intake\'s and is installed once',
					() =>
					{
						let tmpModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ] });
						let tmpTables = standardTables();
						// UserRole mounted and guarded but NeverFacet; UserAction NoAutoCRUD (a DAL, no endpoint).
						tmpTables.UserRole = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Guarded' };
						tmpTables.UserAction = { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'None' };
						let tmpServer = stubServer({ Tables: tmpTables, Tenancy: standardTenancy(), Entitlements: standardEntitlements(), EntitlementsModule: tmpModule });
						let tmpWrites = [];
						[ 'UserRole', 'UserAction', 'Gadget' ].forEach(
							(pTable) =>
							{
								let tmpDAL = tmpServer.DAL[pTable];
								[ 'doCreate', 'doUpdate', 'doDelete', 'doUndelete' ].forEach(
									(pMethod) =>
									{
										tmpDAL[pMethod] = function (pQuery, fCallback) { tmpWrites.push(`${pTable}.${pMethod}`); return fCallback(null, pQuery, pQuery, { ID: 1 }); };
									});
							});
						let tmpRevalidations = 0;
						tmpServer.fable.RetoldFacetingSSE = { revalidateAll: () => { tmpRevalidations++; return 0; } };
						let tmpHost = bindNow(tmpServer, standardFaceting({ Authorization: { EntitlementCacheMS: 10000 }, Catalog: { GlobalEntities: [ 'WidgetType' ], NeverFacet: [ 'UserRole' ] } })).Host;
						Expect(tmpHost.isFacetable('UserRole')).to.equal(false);
						Expect(tmpHost.isFacetable('UserAction')).to.equal(false);
						let tmpWrapMarker = libRetoldFacetingHostApplicationServer.ENTITLEMENT_WRAP_MARKER;
						Expect(!!tmpServer.DAL.UserRole.doDelete[tmpWrapMarker]).to.equal(true);
						Expect(!!tmpServer.DAL.UserAction.doCreate[tmpWrapMarker]).to.equal(true);
						// Only the role tables are wrapped.
						Expect(!!tmpServer.DAL.Gadget.doCreate[tmpWrapMarker]).to.equal(false);

						let fPrime = () => { resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } }); };
						fPrime();
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(1);
						// A DAL write on another table changes nothing.
						tmpServer.DAL.Gadget.doDelete({}, () => { });
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(1);
						Expect(tmpRevalidations).to.equal(0);
						// A revocation through the (non-facetable) UserRole route's DAL, and a DAL-direct UserAction deny.
						let tmpResult = null;
						tmpServer.DAL.UserRole.doDelete({ Q: 1 }, (pError, pQuery, pRead, pRecord) => { tmpResult = [ pError, pQuery, pRecord ]; });
						Expect(tmpResult).to.deep.equal([ null, { Q: 1 }, { ID: 1 } ]);
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(2);
						Expect(tmpRevalidations).to.equal(1);
						tmpServer.DAL.UserAction.doCreate({}, () => { });
						fPrime();
						Expect(tmpModule.Calls).to.have.lengthOf(3);
						Expect(tmpRevalidations).to.equal(2);
						Expect(tmpWrites).to.deep.equal([ 'Gadget.doDelete', 'UserRole.doDelete', 'UserAction.doCreate' ]);

						// The write's tenants, from its query, scope the drop: a create names them in its records, a delete
						// through RAFS's guard in its top-level '=' stanza; anything unprovable drops everything.
						let fQuery = (pRecords, pFilters) => { return { query: { records: pRecords }, parameters: { filter: pFilters } }; };
						let fStanza = (pColumn, pOperator, pValue, pConnector) => { return { Column: pColumn, Operator: pOperator, Value: pValue, Connector: pConnector || 'AND', Parameter: pColumn }; };
						let tmpFence = [ fStanza('', '(', ''), fStanza('IDUserRole', '=', 4), fStanza('', ')', ''), fStanza('IDCustomer', '=', 2) ];
						Expect(tmpHost._roleWriteTenants('UserRole', 'doCreate', fQuery([ { IDCustomer: 2, IDUser: 9 } ], []))).to.deep.equal([ 2 ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doCreate', fQuery([ { IDCustomer: 2 }, { IDUser: 9 } ], []))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', fQuery([], tmpFence))).to.deep.equal([ 2 ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', fQuery([], [ fStanza('IDUserRole', '=', 4) ]))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', fQuery([], [ fStanza('IDUserRole', '=', 4), fStanza('IDCustomer', '=', 2, 'OR') ]))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', fQuery([], [ fStanza('IDCustomer', 'IN', [ 1, 2 ]) ]))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', fQuery([], [ fStanza('', '(', ''), fStanza('IDCustomer', '=', 2), fStanza('', ')', '') ]))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doUpdate', fQuery([ { IDCustomer: 3 } ], tmpFence))).to.deep.equal([ 2, 3 ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doUpdate', fQuery([ { IDCustomer: 3 } ], []))).to.deep.equal([ '*' ]);
						Expect(tmpHost._roleWriteTenants('UserRole', 'doDelete', null)).to.deep.equal([ '*' ]);
						let tmpTenantModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ], '17|2': [ 'Gadget.read' ] });
						let tmpTenantServer = stubServer({ Tables: tmpTables, Tenancy: standardTenancy(), Entitlements: standardEntitlements(), EntitlementsModule: tmpTenantModule });
						tmpTenantServer.DAL.UserRole.doCreate = function (pQuery, fCallback) { return fCallback(null, pQuery, pQuery, {}); };
						let tmpRevalidated = [];
						tmpTenantServer.fable.RetoldFacetingSSE = { revalidateAll: (pTenants) => { tmpRevalidated.push(pTenants); return 0; } };
						let tmpTenantHost = bindNow(tmpTenantServer, standardFaceting({ Authorization: { EntitlementCacheMS: 10000 } })).Host;
						resolveNow(tmpTenantHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						resolveNow(tmpTenantHost, { UserRecord: { IDCustomer: 2, IDUser: 17 } });
						tmpTenantServer.DAL.UserRole.doCreate(fQuery([ { IDCustomer: 2, IDUser: 17, IDRole: 1 } ], []), () => { });
						resolveNow(tmpTenantHost, { UserRecord: { IDCustomer: 1, IDUser: 7 } });
						resolveNow(tmpTenantHost, { UserRecord: { IDCustomer: 2, IDUser: 17 } });
						// Only tenant 2's set was re-read; only tenant 2's streams were revalidated.
						Expect(tmpTenantModule.Calls).to.deep.equal([ [ 7, 1 ], [ 17, 2 ], [ 17, 2 ] ]);
						Expect(tmpRevalidated).to.deep.equal([ [ 2 ] ]);

						// Idempotent, also when the change intake wrapped on top (its marker carries the original).
						let fOurs = tmpServer.DAL.UserRole.doCreate;
						let fIntakeWrapper = function (pQuery, fCallback) { return fOurs.call(this, pQuery, fCallback); };
						Object.defineProperty(fIntakeWrapper, Symbol.for('RetoldFaceting.Intake'), { value: { Original: fOurs } });
						tmpServer.DAL.UserRole.doCreate = fIntakeWrapper;
						let tmpIntake = { subscribe: () => { } };
						Expect(tmpHost.installChangeIntake(tmpIntake)).to.equal(true);
						Expect(tmpServer.DAL.UserRole.doCreate).to.equal(fIntakeWrapper);
						Expect(tmpHost._wrapRoleTableDALs()).to.deep.equal([]);
						// A method replaced since is wrapped again.
						tmpServer.DAL.UserRole.doUpdate = function (pQuery, fCallback) { return fCallback(null); };
						Expect(tmpHost._wrapRoleTableDALs()).to.deep.equal([ 'UserRole.doUpdate' ]);
					});

				test('the platform principal (§77.4): Membership SystemAdminField === SystemAdminValue on the UserRecord; the default admin authorizer accepts only it',
					() =>
					{
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Membership: { CustomerTable: 'Customer', AccountTable: 'Account', PersonaTable: 'Persona', SystemAdminField: 'SystemRole', SystemAdminValue: 'root' } }), standardFaceting()).Host;
						let tmpRoot = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7, SystemRole: 'root' } }).Principal;
						let tmpOwner = resolveNow(tmpHost, { UserRecord: { IDCustomer: 1, IDUser: 7, SystemRole: 'owner' } }).Principal;
						Expect(tmpRoot.Platform).to.equal(true);
						Expect(tmpOwner.Platform).to.equal(false);
						Expect(tmpHost.isPlatformPrincipal(tmpRoot)).to.equal(true);
						Expect(tmpHost.isPlatformPrincipal(tmpOwner)).to.equal(false);
						Expect(tmpHost.isPlatformPrincipal(null)).to.equal(false);
						// Platform never changes the scope.
						Expect(tmpRoot.ScopeValues).to.deep.equal(tmpOwner.ScopeValues);
						Expect(libRetoldFacetingInstallers.platformAdminAuthorize({}, tmpRoot)).to.equal(true);
						Expect(libRetoldFacetingInstallers.platformAdminAuthorize({}, tmpOwner)).to.equal(false);
						Expect(libRetoldFacetingInstallers.platformAdminAuthorize({}, null)).to.equal(false);
						// Membership defaults (SystemRole / root) and no membership at all.
						let tmpDefaults = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy(), Membership: {} }), standardFaceting()).Host;
						Expect(resolveNow(tmpDefaults, { UserRecord: { IDCustomer: 1, IDUser: 7, SystemRole: 'root' } }).Principal.Platform).to.equal(true);
						let tmpNoMembership = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), standardFaceting()).Host;
						Expect(resolveNow(tmpNoMembership, { UserRecord: { IDCustomer: 1, IDUser: 7, SystemRole: 'root' } }).Principal.Platform).to.equal(false);
					});

				test('rawWriterEntities (§79.2): membership, entitlement role tables, record grants, comms, profile, Reconcile.RawWriterEntities',
					() =>
					{
						let tmpHost = bindNow(stubServer(
							{
								Tables: standardTables(),
								Tenancy: standardTenancy(),
								Membership: { CustomerTable: 'Customer', AccountTable: 'Account', PersonaTable: 'Persona' },
								Entitlements: standardEntitlements({ IdentityTable: 'Account' }),
								EntitlementsModule: fakeEntitlementsModule({}),
								RecordLevel: { GrantTable: 'RecordGrant' },
								Comms: { OutboxTable: 'MessageOutbox', DevInboxTable: 'MessageDevInbox', TemplateTable: null, ChallengeTable: 'LoginChallenge', NotificationPrefTable: 'UserNotificationPref', AccountTable: 'Account', PersonaTable: null },
								Profile: {},
								Auth: { Local: { UserTable: 'Login', MembershipTable: 'Membership' } }
							}), standardFaceting({ Reconcile: { RawWriterEntities: [ 'Imported' ] } })).Host;
						Expect(tmpHost.rawWriterEntities()).to.deep.equal(
							[ 'Customer', 'Account', 'Persona', 'Role', 'RoleAction', 'UserRole', 'UserAction', 'RecordGrant', 'MessageOutbox', 'MessageDevInbox', 'LoginChallenge', 'UserNotificationPref', 'Membership', 'Login', 'Imported' ]);
						let tmpPlain = bindNow(stubServer({ Tables: standardTables(), Tenancy: standardTenancy() }), standardFaceting()).Host;
						Expect(tmpPlain.rawWriterEntities()).to.deep.equal([]);
					});

				test('captureLateMounts (§73.4): endpoints registered after the hook phase are captured once, classified, the listeners told; after the route phase a new endpoint is never facetable and warned once',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						let tmpHost = bindNow(tmpServer, standardFaceting({ Catalog: { GlobalEntities: [ 'LateGlobal', 'LateTenant' ] } })).Host;
						let tmpPolicy = tmpHost.getScopePolicy();
						let tmpNotified = [];
						tmpHost.onModelChanged((pModel) => { tmpNotified.push(pModel); });
						// An app route installer mounts two endpoints after tenancy (no layer).
						mountStubTable(tmpServer, 'LateGlobal', { Columns: [ NAME_COLUMN ], Mount: 'Plain' });
						mountStubTable(tmpServer, 'LateTenant', { Columns: [ TENANT_COLUMN, NAME_COLUMN ], Mount: 'Plain' });
						Expect(tmpHost.isFacetable('LateGlobal')).to.equal(false);
						Expect(tmpHost.captureLateMounts().sort()).to.deep.equal([ 'LateGlobal', 'LateTenant' ]);
						Expect(tmpNotified).to.have.lengthOf(1);
						Expect(tmpNotified[0]).to.equal(tmpServer.MeadowModel);
						Expect(tmpHost.tenancySnapshot().Phase).to.equal('Routes');
						Expect(tmpHost.tenancyCoverage('LateGlobal')).to.equal(COVERAGE.Unguarded);
						Expect(tmpHost.tenancyCoverage('LateTenant')).to.equal(COVERAGE.Unguarded);
						Expect(tmpHost.isFacetable('LateGlobal')).to.equal(true);
						Expect(tmpHost.isFacetable('LateTenant')).to.equal(false);
						Expect(tmpHost.getScopePolicy()).to.not.equal(tmpPolicy);
						Expect(tmpHost.getScopePolicy().Exclude).to.include('LateGlobal');
						Expect(tmpHost.captureLateMounts()).to.deep.equal([]);
						Expect(tmpNotified).to.have.lengthOf(1);

						// After the route phase: a straggler stays unfacetable, and the log names it once.
						let tmpWarnings = [];
						tmpServer.fable.log.warn = (pMessage) => { tmpWarnings.push(String(pMessage)); };
						mountStubTable(tmpServer, 'Straggler', { Columns: [ NAME_COLUMN ], Mount: 'Plain' });
						Expect(tmpHost.isFacetable('Straggler')).to.equal(false);
						Expect(tmpHost.isFacetable('Straggler')).to.equal(false);
						Expect(tmpWarnings.filter((pWarning) => { return pWarning.indexOf('Straggler') >= 0; })).to.have.lengthOf(1);
						// An unbound host captures nothing.
						Expect(new libRetoldFacetingHostApplicationServer(tmpServer.fable, {}).captureLateMounts()).to.deep.equal([]);
					});

				test('captureLateMounts follows coverage that changed between the phases (an app hook guarding a captured endpoint) even with no late mount; a late controller with header sessions refuses the route phase (§73.4)',
					() =>
					{
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: standardTenancy() });
						let tmpHost = bindNow(tmpServer, standardFaceting()).Host;
						let tmpNotified = 0;
						tmpHost.onModelChanged(() => { tmpNotified++; });
						Expect(tmpHost.tenancyCoverage('TenantNote')).to.equal(COVERAGE.Excluded);
						Expect(tmpHost.isFacetable('TenantNote')).to.equal(false);
						// An app route installer put a tenancy layer on the excluded TenantNote: no endpoint is new.
						tmpServer.Endpoints.TenantNote._Controller.BehaviorInjection[MARKER] = [ {} ];
						Expect(tmpHost.captureLateMounts()).to.deep.equal([]);
						Expect(tmpNotified).to.equal(1);
						Expect(tmpHost.tenancyCoverage('TenantNote')).to.equal(COVERAGE.Installed);
						Expect(tmpHost.isFacetable('TenantNote')).to.equal(true);
						Expect(tmpHost.getScopePolicy().isScoped('TenantNote')).to.equal(true);
						// Nothing changed: nobody is told.
						tmpHost.captureLateMounts();
						Expect(tmpNotified).to.equal(1);
						Expect(tmpHost.routePhaseRefusal()).to.equal(null);

						// A controller mounted between the phases that sources sessions from a header.
						mountStubTable(tmpServer, 'HeaderLate', { Columns: [ NAME_COLUMN ], Mount: 'Plain', Settings: { MeadowEndpointsSessionDataSource: 'Header' } });
						tmpHost.captureLateMounts();
						Expect(tmpHost.routePhaseRefusal()).to.contain(`MeadowEndpointsSessionDataSource is 'Header'`);
						Expect(tmpHost.isBound()).to.equal(false);
						Expect(tmpHost.isFacetable('Widget')).to.equal(false);
					});

				test('an authenticating app without tenancyConfig() (§76.1, 06 §5.1 rule 5): the session comes from RAFS\'s own OratorAuthentication when no pre-handler set one, anonymous is 401 on every route (AllowAnonymous aside), ExcludeEntities need a User; the bind warns',
					() =>
					{
						let tmpSessions = { 'RetoldSessionID=a': { SessionID: 'a', UserRecord: { IDAccount: 3, IDCustomer: 1, IDUser: 7 } } };
						let tmpLookups = [];
						let tmpServer = stubServer({ Tables: standardTables(), Tenancy: null, Options: { EnableAuthentication: true } });
						tmpServer.fable.OratorAuthentication = (
							{
								resolveSessionForRequest: (pRequest, fCallback) =>
								{
									tmpLookups.push(pRequest.headers.cookie || null);
									return fCallback(null, tmpSessions[pRequest.headers.cookie] || null);
								}
							});
						let tmpBound = bindNow(tmpServer, { Catalog: { AllowAnonymous: [ 'WidgetType' ] } });
						Expect(tmpBound.Error).to.equal(null);
						let tmpHost = tmpBound.Host;
						Expect(tmpHost.authenticationRequired()).to.equal(true);
						Expect(tmpBound.Warnings.some((pWarning) => { return (pWarning.indexOf('no tenancyConfig()') >= 0) && (pWarning.indexOf('OratorAuthentication') >= 0); })).to.equal(true);
						// An HTTP request (the pre-handler never set pRequest.UserSession): the cookie session.
						let tmpPrincipal = null;
						tmpHost.resolvePrincipal({ headers: { cookie: 'RetoldSessionID=a' } }, (pError, pPrincipal) => { tmpPrincipal = pPrincipal; });
						Expect(tmpPrincipal.Kind).to.equal('User');
						Expect(tmpPrincipal.IDUser).to.equal(7);
						Expect(tmpLookups).to.deep.equal([ 'RetoldSessionID=a' ]);
						// In-process: the session the caller passes wins (no lookup).
						Expect(resolveNow(tmpHost, { UserRecord: { IDCustomer: 2, IDUser: 9 } }).Principal.IDUser).to.equal(9);
						Expect(tmpLookups).to.have.lengthOf(1);
						let tmpAnonymous = null;
						tmpHost.resolvePrincipal({ headers: {} }, (pError, pPrincipal) => { tmpAnonymous = pPrincipal; });
						Expect(tmpAnonymous.Kind).to.equal('Anonymous');
						// The 401 rule holds without a scope policy on an authenticating host.
						let fCode = (pSession, pEntity) =>
						{
							let tmpGate = gateNow(tmpHost, pSession, pEntity);
							return tmpGate.Error ? tmpGate.Error.Code : 'OK';
						};
						Expect(fCode({}, 'Widget')).to.equal('FACET_UNAUTHENTICATED');
						Expect(fCode({}, 'WidgetType')).to.equal('OK');
						Expect(fCode({ UserRecord: { IDCustomer: 1, IDUser: 7 } }, 'Widget')).to.equal('OK');
						let tmpAuthorizer = new libRetoldFacetingAuthorizer(tmpHost.fable, tmpHost.options);
						Expect(tmpAuthorizer.canRead({ Host: tmpHost, Principal: tmpAnonymous, Options: tmpHost.options }, 'Widget')).to.equal(false);
						Expect(tmpAuthorizer.canRead({ Host: tmpHost, Principal: tmpAnonymous, Options: tmpHost.options }, 'WidgetType')).to.equal(true);
						Expect(tmpAuthorizer.canRead({ Host: tmpHost, Principal: tmpPrincipal, Options: tmpHost.options }, 'Widget')).to.equal(true);
						// A host that does not authenticate keeps the plain-RDS rule (anonymous facets = anonymous lists).
						let tmpOpen = bindNow(stubServer({ Tables: standardTables(), Tenancy: null }), {}).Host;
						Expect(tmpOpen.authenticationRequired()).to.equal(false);
						Expect(gateNow(tmpOpen, {}, 'Widget').Error).to.equal(null);
					});

				test('the persona is written onto a session no HTTP request enriched, with the module\'s own resolveIDUser, before the principal is built (§76.2); revalidatePrincipal re-reads the session from the tenancy resolver and restores LastAccess (§76.5)',
					() =>
					{
						let tmpModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ] });
						let tmpEnriched = [];
						tmpModule.resolveIDUser = (pServer, pConfig, pSession, fCallback) =>
						{
							tmpEnriched.push(pSession.UserRecord.IDAccount);
							return fCallback(null, (pSession.UserRecord.IDAccount === 3) ? 7 : 0);
						};
						let tmpStore = {};
						let tmpTenancy = standardTenancy();
						tmpTenancy.resolveSession = (pRequest, fCallback) =>
						{
							let tmpSession = tmpStore[pRequest.headers.sid] || null;
							if (tmpSession)
							{
								tmpSession.LastAccess = 999;
							}
							return fCallback(null, tmpSession);
						};
						let tmpHost = bindNow(stubServer({ Tables: standardTables(), Tenancy: tmpTenancy, Entitlements: standardEntitlements(), EntitlementsModule: tmpModule }), standardFaceting()).Host;
						let tmpSession = { UserRecord: { IDAccount: 3, IDCustomer: 1 }, LastAccess: 1 };
						let tmpPrincipal = resolveNow(tmpHost, tmpSession).Principal;
						Expect(tmpEnriched).to.deep.equal([ 3 ]);
						Expect(tmpSession.UserRecord.IDUser).to.equal(7);
						Expect(tmpPrincipal.IDUser).to.equal(7);
						Expect(tmpPrincipal.ScopeValues).to.deep.equal({ IDCustomer: 1, OwnerIDUser: 7 });
						Expect(tmpPrincipal.Actions.has('Widget.read')).to.equal(true);
						// Already enriched: no second lookup.
						resolveNow(tmpHost, tmpSession);
						Expect(tmpEnriched).to.have.lengthOf(1);

						// revalidatePrincipal reads the session again (never the request's snapshot).
						tmpStore.s1 = tmpSession;
						let tmpRequest = { headers: { sid: 's1' }, UserSession: tmpSession };
						let tmpAgain = null;
						tmpHost.revalidatePrincipal(tmpRequest, (pError, pPrincipal) => { tmpAgain = pPrincipal; });
						Expect(tmpAgain.Kind).to.equal('User');
						Expect(libRetoldFacetingUtil.principalKey(tmpAgain)).to.equal(libRetoldFacetingUtil.principalKey(tmpPrincipal));
						// A revalidation is not user activity.
						Expect(tmpSession.LastAccess).to.equal(1);
						// Logged out: the store no longer has it → anonymous (the stream closes).
						delete tmpStore.s1;
						tmpHost.revalidatePrincipal(tmpRequest, (pError, pPrincipal) => { tmpAgain = pPrincipal; });
						Expect(tmpAgain.Kind).to.equal('Anonymous');
						// A resolver error calls back with it.
						tmpTenancy.resolveSession = () => { throw new Error('session store down'); };
						let tmpError = null;
						tmpHost.revalidatePrincipal(tmpRequest, (pError) => { tmpError = pError; });
						Expect(tmpError.message).to.contain('session store down');
					});

				test('before bind everything fails closed: nothing facetable, the authorizer denies, the principal refuses, no policy',
					() =>
					{
						let tmpHost = new libRetoldFacetingHostApplicationServer(libBuilders.newFable('RetoldFacetingRAFSUnbound'), {});
						Expect(tmpHost.isBound()).to.equal(false);
						Expect(tmpHost.isFacetable('Widget')).to.equal(false);
						Expect(tmpHost.getAuthorizer().canRead('Widget', { Kind: 'User' })).to.equal(false);
						Expect(tmpHost.getScopePolicy().Kind).to.equal('None');
						Expect(tmpHost.tenancyCoverage('Widget')).to.equal(COVERAGE.None);
						Expect(tmpHost.rawWriterEntities()).to.deep.equal([]);
						Expect(() => { tmpHost.buildPrincipal({}, { UserSession: {} }); }).to.throw('not bound');
						let tmpError = null;
						tmpHost.resolvePrincipal({ UserSession: { UserRecord: { IDCustomer: 1 } } }, (pError) => { tmpError = pError; });
						Expect(tmpError.Code).to.equal('FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'the foundation installers on a database-backed stub (real meadow DALs and meadow-endpoints, in-memory SQLite)',
			() =>
			{
				let _Booted = [];

				let fBoot = (pSpec, fCallback) =>
				{
					bootDatabaseStub(pSpec,
						(pError, pServer) =>
						{
							if (pServer)
							{
								_Booted.push(pServer);
							}
							return fCallback(pError, pServer);
						});
				};

				teardown
				(
					(fDone) =>
					{
						let tmpServers = _Booted;
						_Booted = [];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpServers.length)
							{
								return fDone();
							}
							let tmpService = tmpServers[pIndex].fable.RetoldFacetingService;
							if (!tmpService || (typeof(tmpService.shutdown) !== 'function'))
							{
								return fNext(pIndex + 1);
							}
							return tmpService.shutdown(() => { return fNext(pIndex + 1); });
						};
						return fNext(0);
					}
				);

				test('boot order through fable Anticipate: the hook phase binds and serves in-process queries, the route phase captures late mounts and mounts the routes; idempotent (§73.1–§73.4)',
					(fDone) =>
					{
						fBoot({ Options: { Faceting: { Catalog: { GlobalEntities: [ 'WidgetType', 'Late' ] } } } },
							(pBootError, pServer) =>
							{
								Expect(pBootError).to.equal(null);
								let tmpServiceServer = pServer.fable.Orator.serviceServer;
								let tmpTrace = [];
								let tmpRoutesAtHook = null;
								let tmpSteps =
								[
									// hookInstallers(): the faceting hook LAST
									libRetoldFacetingInstallers.foundationHookInstaller(pServer, pServer.options.Faceting),
									(fStep) =>
									{
										let tmpService = pServer.fable.RetoldFacetingService;
										tmpTrace.push(`hook:${tmpService._Attached}:${tmpService._RoutesConnected}:${tmpService.Host.getHostKind()}`);
										tmpRoutesAtHook = tmpServiceServer.Routes.length;
										// In-process queries work between the phases.
										facetAs(tmpService, 'Widget', { Facets: [ { Key: 'Color', Facet: 'Widget.Color' } ] }, { UserRecord: { IDCustomer: 1, IDUser: 7 } },
											(pError, pEnvelope) =>
											{
												Expect(pError).to.equal(null);
												Expect(pEnvelope.Total).to.equal(3);
												return fStep();
											});
									},
									// routeInstallers(): an app route that mounts an endpoint, then the faceting route installer LAST
									(fStep) => { pServer.mountLate(); return fStep(); },
									libRetoldFacetingInstallers.foundationRouteInstaller(pServer, pServer.options.Faceting),
									(fStep) => { tmpTrace.push('listen'); return fStep(); }
								];
								runBoot(pServer.fable, tmpSteps,
									(pError) =>
									{
										Expect(pError).to.equal(undefined);
										let tmpService = pServer.fable.RetoldFacetingService;
										Expect(tmpService).to.be.an.instanceof(libRetoldFacetingService);
										Expect(tmpTrace).to.deep.equal([ 'hook:true:false:ApplicationServer', 'listen' ]);
										Expect(tmpRoutesAtHook).to.equal(0);
										Expect(tmpService._RoutesConnected).to.equal(true);
										Expect(tmpService.Host).to.equal(pServer.fable.RetoldFacetingHostApplicationServer);
										Expect(tmpService.options.Catalog.GlobalEntities).to.deep.equal([ 'WidgetType', 'Late' ]);
										Expect(tmpServiceServer.Routes).to.include('POST /1.0/Facet/:Entity/Query');
										Expect(tmpServiceServer.Routes).to.include('GET /1.0/Facet/Describe');
										// The late mount is captured, classified and in the catalog.
										Expect(tmpService.Host.tenancyCoverage('Late')).to.equal(COVERAGE.Unguarded);
										Expect(tmpService.Host.tenancySnapshot().Phase).to.equal('Routes');
										Expect(!!pServer.fable.RetoldFacetingCatalog.getFacetable('Late')).to.equal(true);
										Expect(tmpService.Host.tenancyCoverage('Widget')).to.equal(COVERAGE.Installed);
										// The default admin authorizer is the platform rule (§77.4).
										Expect(tmpService.options.Admin.authorize).to.equal(libRetoldFacetingInstallers.platformAdminAuthorize);
										// The host subscriber order: Generations, ReadYourWrites (RAFSEntitlements only with entitlements).
										Expect(Array.from(pServer.fable.RetoldFacetingChangeIntake._Subscribers.keys()).slice(0, 2)).to.deep.equal([ 'Generations', 'ReadYourWrites' ]);

										// Idempotent: both installers again change nothing.
										let tmpRouteCount = tmpServiceServer.Routes.length;
										runBoot(pServer.fable,
											[
												libRetoldFacetingInstallers.foundationHookInstaller(pServer, pServer.options.Faceting),
												libRetoldFacetingInstallers.foundationRouteInstaller(pServer, pServer.options.Faceting)
											],
											(pAgainError) =>
											{
												Expect(pAgainError).to.equal(undefined);
												Expect(tmpServiceServer.Routes.length).to.equal(tmpRouteCount);
												Expect(pServer.fable.RetoldFacetingService).to.equal(tmpService);
												// stopService closes the service server: the shutdown hook runs first.
												tmpServiceServer.close(
													() =>
													{
														Expect(tmpServiceServer.Closed).to.equal(1);
														return fDone();
													});
											});
									});
							});
					});

				test('in-process facets inherit the host tenancy: each tenant and owner sees only its rows; tenant 0, owner 0 and anonymous are 401; the global table answers anyone authenticated (§75.5, §76)',
					(fDone) =>
					{
						fBoot({},
							(pBootError, pServer) =>
							{
								libRetoldFacetingInstallers.foundationRouteInstaller(pServer, { Catalog: { GlobalEntities: [ 'WidgetType' ] } },
									(pInstallError) =>
									{
										Expect(pInstallError).to.equal(undefined);
										let tmpService = pServer.fable.RetoldFacetingService;
										let tmpBody = { Facets: [ { Key: 'Color', Facet: 'Widget.Color' } ] };
										let tmpCases =
										[
											[ { UserRecord: { IDCustomer: 1, IDUser: 7 } }, null, 3, { Red: 2, Blue: 1 } ],
											[ { UserRecord: { IDCustomer: 1, IDUser: 8 } }, null, 1, { Green: 1 } ],
											[ { UserRecord: { IDCustomer: 2, IDUser: 9 } }, null, 3, { Red: 1, Yellow: 2 } ],
											[ { UserRecord: { IDCustomer: 0, IDUser: 7 } }, 'FACET_UNAUTHENTICATED' ],
											[ { UserRecord: { IDCustomer: 1 } }, 'FACET_UNAUTHENTICATED' ],
											[ {}, 'FACET_UNAUTHENTICATED' ]
										];
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpCases.length)
											{
												return facetAs(tmpService, 'WidgetType', { Facets: [ { Key: 'Name', Facet: 'WidgetType.Name' } ] }, { UserRecord: { IDCustomer: 2, IDUser: 9 } },
													(pError, pEnvelope) =>
													{
														Expect(pError).to.equal(null);
														Expect(pEnvelope.Total).to.equal(2);
														return fDone();
													});
											}
											let tmpCase = tmpCases[pIndex];
											facetAs(tmpService, 'Widget', tmpBody, tmpCase[0],
												(pError, pEnvelope) =>
												{
													if (tmpCase[1])
													{
														Expect(pError, JSON.stringify(tmpCase[0])).to.be.an('error');
														Expect(pError.Code).to.equal(tmpCase[1]);
														return fNext(pIndex + 1);
													}
													Expect(pError, JSON.stringify(tmpCase[0])).to.equal(null);
													Expect(pEnvelope.Total).to.equal(tmpCase[2]);
													Expect(bucketCounts(pEnvelope, 'Color')).to.deep.equal(tmpCase[3]);
													return fNext(pIndex + 1);
												});
										};
										return fNext(0);
									});
							});
					});

				test('entitlements gate the root per referenced entity (404 without <E>.read), ExcludeEntities answer any authenticated principal; the host subscriber follows Generations and ReadYourWrites (§77, §79.3)',
					(fDone) =>
					{
						let tmpModule = fakeEntitlementsModule({ '7|1': [ 'Widget.read' ], '9|2': [ 'Gadget.read' ] });
						fBoot({ Entitlements: standardEntitlements({ UserActionTable: null, ExcludeEntities: [ 'WidgetType' ] }), EntitlementsModule: tmpModule },
							(pBootError, pServer) =>
							{
								// The per-persona cache is off by default (RAFS resolves per request); on here to see it work.
								let tmpFaceting = { Catalog: { GlobalEntities: [ 'WidgetType' ] }, Authorization: { EntitlementCacheMS: 10000 } };
								runBoot(pServer.fable,
									[
										libRetoldFacetingInstallers.foundationHookInstaller(pServer, tmpFaceting),
										libRetoldFacetingInstallers.foundationRouteInstaller(pServer, tmpFaceting)
									],
									(pInstallError) =>
									{
										Expect(pInstallError).to.equal(undefined);
										let tmpService = pServer.fable.RetoldFacetingService;
										Expect(Array.from(pServer.fable.RetoldFacetingChangeIntake._Subscribers.keys()).slice(0, 3)).to.deep.equal([ 'Generations', 'ReadYourWrites', 'RAFSEntitlements' ]);
										let tmpBody = { Facets: [ { Key: 'Color', Facet: 'Widget.Color' } ] };
										facetAs(tmpService, 'Widget', tmpBody, { UserRecord: { IDCustomer: 1, IDUser: 7 } },
											(pReaderError, pReaderEnvelope) =>
											{
												Expect(pReaderError).to.equal(null);
												Expect(pReaderEnvelope.Total).to.equal(3);
												facetAs(tmpService, 'Widget', tmpBody, { UserRecord: { IDCustomer: 2, IDUser: 9 } },
													(pDeniedError) =>
													{
														Expect(pDeniedError.Code).to.equal('FACET_UNKNOWN_ENTITY');
														facetAs(tmpService, 'WidgetType', { Facets: [ { Key: 'Name', Facet: 'WidgetType.Name' } ] }, { UserRecord: { IDCustomer: 2, IDUser: 9 } },
															(pGlobalError, pGlobalEnvelope) =>
															{
																Expect(pGlobalError).to.equal(null);
																Expect(pGlobalEnvelope.Total).to.equal(2);
																// One resolution per persona, cached across requests.
																Expect(tmpModule.Calls).to.deep.equal([ [ 7, 1 ], [ 9, 2 ] ]);
																// A role-table write through the intake drops the tenant's cached set.
																tmpService.Host.onEntitlementChange({ Entity: 'UserRole', Tenants: [ 1 ] });
																facetAs(tmpService, 'Widget', tmpBody, { UserRecord: { IDCustomer: 1, IDUser: 7 } },
																	(pAgainError) =>
																	{
																		Expect(pAgainError).to.equal(null);
																		Expect(tmpModule.Calls).to.deep.equal([ [ 7, 1 ], [ 9, 2 ], [ 7, 1 ] ]);
																		return fDone();
																	});
															});
													});
											});
									});
							});
					});

				test('the route installer alone runs the hook phase first (late mounts are then Unguarded from the start)',
					(fDone) =>
					{
						fBoot({ Options: { Faceting: { Catalog: { GlobalEntities: [ 'Late' ] } } } },
							(pBootError, pServer) =>
							{
								pServer.mountLate();
								runBoot(pServer.fable, [ libRetoldFacetingInstallers.foundationRouteInstaller(pServer) ],
									(pError) =>
									{
										Expect(pError).to.equal(undefined);
										let tmpService = pServer.fable.RetoldFacetingService;
										Expect(tmpService._Attached).to.equal(true);
										Expect(tmpService._RoutesConnected).to.equal(true);
										Expect(tmpService.Host.tenancySnapshot().Phase).to.equal('Routes');
										Expect(tmpService.Host.tenancyCoverage('Late')).to.equal(COVERAGE.Unguarded);
										Expect(tmpService.Host.isFacetable('Late')).to.equal(true);
										return fDone();
									});
							});
					});

				test('install failures fail the boot (no later step runs): a refused bind, Options.Host naming the other host, a raw installer in the array, no service server for the routes',
					(fDone) =>
					{
						fBoot({},
							(pBootError, pServer) =>
							{
								let tmpLaterRan = false;
								runBoot(pServer.fable,
									[
										libRetoldFacetingInstallers.foundationHookInstaller(pServer, { Scope: { Policy: { Column: 'IDCustomer' } } }),
										(fStep) => { tmpLaterRan = true; return fStep(); }
									],
									(pError) =>
									{
										Expect(pError.Code).to.equal('FACET_INTERNAL');
										Expect(pError.message).to.contain('tenancyConfig()');
										Expect(tmpLaterRan).to.equal(false);
										Expect(pServer.fable.RetoldFacetingService._Attached).to.equal(false);
										fBoot({},
											(pSecondError, pSecond) =>
											{
												libRetoldFacetingInstallers.foundationHookInstaller(pSecond, { Host: 'DataService' },
													(pHostError) =>
													{
														Expect(pHostError.message).to.contain(`Options.Host is 'DataService'`);
														fBoot({},
															(pThirdError, pThird) =>
															{
																runBoot(pThird.fable, [ libRetoldFacetingInstallers.foundationRouteInstaller ],
																	(pRawError) =>
																	{
																		Expect(pRawError.message).to.contain('foundationRouteInstaller(this, options)');
																		delete pThird.fable.Orator;
																		delete pThird.fable.OratorServiceServer;
																		libRetoldFacetingInstallers.foundationRouteInstaller(pThird, {},
																			(pNoServerError) =>
																			{
																				Expect(pNoServerError.message).to.contain('no Orator service server');
																				return fDone();
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('the second installer refuses options that differ from the running service\'s (naming the keys); the same object, an equivalent copy, or none pass (§73.2)',
					(fDone) =>
					{
						let tmpOptions = { Catalog: { GlobalEntities: [ 'WidgetType' ] }, Authorization: { Strategy: (pEntity) => { return pEntity !== 'Gadget'; } } };
						let tmpCopy = { Catalog: { GlobalEntities: [ 'WidgetType' ] }, Authorization: { Strategy: (pEntity) => { return pEntity !== 'Gadget'; } } };
						let tmpStricter = { Catalog: { GlobalEntities: [ 'WidgetType' ], NeverFacet: [ 'Gadget' ] }, Scope: { Required: { Widget: [ { Column: 'Color', From: '$CurrentUser.Color' } ] } }, Authorization: { Strategy: (pEntity) => { return pEntity !== 'Gadget'; } } };
						fBoot({},
							(pBootError, pServer) =>
							{
								runBoot(pServer.fable,
									[
										libRetoldFacetingInstallers.foundationHookInstaller(pServer, tmpOptions),
										libRetoldFacetingInstallers.foundationRouteInstaller(pServer, tmpStricter)
									],
									(pError) =>
									{
										Expect(pError.Code).to.equal('FACET_INTERNAL');
										Expect(pError.message).to.contain('foundationRouteInstaller was given options that differ');
										Expect(pError.message).to.contain('Catalog.NeverFacet');
										Expect(pError.message).to.contain('Scope.Required');
										Expect(pServer.fable.RetoldFacetingService._RoutesConnected).to.equal(false);
										runBoot(pServer.fable,
											[
												libRetoldFacetingInstallers.foundationRouteInstaller(pServer, tmpCopy),
												libRetoldFacetingInstallers.foundationRouteInstaller(pServer, tmpOptions),
												libRetoldFacetingInstallers.foundationRouteInstaller(pServer)
											],
											(pSameError) =>
											{
												Expect(pSameError).to.equal(undefined);
												Expect(pServer.fable.RetoldFacetingService._RoutesConnected).to.equal(true);
												Expect(libRetoldFacetingInstallers.optionDifferences({ A: [ 1, 2 ], B: { C: 'x' } }, { A: [ 1, 3 ], B: { C: 'x', D: 1 } })).to.deep.equal([ 'A[1]', 'B.D' ]);
												return fDone();
											});
									});
							});
					});

				test('the shutdown hook is installed by the hook phase: with the route installer missing, fable.Orator.stopService still stops the service first (§73.3)',
					(fDone) =>
					{
						fBoot({},
							(pBootError, pServer) =>
							{
								let tmpLog = [];
								let fInfo = pServer.fable.log.info;
								pServer.fable.log.info = (pMessage) => { tmpLog.push(String(pMessage)); return fInfo.call(pServer.fable.log, pMessage); };
								runBoot(pServer.fable, [ libRetoldFacetingInstallers.foundationHookInstaller(pServer, { Catalog: { GlobalEntities: [ 'WidgetType' ] } }) ],
									(pError) =>
									{
										pServer.fable.log.info = fInfo;
										Expect(pError).to.equal(undefined);
										let tmpService = pServer.fable.RetoldFacetingService;
										Expect(tmpService._RoutesConnected).to.equal(false);
										Expect(tmpLog.some((pMessage) => { return pMessage.indexOf('mount only when foundationRouteInstaller runs') >= 0; })).to.equal(true);
										let tmpShutdowns = 0;
										let fShutdown = tmpService.shutdown;
										tmpService.shutdown = function (fCallback) { tmpShutdowns++; return fShutdown.call(this, fCallback); };
										pServer.fable.Orator.serviceServer.close(
											() =>
											{
												Expect(tmpShutdowns).to.equal(1);
												Expect(pServer.fable.Orator.serviceServer.Closed).to.equal(1);
												return fDone();
											});
									});
							});
					});

				test('attach dispatch: { ApplicationServer, Phase } selects the RAFS host; a bad Phase, both hosts at once, or a second server refuse',
					(fDone) =>
					{
						fBoot({},
							(pBootError, pServer) =>
							{
								pServer.fable.addServiceType('RetoldFacetingService', libRetoldFacetingService);
								let tmpService = pServer.fable.instantiateServiceProvider('RetoldFacetingService', {});
								let tmpBogus = pServer.fable.instantiateServiceProvider('RetoldFacetingService', { Host: 'Bogus' }, 'BogusHost');
								tmpBogus.attach({ ApplicationServer: pServer, Phase: 'Hook' }, (pBogusError) => { Expect(pBogusError.message).to.contain(`Options.Host must be 'Auto'`); });
								tmpService.attach({ ApplicationServer: pServer, Phase: 'Later' },
									(pPhaseError) =>
									{
										Expect(pPhaseError.message).to.contain(`Phase 'Hook' or 'Routes'`);
										tmpService.attach({ ApplicationServer: pServer, RetoldDataService: {} },
											(pBothError) =>
											{
												Expect(pBothError.message).to.contain('one host');
												tmpService.attach({ ApplicationServer: pServer, Phase: 'Hook' },
													(pHookError) =>
													{
														Expect(pHookError).to.equal(undefined);
														Expect(tmpService._Attached).to.equal(true);
														Expect(tmpService._RoutesConnected).to.equal(false);
														fBoot({},
															(pOtherError, pOther) =>
															{
																tmpService.attach({ ApplicationServer: pOther, Phase: 'Routes' },
																	(pOtherServerError) =>
																	{
																		Expect(pOtherServerError.message).to.contain('different host');
																		// Phase omitted: both phases (the route phase completes the attach).
																		tmpService.attach({ ApplicationServer: pServer },
																			(pRoutesError) =>
																			{
																				Expect(pRoutesError).to.equal(undefined);
																				Expect(tmpService._RoutesConnected).to.equal(true);
																				return fDone();
																			});
																	});
															});
													});
											});
									});
							});
					});
			}
		);
	}
);
