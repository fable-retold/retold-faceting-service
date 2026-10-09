/**
 * Host tests (internal-contracts §12): RetoldFacetingHostDataService bound to a REAL plain
 * retold-data-service on in-memory SQLite (port 19101), the scope policy normalization, the
 * principal, the D-31 route-bound controller snapshot across model reloads, bind refusals, the
 * installer (installOnRetoldDataService) and catalog size classes.
 *
 * Boots its own RDS (not the shared harness) with the bookstore model plus an IDTenant column on
 * every table except BookStoreCatalogJoin; only a small Book table is created in SQLite (for the
 * size-class count).  No tenancy behaviors are installed: these tests exercise the host, not scope.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFable = require('fable');
const libRetoldDataService = require('retold-data-service');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libRetoldFacetingHostDataService = require('../source/host/Retold-Faceting-Host-DataService.js');
const libRetoldFacetingHostBase = require('../source/host/Retold-Faceting-Host-Base.js');
const libRetoldFacetingCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
const libRetoldFacetingInstallers = require('../source/Retold-Faceting-Installers.js');

// Registry port 19101 (internal-contracts §14.4); the server binds an ephemeral port read back after start.
const libBuilders = require('./support/Facet-Test-Builders.js');

/**
 * The bookstore model with IDTenant on every table except BookStoreCatalogJoin.
 *
 * @return {Record<string, any>}
 */
const hostModel = () =>
{
	let tmpModel = libBuilders.bookstoreModel('Bookstore');
	Object.keys(tmpModel.Tables).forEach(
		(pTable) =>
		{
			if (pTable === 'BookStoreCatalogJoin')
			{
				return;
			}
			let tmpTable = tmpModel.Tables[pTable];
			tmpTable.Columns.push({ Column: 'IDTenant', DataType: 'Numeric', Size: 'int' });
			tmpTable.MeadowSchema.Schema.push({ Column: 'IDTenant', Type: 'Integer', Size: 'int' });
			tmpTable.MeadowSchema.DefaultObject.IDTenant = 0;
			tmpTable.MeadowSchema.JsonSchema.properties.IDTenant = { type: 'integer', size: 'int' };
		});
	return tmpModel;
};

/**
 * A model table for reload tests.
 */
const gadgetTable = () =>
{
	return (
		{
			TableName: 'Gadget',
			Columns: [ { Column: 'IDGadget', DataType: 'ID' }, { Column: 'Deleted', DataType: 'Boolean' }, { Column: 'Color', DataType: 'String', Size: '16' } ],
			MeadowSchema:
			{
				Scope: 'Gadget',
				DefaultIdentifier: 'IDGadget',
				Schema: [ { Column: 'IDGadget', Type: 'AutoIdentity', Size: 'Default' }, { Column: 'Deleted', Type: 'Deleted', Size: 'Default' }, { Column: 'Color', Type: 'String', Size: '16' } ],
				DefaultObject: { IDGadget: 0, Deleted: false, Color: '' },
				JsonSchema: { title: 'Gadget', type: 'object', properties: {}, required: [] }
			}
		});
};

/**
 * Bind a fresh (unregistered) host with these options to the suite's RDS.
 */
const bindHost = (pEnvironment, pOptions, fCallback) =>
{
	let tmpHost = new libRetoldFacetingHostDataService(pEnvironment.fable, pOptions || {});
	tmpHost.bind(pEnvironment.rds, (pError) => { return fCallback(pError, tmpHost); });
};

suite
(
	'Facet-Host',
	() =>
	{
		let _Environment = { fable: null, rds: null, db: null, model: null };

		suiteSetup
		(
			(fDone) =>
			{
				let tmpFable = new libFable(
					{
						Product: 'RetoldFacetingHostTests',
						ProductVersion: '0.0.1',
						APIServerPort: 0,
						SQLite: { SQLiteFilePath: ':memory:' },
						RetoldFaceting: { Limits: { MaxFacets: 9 } },
						LogStreams: [ { streamtype: 'console', level: 'fatal' } ]
					});
				_Environment.fable = tmpFable;
				tmpFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
				tmpFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
				tmpFable.MeadowSQLiteProvider.connectAsync(
					(pConnectError) =>
					{
						if (pConnectError)
						{
							return fDone(pConnectError);
						}
						_Environment.db = tmpFable.MeadowSQLiteProvider.db;
						// Only Book exists in SQLite (size-class counts); 3 live rows + 1 soft-deleted.
						_Environment.db.exec('CREATE TABLE Book (IDBook INTEGER PRIMARY KEY AUTOINCREMENT, Deleted INTEGER NOT NULL DEFAULT 0, IDTenant INTEGER NOT NULL DEFAULT 0, Title TEXT)');
						_Environment.db.exec(`INSERT INTO Book (Deleted, IDTenant, Title) VALUES (0, 1, 'A'), (0, 1, 'B'), (0, 2, 'C'), (1, 1, 'D')`);
						tmpFable.serviceManager.addServiceType('RetoldDataService', libRetoldDataService);
						tmpFable.serviceManager.instantiateServiceProvider('RetoldDataService', { StorageProvider: 'SQLite', FullMeadowSchemaFilename: false });
						_Environment.rds = tmpFable.RetoldDataService;
						_Environment.rds.initializeService(
							(pInitError) =>
							{
								if (pInitError)
								{
									return fDone(pInitError);
								}
								_Environment.port = tmpFable.OratorServiceServer.server.address().port;
								_Environment.model = hostModel();
								_Environment.rds.loadModel('Bookstore', _Environment.model, 'SQLite', fDone);
							});
					});
			}
		);

		suiteTeardown
		(
			(fDone) =>
			{
				if (!_Environment.fable || !_Environment.fable.Orator)
				{
					return fDone();
				}
				_Environment.fable.Orator.stopWebServer(
					() =>
					{
						try
						{
							_Environment.db.close();
						}
						catch (pCloseError)
						{
							// already closed
						}
						return fDone();
					});
			}
		);

		suite
		(
			'Binding a plain RetoldDataService',
			() =>
			{
				test('bind() captures DALs, the route-bound controllers, the model and the service server',
					(fDone) =>
					{
						bindHost(_Environment, {},
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								let tmpFable = _Environment.fable;
								Expect(pHost.isBound()).to.equal(true);
								Expect(pHost.getHostKind()).to.equal('DataService');
								Expect(pHost.listEntities()).to.deep.equal(Object.keys(tmpFable.DAL));
								Expect(pHost.listEntities().length).to.equal(13);
								Expect(pHost.getDAL('Book')).to.equal(tmpFable.DAL.Book);
								Expect(pHost.getExecutionDAL('Book')).to.equal(tmpFable.DAL.Book);
								Expect(pHost.getDAL('Nope')).to.equal(null);
								Expect(pHost.getDAL('__proto__')).to.equal(null);
								Expect(pHost.getRouteBoundController('Review')).to.equal(tmpFable.MeadowEndpoints.Review.controller);
								Expect(pHost.getRouteBoundController('constructor')).to.equal(null);
								Expect(pHost.hasConnectedReadRoutes('Review')).to.equal(true);
								Expect(pHost.getServiceServer()).to.equal(tmpFable.OratorServiceServer);
								Expect(pHost.getModelSync()).to.equal(_Environment.rds.fullModel);
								Expect(pHost.getEntityModel('Book').TableName).to.equal('Book');
								Expect(pHost.entityHasColumn('Book', 'IDTenant')).to.equal(true);
								Expect(pHost.entityHasColumn('BookStoreCatalogJoin', 'IDTenant')).to.equal(false);
								Expect(pHost.getAuthorizer()).to.equal(null);
								Expect(pHost.installChangeIntake({})).to.equal(false);
								Expect(pHost.getSessionDataSource()).to.equal('Request');
								pHost.getModel(
									(pModelError, pModel) =>
									{
										Expect(pModelError).to.equal(null);
										Expect(pModel).to.equal(_Environment.rds.fullModel);
										return fDone();
									});
							});
					});

				test('dialect, delete column and primary key come from the DAL',
					(fDone) =>
					{
						bindHost(_Environment, {},
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								Expect(pHost.getDialectProfile('Book')).to.deep.equal({ Name: 'SQLite', Provider: 'SQLite', Supported: true });
								Expect(pHost.getDialectProfile('Nope')).to.deep.equal({ Name: null, Provider: null, Supported: false });
								Expect(pHost.getDeleteColumn('Book')).to.equal('Deleted');
								Expect(pHost.hasDeleteColumn('Book')).to.equal(true);
								Expect(pHost.getDeleteColumn('BookAuthorJoin')).to.equal(null);
								Expect(pHost.hasDeleteColumn('BookStoreCatalogJoin')).to.equal(false);
								Expect(pHost.getDeleteColumn('Nope')).to.equal(null);
								Expect(pHost.getPrimaryKey('BookStoreSale')).to.equal('IDBookStoreSale');
								Expect(pHost.getPrimaryKey('Nope')).to.equal(null);
								return fDone();
							});
					});

				test('isFacetable without a policy: routed SQL entities, minus NeverFacet and disabled list routes',
					(fDone) =>
					{
						bindHost(_Environment, { Catalog: { NeverFacet: [ 'User' ] } },
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								Expect(pHost.isFacetable('Book')).to.equal(true);
								Expect(pHost.isFacetable('BookStoreCatalogJoin')).to.equal(true);
								Expect(pHost.isFacetable('User')).to.equal(false);
								[ 'Nope', '__proto__', 'constructor', 'Book;', '', null, 7 ].forEach(
									(pEntity) =>
									{
										Expect(pHost.isFacetable(pEntity), String(pEntity)).to.equal(false);
									});
								Expect(pHost.scopeAssurance()).to.equal('Unscoped');
								Expect(pHost.scopeAssurance('Book')).to.equal('Unscoped');
								let tmpPolicy = pHost.getScopePolicy();
								Expect(tmpPolicy).to.include({ Kind: 'None', Column: null, Guard: 'Off' });
								Expect(tmpPolicy.requiredFor('Book', null)).to.deep.equal([]);
								Expect(tmpPolicy.isScoped('Book')).to.equal(false);

								// A Reads-disabled endpoint is not facetable (its list does not exist).
								let tmpSets = _Environment.fable.MeadowEndpoints.Review._EnabledBehaviorSets;
								tmpSets.Reads = false;
								try
								{
									Expect(pHost.hasConnectedReadRoutes('Review')).to.equal(false);
									Expect(pHost.isFacetable('Review')).to.equal(false);
								}
								finally
								{
									tmpSets.Reads = true;
								}
								Expect(pHost.isFacetable('Review')).to.equal(true);
								return fDone();
							});
					});
			}
		);

		suite
		(
			'Scope policy',
			() =>
			{
				test('a tenancy policy: required columns, Exclude, PersonalScopes, Required, GlobalEntities',
					(fDone) =>
					{
						let tmpOptions = (
							{
								Scope:
								{
									Policy:
									{
										Column: 'IDTenant',
										SessionField: 'TenantID',
										Exclude: [ 'Customer' ],
										PersonalScopes: { Review: { Column: 'IDUser', SessionField: 'UserID' } }
									},
									Required: { BookStoreSale: [ { Column: 'IDCustomer', From: '$CurrentUser.IDCustomer' }, { Column: 'IDBookStore', From: '$Scope.HomeStore' } ] },
									Guard: 'Repair'
								},
								Catalog: { GlobalEntities: [ 'BookStoreCatalogJoin' ] }
							});
						bindHost(_Environment, tmpOptions,
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								let tmpPolicy = pHost.getScopePolicy();
								Expect(tmpPolicy).to.include({ Kind: 'Policy', Column: 'IDTenant', SessionField: 'TenantID', Guard: 'Repair' });
								Expect(tmpPolicy.UnsetValues).to.deep.equal([ 0, '', null ]);
								Expect(tmpPolicy.PersonalScopes).to.deep.equal({ Review: { Column: 'IDUser', SessionField: 'UserID' } });
								Expect(pHost.getScopePolicy()).to.equal(tmpPolicy);

								Expect(tmpPolicy.requiredFor('Book', null)).to.deep.equal([ { Column: 'IDTenant', Value: null } ]);
								Expect(tmpPolicy.requiredFor('Customer', null)).to.deep.equal([]);
								Expect(tmpPolicy.requiredFor('BookStoreCatalogJoin', null)).to.deep.equal([]);
								Expect(tmpPolicy.requiredFor('Review', null).map((pEntry) => { return pEntry.Column; })).to.deep.equal([ 'IDTenant', 'IDUser' ]);
								Expect(tmpPolicy.requiredFor('BookStoreSale', null).map((pEntry) => { return pEntry.Column; })).to.deep.equal([ 'IDTenant', 'IDCustomer', 'IDBookStore' ]);

								Expect(pHost.isFacetable('Book')).to.equal(true);
								// Excluded and unscoped entities need Catalog.GlobalEntities.
								Expect(pHost.isFacetable('Customer')).to.equal(false);
								Expect(pHost.isFacetable('BookStoreCatalogJoin')).to.equal(true);
								Expect(pHost.scopeAssurance('Book')).to.equal('Guarded');
								Expect(pHost.scopeAssurance('BookStoreCatalogJoin')).to.equal('Global');
								Expect(pHost.scopeAssurance()).to.equal('Guarded');

								let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, UserID: 7, CustomerID: 3, TenantID: 2, HomeStore: 11 } };
								pHost.resolvePrincipal(tmpRequest,
									(pPrincipalError, pPrincipal) =>
									{
										Expect(pPrincipalError).to.equal(null);
										Expect(pPrincipal.ScopeValues).to.deep.equal({ IDTenant: 2, IDUser: 7, IDCustomer: 3, IDBookStore: 11 });
										Expect(tmpPolicy.requiredFor('Review', pPrincipal)).to.deep.equal([ { Column: 'IDTenant', Value: 2 }, { Column: 'IDUser', Value: 7 } ]);
										Expect(tmpPolicy.requiredFor('BookStoreSale', pPrincipal)).to.deep.equal([ { Column: 'IDTenant', Value: 2 }, { Column: 'IDCustomer', Value: 3 }, { Column: 'IDBookStore', Value: 11 } ]);
										Expect(pHost.scopePolicyData()).to.deep.equal(
											{
												Kind: 'Policy', Column: 'IDTenant', SessionField: 'TenantID', Exclude: [ 'Customer' ],
												PersonalScopes: { Review: { Column: 'IDUser', SessionField: 'UserID' } },
												Required: { BookStoreSale: [ { Column: 'IDCustomer', From: '$CurrentUser.IDCustomer' }, { Column: 'IDBookStore', From: '$Scope.HomeStore' } ] },
												UnsetValues: [ 0, '', null ], Guard: 'Repair'
											});
										return fDone();
									});
							});
					});

				test('mis-configured policies are refused at bind (fail closed)',
					(fDone) =>
					{
						let tmpCases = (
							[
								{ Scope: { Policy: { Column: 'IDTenant' }, Guard: 'Off' } },
								{ Scope: { Policy: { Column: 'IDTenant; DROP' } } },
								{ Scope: { Policy: 'Sometimes' } },
								{ Scope: { Required: { Book: [ { Column: 'IDTenant', From: 'IDTenant' } ] } } },
								{ Scope: { Required: { Book: 'IDTenant' } } }
							]);
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							bindHost(_Environment, tmpCases[pIndex],
								(pError, pHost) =>
								{
									Expect(pError, JSON.stringify(tmpCases[pIndex])).to.be.an('error');
									Expect(pError.Code).to.equal('FACET_INTERNAL');
									Expect(pHost.isBound()).to.equal(false);
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});

				test('Guard runs Strict for any policy unless Repair is asked for; Off only without a policy',
					() =>
					{
						let tmpHost = new libRetoldFacetingHostBase(_Environment.fable, {});
						Expect(tmpHost.buildScopePolicy({ Policy: { Column: 'IDTenant' }, Guard: 'Bogus' }, () => { return true; }).Guard).to.equal('Strict');
						Expect(tmpHost.buildScopePolicy({ Policy: { Column: 'IDTenant' }, Guard: 'Repair' }, () => { return true; }).Guard).to.equal('Repair');
						Expect(tmpHost.buildScopePolicy({ Policy: 'Auto', Guard: 'Strict' }, () => { return true; })).to.include({ Kind: 'None', Guard: 'Off' });
						Expect(tmpHost.buildScopePolicy({ Policy: false }, () => { return true; }).requiredFor('Book', { ScopeValues: { IDTenant: 1 } })).to.deep.equal([]);
						Expect(tmpHost.validateScopeConfiguration({ Policy: false, Guard: 'Off' })).to.deep.equal([]);
						Expect(tmpHost.validateScopeConfiguration({ Policy: { Column: 'IDTenant' }, Guard: 'Strict' })).to.deep.equal([]);
					});
			}
		);

		suite
		(
			'Principal',
			() =>
			{
				test('anonymous requests resolve through the route-bound session marshaler',
					(fDone) =>
					{
						bindHost(_Environment, {},
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								pHost.resolvePrincipal({ params: {}, headers: {}, query: {} },
									(pPrincipalError, pPrincipal) =>
									{
										Expect(pPrincipalError).to.equal(null);
										Expect(pPrincipal).to.include({ Kind: 'Anonymous', Source: 'InProcess', IDUser: 0, IDCustomer: 0, RoleSetHash: '' });
										Expect(pPrincipal.ScopeValues).to.deep.equal({});
										Expect(pPrincipal.UserRecord).to.deep.equal({ IDUser: 0, IDCustomer: 0 });
										Expect(pPrincipal.ResolvedAt).to.be.a('number');
										Expect(Object.isFrozen(pPrincipal)).to.equal(true);
										Expect(Object.isFrozen(pPrincipal.ScopeValues)).to.equal(true);
										// A request with no headers at all still resolves.
										pHost.resolvePrincipal(null,
											(pNullError, pNullPrincipal) =>
											{
												Expect(pNullError).to.equal(null);
												Expect(pNullPrincipal.Kind).to.equal('Anonymous');
												return fDone();
											});
									});
							});
					});

				test('logged-in sessions: IDUser / IDCustomer fallbacks, policy scope values, whitelisted UserRecord',
					(fDone) =>
					{
						let tmpOptions = { Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant' }, UserRecordFields: [ 'IDUser', 'IDCustomer', 'Region' ] } };
						bindHost(_Environment, tmpOptions,
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, IDUser: 12, IDCustomer: 4, IDTenant: 3, Secret: 'never', UserRecord: { Region: 'NW', Password: 'never' } } };
								pHost.resolvePrincipal(tmpRequest,
									(pPrincipalError, pPrincipal) =>
									{
										Expect(pPrincipalError).to.equal(null);
										// UserID / CustomerID from the default session are 0, so the ID* fields win.
										Expect(pPrincipal).to.include({ Kind: 'User', IDUser: 12, IDCustomer: 4 });
										Expect(pPrincipal.ScopeValues).to.deep.equal({ IDTenant: 3 });
										Expect(pPrincipal.UserRecord).to.deep.equal({ IDUser: 12, IDCustomer: 4, Region: 'NW' });
										Expect(JSON.stringify(pPrincipal)).to.not.include('never');

										// An unset tenant resolves to null (the PrincipalResolver turns it into 401).
										pHost.resolvePrincipal({ params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, UserID: 5 } },
											(pUnsetError, pUnset) =>
											{
												Expect(pUnsetError).to.equal(null);
												Expect(pUnset.ScopeValues).to.deep.equal({ IDTenant: null });
												Expect(pUnset.IDUser).to.equal(5);
												return fDone();
											});
									});
							});
					});

				test('header-sourced sessions are refused unless Scope.AllowHeaderSession (then Spoofable)',
					(fDone) =>
					{
						// The marshaler reads controller.settings, a snapshot of fable.settings taken when the
						// controller was built (fable may since have replaced its settings object), so set both.
						let tmpSettingsObjects = [ _Environment.fable.settings ];
						Object.keys(_Environment.fable.MeadowEndpoints).forEach(
							(pEntity) =>
							{
								let tmpControllerSettings = _Environment.fable.MeadowEndpoints[pEntity].controller.settings;
								if (tmpSettingsObjects.indexOf(tmpControllerSettings) < 0)
								{
									tmpSettingsObjects.push(tmpControllerSettings);
								}
							});
						let fRestore = () =>
						{
							tmpSettingsObjects.forEach((pSettings) => { delete pSettings.MeadowEndpointsSessionDataSource; });
						};
						// A Header source on the controllers alone (what the routes honor) is enough to refuse.
						let tmpControllerOnly = tmpSettingsObjects.filter((pSettings) => { return pSettings !== _Environment.fable.settings; });
						if (tmpControllerOnly.length > 0)
						{
							tmpControllerOnly.forEach((pSettings) => { pSettings.MeadowEndpointsSessionDataSource = 'Header'; });
							let tmpProbe = new libRetoldFacetingHostDataService(_Environment.fable, {});
							let tmpProbeError = null;
							tmpProbe.bind(_Environment.rds, (pProbeError) => { tmpProbeError = pProbeError; });
							fRestore();
							Expect(tmpProbeError).to.be.an('error');
						}
						tmpSettingsObjects.forEach((pSettings) => { pSettings.MeadowEndpointsSessionDataSource = 'Header'; });
						bindHost(_Environment, {},
							(pError, pHost) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Code).to.equal('FACET_INTERNAL');
									Expect(pError.message).to.include('AllowHeaderSession');
									Expect(pHost.isBound()).to.equal(false);
									Expect(pHost.getRouteBoundController('Book')).to.equal(null);
								}
								catch (pAssertionError)
								{
									fRestore();
									throw pAssertionError;
								}
								bindHost(_Environment, { Scope: { AllowHeaderSession: true } },
									(pAllowedError, pAllowedHost) =>
									{
										try
										{
											Expect(pAllowedError).to.equal(undefined);
											Expect(pAllowedHost.scopeAssurance('Book')).to.equal('Spoofable');
										}
										catch (pAssertionError)
										{
											fRestore();
											throw pAssertionError;
										}
										pAllowedHost.resolvePrincipal({ params: {}, headers: { 'x-trusted-session': JSON.stringify({ LoggedIn: true, UserID: 9 }) }, query: {} },
											(pPrincipalError, pPrincipal) =>
											{
												fRestore();
												Expect(pPrincipalError).to.equal(null);
												Expect(pPrincipal).to.include({ Kind: 'User', IDUser: 9 });
												return fDone();
											});
									});
							});
					});

				test('bind() refuses a missing RDS and a second, different RDS',
					(fDone) =>
					{
						let tmpHost = new libRetoldFacetingHostDataService(_Environment.fable, {});
						tmpHost.bind(null,
							(pError) =>
							{
								Expect(pError.Code).to.equal('FACET_INTERNAL');
								tmpHost.bind(_Environment.rds,
									(pBindError) =>
									{
										Expect(pBindError).to.equal(undefined);
										tmpHost.bind({ fable: _Environment.fable },
											(pSecondError) =>
											{
												Expect(pSecondError.Code).to.equal('FACET_INTERNAL');
												// Re-binding the same RDS is harmless.
												tmpHost.bind(_Environment.rds,
													(pSameError) =>
													{
														Expect(pSameError).to.equal(undefined);
														return fDone();
													});
											});
									});
							});
					});
			}
		);

		suite
		(
			'Installer',
			() =>
			{
				test('installOnRetoldDataService refuses bad hosts, non-Embedded roles and reserved entity names',
					(fDone) =>
					{
						libRetoldFacetingInstallers.installOnRetoldDataService(null, {},
							(pNoHostError) =>
							{
								Expect(pNoHostError.Code).to.equal('FACET_INTERNAL');
								libRetoldFacetingInstallers.installOnRetoldDataService(_Environment.rds, { Role: 'Agent' },
									(pRoleError) =>
									{
										Expect(pRoleError.Code).to.equal('FACET_INTERNAL');
										Expect(pRoleError.message).to.include('Embedded');
										Expect(_Environment.fable.RetoldFacetingService).to.equal(undefined);
										let tmpFakeFable = new libFable({ LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
										tmpFakeFable.DAL = { Book: {}, Status: {} };
										tmpFakeFable.MeadowEndpoints = {};
										tmpFakeFable.OratorServiceServer = {};
										libRetoldFacetingInstallers.installOnRetoldDataService({ fable: tmpFakeFable, fullModel: false }, {},
											(pReservedError) =>
											{
												Expect(pReservedError.Code).to.equal('FACET_INTERNAL');
												Expect(pReservedError.message).to.include('Status');
												// attach() performs the one D-17 check: nothing is attached, no route is mounted.
												Expect(!tmpFakeFable.RetoldFacetingService || (tmpFakeFable.RetoldFacetingService._Attached === false)).to.equal(true);
												return fDone();
											});
									});
							});
					});

				test('installOnRetoldDataService registers the service, binds the host, builds the catalog and mounts routes',
					(fDone) =>
					{
						// pOptions omitted → fable.settings.RetoldFaceting.
						libRetoldFacetingInstallers.installOnRetoldDataService(_Environment.rds, null,
							(pError, pService) =>
							{
								Expect(pError).to.equal(null);
								let tmpFable = _Environment.fable;
								Expect(pService).to.equal(tmpFable.RetoldFacetingService);
								Expect(pService.options.Limits.MaxFacets).to.equal(9);
								Expect(pService.Host).to.equal(tmpFable.RetoldFacetingHostDataService);
								Expect(pService.Host.isBound()).to.equal(true);
								Expect(tmpFable.RetoldFacetingCatalog.entities()).to.include('Book');
								Expect(tmpFable.RetoldFacetingCatalog.modelVersion()).to.match(/^m:[0-9a-f]{12}$/);
								Expect(tmpFable.RetoldFacetingGraph.builtFrom()).to.equal(_Environment.rds.fullModel);
								fetch(`http://127.0.0.1:${_Environment.port}/1.0/Facet/Describe`).then(
									(pResponse) =>
									{
										setImmediate(
											() =>
											{
												Expect(pResponse.status).to.not.equal(404);
												libRetoldFacetingInstallers.installOnRetoldDataService(_Environment.rds, {},
													(pSecondError) =>
													{
														Expect(pSecondError.Code).to.equal('FACET_INTERNAL');
														Expect(pSecondError.message).to.include('already installed');
														return fDone();
													});
											});
									},
									(pFetchError) => { setImmediate(() => { fDone(pFetchError); }); });
							});
					});

				test('catalog size classes count live rows through the DAL (internal only)',
					(fDone) =>
					{
						let tmpFable = _Environment.fable;
						let tmpCatalog = new libRetoldFacetingCatalog(tmpFable, { Catalog: { AutoFKTermsMaxTargetRows: 2 } });
						tmpCatalog.rebuild(tmpFable.RetoldFacetingHostDataService.getModelSync(), tmpFable.RetoldFacetingHostDataService);
						Expect(tmpCatalog.sizeClass('Book')).to.equal('Unknown');
						tmpCatalog.refreshSizeClasses(
							(pError, pClasses) =>
							{
								Expect(pError).to.equal(null);
								// 3 live rows (the soft-deleted one is not counted) > 2.
								Expect(pClasses.Book).to.equal('Large');
								Expect(tmpCatalog.sizeClass('Book')).to.equal('Large');
								// No table in SQLite → Unknown, never an error.
								Expect(pClasses.Review).to.equal('Unknown');
								Expect(JSON.stringify(tmpCatalog.describe('Book', null))).to.not.include('Large');
								tmpFable.RetoldFacetingCatalog.refreshSizeClasses(
									(pDefaultError, pDefaultClasses) =>
									{
										Expect(pDefaultError).to.equal(null);
										Expect(pDefaultClasses.Book).to.equal('Small');
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'Model reloads (D-31)',
			() =>
			{
				test('entities that already had routes keep their captured controller; new entities take the new one',
					(fDone) =>
					{
						bindHost(_Environment, { Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant' } } },
							(pError, pHost) =>
							{
								Expect(pError).to.equal(undefined);
								let tmpFable = _Environment.fable;
								let tmpReviewController = tmpFable.MeadowEndpoints.Review.controller;
								let tmpReviewDAL = tmpFable.DAL.Review;
								Expect(pHost.getRouteBoundController('Review')).to.equal(tmpReviewController);
								Expect(pHost.getScopePolicy().isScoped('Gadget')).to.equal(false);
								let tmpNotified = [];
								pHost.onModelChanged((pModel) => { tmpNotified.push(Object.keys(pModel.Tables)); });
								pHost.onModelChanged(() => { throw new Error('a broken listener must not stop the others'); });
								pHost.onModelChanged((pModel) => { tmpNotified.push('second'); });

								let tmpGadget = gadgetTable();
								tmpGadget.Columns.push({ Column: 'IDTenant', DataType: 'Numeric', Size: 'int' });
								tmpGadget.MeadowSchema.Schema.push({ Column: 'IDTenant', Type: 'Integer', Size: 'int' });
								let tmpReloaded = { Tables: { Review: JSON.parse(JSON.stringify(_Environment.model.Tables.Review)), Gadget: tmpGadget } };
								_Environment.rds.loadModel('Reload', tmpReloaded, 'SQLite',
									(pLoadError) =>
									{
										Expect(pLoadError).to.equal(undefined);
										// RDS replaced the endpoint object and the DAL ...
										Expect(tmpFable.MeadowEndpoints.Review.controller).to.not.equal(tmpReviewController);
										Expect(tmpFable.DAL.Review).to.not.equal(tmpReviewDAL);
										// ... but the routes stay bound to the first controller, and so does the host.
										Expect(pHost.getRouteBoundController('Review')).to.equal(tmpReviewController);
										Expect(pHost.getDAL('Review')).to.equal(tmpFable.DAL.Review);
										Expect(pHost.getRouteBoundController('Gadget')).to.equal(tmpFable.MeadowEndpoints.Gadget.controller);
										Expect(pHost.isFacetable('Gadget')).to.equal(true);
										// The policy cache was dropped: Gadget's IDTenant is now known.
										Expect(pHost.getScopePolicy().isScoped('Gadget')).to.equal(true);
										Expect(tmpNotified.length).to.equal(2);
										Expect(tmpNotified[0]).to.include.members([ 'Book', 'Review', 'Gadget' ]);
										Expect(tmpNotified[1]).to.equal('second');
										// The wrap is single per host even when re-bound after other hosts wrapped the
										// loader: the next load notifies each listener exactly once more.
										bindHost(_Environment, {},
											(pOtherError) =>
											{
												Expect(pOtherError).to.equal(undefined);
												pHost.bind(_Environment.rds,
													(pRebindError) =>
													{
														Expect(pRebindError).to.equal(undefined);
														let tmpGizmo = gadgetTable();
														tmpGizmo.TableName = 'Gizmo';
														tmpGizmo.Columns[0].Column = 'IDGizmo';
														tmpGizmo.MeadowSchema.Scope = 'Gizmo';
														tmpGizmo.MeadowSchema.DefaultIdentifier = 'IDGizmo';
														tmpGizmo.MeadowSchema.Schema[0].Column = 'IDGizmo';
														_Environment.rds.loadModel('Gizmo', { Tables: { Gizmo: tmpGizmo } }, 'SQLite',
															(pGizmoError) =>
															{
																Expect(pGizmoError).to.equal(undefined);
																Expect(tmpNotified.length).to.equal(4);
																Expect(tmpNotified[2]).to.include('Gizmo');
																Expect(pHost.getRouteBoundController('Gizmo')).to.equal(_Environment.fable.MeadowEndpoints.Gizmo.controller);
																// Unscoped (no IDTenant) under the policy and not global: not facetable.
																Expect(pHost.isFacetable('Gizmo')).to.equal(false);
																return fDone();
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
