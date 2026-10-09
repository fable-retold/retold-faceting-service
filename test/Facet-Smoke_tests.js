/**
 * Smoke tests: every source file loads, every service class constructs on a fresh fable with the
 * right serviceType, every pure module exposes its contract (internal-contracts §15).
 *
 * Anyone may ADD assertions here when they add an export; nobody removes one without replacing it.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const libBuilders = require('./support/Facet-Test-Builders.js');
const Expect = libChai.expect;

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const SOURCE = '../source/';

// [ relative path, serviceType ] for every service class (internal-contracts §15)
const SERVICE_CLASSES = (
	[
		[ 'Retold-Faceting-Service.js', 'RetoldFacetingService' ],
		[ 'host/Retold-Faceting-Host-Base.js', 'RetoldFacetingHostBase' ],
		[ 'host/Retold-Faceting-Host-DataService.js', 'RetoldFacetingHostDataService' ],
		[ 'catalog/Retold-Faceting-Catalog.js', 'RetoldFacetingCatalog' ],
		[ 'catalog/Retold-Faceting-Graph.js', 'RetoldFacetingGraph' ],
		[ 'request/Retold-Faceting-RequestNormalizer.js', 'RetoldFacetingRequestNormalizer' ],
		[ 'request/Retold-Faceting-FilterValidator.js', 'RetoldFacetingFilterValidator' ],
		[ 'request/Retold-Faceting-ClauseCompiler.js', 'RetoldFacetingClauseCompiler' ],
		[ 'request/Retold-Faceting-FilterAST.js', 'RetoldFacetingFilterAST' ],
		[ 'request/Retold-Faceting-DisjunctivePlanner.js', 'RetoldFacetingDisjunctivePlanner' ],
		[ 'plan/Retold-Faceting-Planner.js', 'RetoldFacetingPlanner' ],
		[ 'plan/Retold-Faceting-FoldIR.js', 'RetoldFacetingFoldIR' ],
		[ 'security/Retold-Faceting-PrincipalResolver.js', 'RetoldFacetingPrincipalResolver' ],
		[ 'security/Retold-Faceting-ScopeCapture.js', 'RetoldFacetingScopeCapture' ],
		[ 'security/Retold-Faceting-ScopeGuard.js', 'RetoldFacetingScopeGuard' ],
		[ 'security/Retold-Faceting-Authorizer.js', 'RetoldFacetingAuthorizer' ],
		[ 'engine/Retold-Faceting-Router.js', 'RetoldFacetingRouter' ],
		[ 'engine/Retold-Faceting-EngineBase.js', 'RetoldFacetingEngineBase' ],
		[ 'engine/Retold-Faceting-EngineLive.js', 'RetoldFacetingEngineLive' ],
		[ 'engine/Retold-Faceting-EngineReference.js', 'RetoldFacetingEngineReference' ],
		[ 'engine/live/Retold-Faceting-ScopedRelationBuilder.js', 'RetoldFacetingScopedRelationBuilder' ],
		[ 'engine/live/Retold-Faceting-Dialects.js', 'RetoldFacetingDialects' ],
		[ 'engine/live/Retold-Faceting-ShellTemplates.js', 'RetoldFacetingShellTemplates' ],
		[ 'routes/Retold-Faceting-Routes.js', 'RetoldFacetingRoutes' ],
		[ 'catalog/Retold-Faceting-LabelResolver.js', 'RetoldFacetingLabelResolver' ],
		// Milestone 2 (internal-contracts §19.3)
		[ 'catalog/Retold-Faceting-DefinitionRegistry.js', 'RetoldFacetingDefinitionRegistry' ],
		[ 'plan/Retold-Faceting-Binder.js', 'RetoldFacetingBinder' ],
		[ 'engine/live/Retold-Faceting-PredicateCompiler.js', 'RetoldFacetingPredicateCompiler' ],
		[ 'engine/live/Retold-Faceting-StagedKeys.js', 'RetoldFacetingStagedKeys' ],
		[ 'engine/live/Retold-Faceting-CubeExecutor.js', 'RetoldFacetingCubeExecutor' ],
		// Milestone 4 (internal-contracts §38.3)
		[ 'security/Retold-Faceting-CacheKey.js', 'RetoldFacetingCacheKey' ],
		[ 'cache/Retold-Faceting-Generations.js', 'RetoldFacetingGenerations' ],
		[ 'cache/Retold-Faceting-ResultCache.js', 'RetoldFacetingResultCache' ],
		[ 'change/Retold-Faceting-ChangeIntake.js', 'RetoldFacetingChangeIntake' ],
		[ 'change/Retold-Faceting-ReadYourWrites.js', 'RetoldFacetingReadYourWrites' ],
		[ 'routes/Retold-Faceting-SSE.js', 'RetoldFacetingSSE' ]
	]);

// [ relative path, required export names ] for every pure / function module
const PURE_MODULES = (
	[
		[ 'Retold-Faceting-Service-Options.js', [ 'DEFAULTS', 'ROUTE_RESERVED_NAMES', 'NEVER_FACETABLE', 'resolve', 'deepMerge', 'hasScopePolicy' ] ],
		[ 'Retold-Faceting-Installers.js', [ 'installOnRetoldDataService' ] ],
		[ 'contract/Facet-Contract-Request.js', [ 'CONTRACT_VERSION', 'FOLDS', 'SELECTABLE_FOLDS', 'INTERVALS', 'ORDERS', 'NUMERIC_MODES', 'EXCLUDE_POLICIES', 'DEFAULT_EXCLUDE', 'FOLD_CLAUSE_TYPE', 'M1_CLAUSE_TYPES', 'FILTER_INSTRUCTIONS', 'FILTER_STRIPPED_INSTRUCTIONS', 'FILTER_OPERATOR_MAP', 'PRED_OPS', 'IDENTIFIER_PATTERN', 'parseFacetID', 'defaultExcludeFor', 'clauseTypeFor', 'clampPositiveInteger' ] ],
		[ 'contract/Facet-Contract-Envelope.js', [ 'CONTRACT_VERSION', 'NUMERIC_KEY_TYPES', 'VOLATILE_FIELDS', 'normalizeKey', 'emptyFacetResult', 'buildFacetResult', 'buildEnvelope', 'normalizeForComparison' ] ],
		[ 'contract/Facet-Contract-Buckets.js', [ 'canonicalDateTime', 'dateKey', 'nextDateKey', 'fillDateKeys', 'dateLabel', 'coarserInterval', 'units', 'numericGeometry', 'edgesGeometry', 'numericIndex', 'numericBucketBounds', 'numericLabel', 'compareKeys',
			// M2 (internal-contracts §24.9, §29.2)
			'isBandEdges', 'bandKey', 'bandBounds', 'bandLabel', 'existsSplitKey', 'existsSplitLabel', 'EXISTS_SPLIT_KEYS' ] ],
		[ 'contract/Facet-Contract-Clauses.js', [ 'clauseSignature', 'bucketClause', 'selectedFrom',
			// M2 (internal-contracts §29.3, §29.4)
			'pathSignatureOf', 'pathStepsOf', 'SELECTION_ONLY_FOLDS' ] ],
		[ 'contract/Facet-Contract-Errors.js', [ 'CODES', 'create', 'isFacetError', 'fromBehaviorError', 'toResponse', 'toEntry' ] ],
		[ 'contract/Facet-Contract-Util.js', [ 'RESERVED_KEY_NAMES', 'isPlainObject', 'hasOwn', 'isPresent', 'toFiniteNumber', 'toCount', 'keyProblem', 'logSafe' ] ],
		[ 'Retold-Faceting-Util.js', [ 'stripColumn', 'columnQualifier', 'normalizeScopeValue', 'isUnsetScopeValue', 'hasOwn',
			// M4 (internal-contracts §38.5)
			'SEQ_PATTERN', 'NODE_EPOCH_PATTERN', 'parseSeq', 'formatSeq', 'principalKey' ] ],
		[ 'engine/live/Shell-Templates-SQLite.js', [ 'Dialect', 'Templates', 'Expressions' ] ],
		[ 'engine/live/Shell-Templates-PostgreSQL.js', [ 'Dialect', 'Templates', 'Expressions' ] ],
		[ 'engine/live/Shell-Templates-MySQL.js', [ 'Dialect', 'Templates', 'Expressions' ] ],
		[ 'engine/live/Shell-Templates-MSSQL.js', [ 'Dialect', 'Templates', 'Expressions' ] ]
	]);

const newFable = () => { return libBuilders.newFable('RetoldFacetingSmoke'); };

suite
(
	'Facet-Smoke',
	() =>
	{
		suite
		(
			'Service classes',
			() =>
			{
				SERVICE_CLASSES.forEach(
					(pEntry) =>
					{
						test(`${pEntry[0]} constructs as ${pEntry[1]}`,
							() =>
							{
								let libServiceClass = require(SOURCE + pEntry[0]);
								Expect(libServiceClass).to.be.a('function');
								Expect(libServiceClass.serviceType).to.equal(pEntry[1]);

								let tmpFable = newFable();
								let tmpService = new libServiceClass(tmpFable);
								Expect(tmpService).to.be.an.instanceof(libFableServiceProviderBase);
								Expect(tmpService.serviceType).to.equal(pEntry[1]);
								Expect(tmpService.fable).to.equal(tmpFable);
								// Every service resolves the RetoldFaceting options itself.
								Expect(tmpService.options).to.be.an('object');
								Expect(tmpService.options.RoutePrefix).to.equal('/1.0/Facet');
								Expect(tmpService.options.Limits.MaxFacets).to.equal(20);

								// And registers through fable the way the main service does.
								let tmpOtherFable = newFable();
								tmpOtherFable.addServiceType(pEntry[1], libServiceClass);
								let tmpRegistered = tmpOtherFable.instantiateServiceProvider(pEntry[1], { Limits: { MaxFacets: 7 } });
								Expect(tmpOtherFable[pEntry[1]]).to.equal(tmpRegistered);
								Expect(tmpRegistered.options.Limits.MaxFacets).to.equal(7);
								Expect(tmpRegistered.options.Limits.MaxTop).to.equal(500);
							});
					});
			}
		);

		suite
		(
			'Pure modules',
			() =>
			{
				PURE_MODULES.forEach(
					(pEntry) =>
					{
						test(`${pEntry[0]} exports its contract`,
							() =>
							{
								let libModule = require(SOURCE + pEntry[0]);
								Expect(libModule).to.be.an('object');
								pEntry[1].forEach(
									(pExport) =>
									{
										Expect(libModule, `${pEntry[0]} export ${pExport}`).to.have.property(pExport);
									});
							});
					});

				test('contract and shell modules require nothing outside source/contract/',
					() =>
					{
						let libFS = require('fs');
						let libPath = require('path');
						let tmpFiles = (
							[
								'contract/Facet-Contract-Request.js',
								'contract/Facet-Contract-Envelope.js',
								'contract/Facet-Contract-Buckets.js',
								'contract/Facet-Contract-Clauses.js',
								'contract/Facet-Contract-Errors.js',
								'contract/Facet-Contract-Util.js',
								'engine/live/Shell-Templates-SQLite.js',
								'engine/live/Shell-Templates-PostgreSQL.js',
								'engine/live/Shell-Templates-MySQL.js',
								'engine/live/Shell-Templates-MSSQL.js'
							]);
						tmpFiles.forEach(
							(pFile) =>
							{
								let tmpSource = libFS.readFileSync(libPath.join(__dirname, SOURCE, pFile), 'utf8');
								let tmpRequires = tmpSource.match(/require\(\s*['"`][^'"`]+['"`]\s*\)/g) || [];
								tmpRequires.forEach(
									(pRequire) =>
									{
										let tmpIsContractSibling = /require\(\s*['"`]\.\/Facet-Contract-[A-Za-z]+\.js['"`]\s*\)/.test(pRequire) && (pFile.indexOf('contract/') === 0);
										Expect(tmpIsContractSibling, `${pFile}: ${pRequire}`).to.equal(true);
									});
							});
					});

				test('the four shell modules name their dialects and pass the tag scan',
					() =>
					{
						[ 'SQLite', 'PostgreSQL', 'MySQL', 'MSSQL' ].forEach(
							(pDialect) =>
							{
								Expect(require(`${SOURCE}engine/live/Shell-Templates-${pDialect}.js`).Dialect).to.equal(pDialect);
							});
						let libShellTemplates = require(SOURCE + 'engine/live/Retold-Faceting-ShellTemplates.js');
						let tmpRegistry = new libShellTemplates(newFable());
						Expect(tmpRegistry.validateAll().Errors).to.deep.equal([]);
					});
			}
		);

		suite
		(
			'Options and errors',
			() =>
			{
				test('resolve() deep-merges and is idempotent',
					() =>
					{
						let libOptions = require(SOURCE + 'Retold-Faceting-Service-Options.js');
						let tmpResolved = libOptions.resolve({ Scope: { Guard: 'Repair' }, Limits: { MaxTop: 50 } });
						Expect(tmpResolved.Scope.Guard).to.equal('Repair');
						Expect(tmpResolved.Scope.Behavior).to.equal('Reads-QueryConfiguration');
						Expect(tmpResolved.Limits.MaxTop).to.equal(50);
						Expect(tmpResolved.Limits.MaxFacets).to.equal(20);
						Expect(libOptions.resolve(tmpResolved)).to.equal(tmpResolved);
						Expect(libOptions.DEFAULTS.Limits.MaxTop).to.equal(500);
						Expect(libOptions.hasScopePolicy(tmpResolved)).to.equal(false);
						Expect(libOptions.hasScopePolicy(libOptions.resolve({ Scope: { Policy: { Column: 'IDTenant' } } }))).to.equal(true);
					});

				test('facet errors carry Code and Status and map to responses',
					() =>
					{
						let libFacetErrors = require(SOURCE + 'contract/Facet-Contract-Errors.js');
						let tmpError = libFacetErrors.create('FACET_FILTER_INVALID', null, { Offset: 2, Token: 'FBD' });
						Expect(tmpError).to.be.an.instanceof(Error);
						Expect(libFacetErrors.isFacetError(tmpError)).to.equal(true);
						Expect(tmpError.Status).to.equal(400);
						Expect(libFacetErrors.toResponse(tmpError)).to.deep.equal({ Status: 400, Body: { Error: { Code: 'FACET_FILTER_INVALID', Status: 400, Message: 'The filter is invalid.', Detail: { Offset: 2, Token: 'FBD' } } } });
						Expect(libFacetErrors.toEntry(new Error('boom')).Code).to.equal('FACET_INTERNAL');
						Expect(libFacetErrors.CODES.FACET_UNKNOWN_ENTITY.Status).to.equal(404);
						Expect(libFacetErrors.CODES.FACET_SCOPE_POLICY_VIOLATION.Status).to.equal(500);
						Expect(libFacetErrors.CODES.FACET_REQUEST_INVALID.Status).to.equal(400);
					});

				test('parseFacetID recognizes the M1 grammar',
					() =>
					{
						let libFacetRequest = require(SOURCE + 'contract/Facet-Contract-Request.js');
						Expect(libFacetRequest.parseFacetID('Review.Rating')).to.deep.equal({ Kind: 'Auto', Entity: 'Review', Column: 'Rating', Raw: 'Review.Rating' });
						Expect(libFacetRequest.parseFacetID('Review.IDBook>Book.Language').Kind).to.equal('Path');
						Expect(libFacetRequest.parseFacetID('Book.ByAuthor/Top').Kind).to.equal('Declared');
						Expect(libFacetRequest.parseFacetID('Review."Rating')).to.equal(null);
						Expect(libFacetRequest.parseFacetID('Review')).to.equal(null);
						Expect(libFacetRequest.parseFacetID(42)).to.equal(null);
						Expect(libFacetRequest.defaultExcludeFor('Terms')).to.equal('Self');
						Expect(libFacetRequest.defaultExcludeFor('Pivot')).to.equal('None');
					});
			}
		);

		suite
		(
			'Main service',
			() =>
			{
				test('registerServices() puts every sub-service on fable with resolved options',
					() =>
					{
						let libRetoldFacetingService = require(SOURCE + 'Retold-Faceting-Service.js');
						let tmpFable = newFable();
						tmpFable.addServiceType('RetoldFacetingService', libRetoldFacetingService);
						let tmpService = tmpFable.instantiateServiceProvider('RetoldFacetingService', { Limits: { MaxFacets: 5 } });
						tmpService.registerServices();
						libRetoldFacetingService.SUB_SERVICES.forEach(
							(pEntry) =>
							{
								Expect(tmpFable[pEntry[0]], pEntry[0]).to.be.an('object');
								Expect(tmpFable[pEntry[0]].serviceType).to.equal(pEntry[0]);
								Expect(tmpFable[pEntry[0]].options.Limits.MaxFacets).to.equal(5);
							});
						Expect(tmpFable.RetoldFacetingRouter.engine('Live')).to.equal(tmpFable.RetoldFacetingEngineLive);
						Expect(tmpFable.RetoldFacetingRouter.engine('Reference')).to.equal(tmpFable.RetoldFacetingEngineReference);
						Expect(libRetoldFacetingService.installOnRetoldDataService).to.be.a('function');
						let tmpContext = tmpService.newContext('Review', { params: {}, headers: {} }, { ForceEngine: 'Reference' });
						Expect(tmpContext.ForceEngine).to.equal('Reference');
						Expect(tmpContext.Memo).to.deep.equal({ Relations: {}, Captures: {}, VariantRows: {} });
					});
			}
		);

		suite
		(
			'Test support',
			() =>
			{
				test('the harness and the seed load',
					() =>
					{
						let libHarness = require('./support/Facet-Test-Harness.js');
						Expect(libHarness.start).to.be.a('function');
						let libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
						let tmpModel = libBookstoreSeed.model('Bookstore-Tenant');
						Object.keys(tmpModel.Tables).forEach(
							(pTable) =>
							{
								Expect(tmpModel.Tables[pTable].Columns.some((pColumn) => { return pColumn.Column === 'IDTenant'; }), pTable).to.equal(true);
							});
						let fRandomA = libBookstoreSeed.prng(7);
						let fRandomB = libBookstoreSeed.prng(7);
						Expect([ fRandomA(), fRandomA(), fRandomA() ]).to.deep.equal([ fRandomB(), fRandomB(), fRandomB() ]);
						Expect(libBookstoreSeed.generate).to.be.a('function');
					});

				test('the M2 domain fixtures, definitions, schema and provider hook load (internal-contracts §31–§33)',
					() =>
					{
						let libProviders = require('./support/Facet-Harness-Providers.js');
						Expect(libProviders.PROVIDERS).to.deep.equal([ 'SQLite', 'PostgreSQL' ]);
						Expect(libProviders.available('SQLite').Available).to.equal(true);
						let libDockerPostgres = require('./support/Facet-Docker-Postgres.js');
						Expect(libDockerPostgres.CONTAINER_NAME).to.equal('rfs-test-postgres');
						Expect(libDockerPostgres.HOST_PORT).to.equal(15433);
						let libSchema = require(SOURCE + 'catalog/Facet-Definition-Schema.json');
						Expect(libSchema.properties.FormatVersion).to.deep.equal({ const: 1 });
						[ [ './fixtures/ProjectTrack-Seed.js', [ 'Customer', 'User', 'Client', 'Project', 'ProjectMembership', 'Task', 'Issue', 'FormType', 'Document' ] ],
							[ './fixtures/LabTrack-Seed.js', [ 'Customer', 'User', 'LabQueue', 'LabQueueMember', 'MaterialType', 'MaterialIntake', 'LabFormType', 'MaterialIntakeRequirement', 'MaterialTypeFormRequirement', 'LabForm' ] ] ].forEach(
							(pEntry) =>
							{
								let libSeed = require(pEntry[0]);
								Expect(Object.keys(libSeed.model().Tables)).to.deep.equal(pEntry[1]);
								Expect(libSeed.FACETING_OPTIONS.Scope.Policy.Column).to.equal('IDCustomer');
								let tmpDefinitions = require(libSeed.DEFINITIONS_PATH);
								Expect(tmpDefinitions.FormatVersion).to.equal(1);
							});
					});

				test('builder D (M2): domain seeds generate, the harness knows the domains, the Reference folds the M2 kinds (internal-contracts §27.2, §31, §32)',
					() =>
					{
						[ './fixtures/ProjectTrack-Seed.js', './fixtures/LabTrack-Seed.js' ].forEach(
							(pPath) =>
							{
								let libSeed = require(pPath);
								[ 'generate', 'build', 'model', 'prng', 'createTables' ].forEach((pName) => { Expect(libSeed[pName], `${pPath} ${pName}`).to.be.a('function'); });
								Expect(libSeed.TEST_NOW).to.equal('2026-10-08T12:00:00Z');
								Expect(libSeed.GENERATION_ORDER.slice().sort()).to.deep.equal(Object.keys(libSeed.model().Tables).sort());
							});
						let libCommon = require('./fixtures/Domain-Seed-Common.js');
						[ 'audit', 'insertRows', 'countRows', 'buildFromGenerated', 'completeRows' ].forEach((pName) => { Expect(libCommon[pName], pName).to.be.a('function'); });
						let libHarnessModule = require('./support/Facet-Test-Harness.js');
						Expect(Object.keys(libHarnessModule.DOMAINS)).to.deep.equal([ 'Bookstore', 'Bookstore-Tenant', 'ProjectTrack', 'LabTrack' ]);
						[ 'domainSeed', 'domainOptions', 'needsReferenceCount', 'internalOptions', 'policyBehavior', 'expectedExclusion', 'start' ].forEach((pName) => { Expect(libHarnessModule[pName], pName).to.be.a('function'); });
						let libReference = require(SOURCE + 'engine/Retold-Faceting-EngineReference.js');
						Expect(libReference.FOLD_KINDS).to.include.members([ 'ChildRollup', 'ExistsSplit' ]);
						Expect(libReference.CROSS_ENTITY_DIMENSIONS).to.deep.equal([ 'Multi', 'ChildAgg', 'ExistsFlag' ]);
						[ 'countBase', 'recordKeys', 'keys', 'listRows', 'evalPred' ].forEach((pName) => { Expect(libReference.prototype[pName], pName).to.be.a('function'); });
					});

				test('contracts (M4): the intake adapters, the Seq grammar, principalKey and Host.entityScopeColumns (internal-contracts §38.3, §38.5, §39.1, §41.2)',
					() =>
					{
						let libUtil = require(SOURCE + 'Retold-Faceting-Util.js');
						Expect(libUtil.parseSeq('e:4f0c2b9e:88121')).to.deep.equal({ Epoch: 'e:4f0c2b9e', N: 88121 });
						Expect(libUtil.parseSeq('e:4f0c2b9e:0')).to.deep.equal({ Epoch: 'e:4f0c2b9e', N: 0 });
						[ 'e:4f0c2b9e:01', 'e:4F0C2B9E:1', 'e:4f0c2b9:1', '4f0c2b9e:1', 'e:4f0c2b9e:-1', 'e:4f0c2b9e:1.5', 42, null ].forEach(
							(pBad) =>
							{
								Expect(libUtil.parseSeq(pBad), String(pBad)).to.equal(null);
							});
						Expect(libUtil.formatSeq('e:4f0c2b9e', 7)).to.equal('e:4f0c2b9e:7');
						// principalKey: stable across ResolvedAt / Source and value spellings, sensitive to identity.
						let tmpKey = libUtil.principalKey({ Kind: 'User', IDUser: 42, IDCustomer: 7, ScopeValues: { IDCustomer: 7, OwnerIDUser: 42 }, RoleSetHash: '', ResolvedAt: 1, Source: 'InProcess' });
						Expect(tmpKey).to.match(/^pk:[0-9a-f]{16}$/);
						Expect(libUtil.principalKey({ Kind: 'User', IDUser: '42', IDCustomer: ' 7', ScopeValues: { OwnerIDUser: '42', IDCustomer: 7 }, RoleSetHash: '', ResolvedAt: 2, Source: 'Other' })).to.equal(tmpKey);
						Expect(libUtil.principalKey({ Kind: 'User', IDUser: 43, IDCustomer: 7, ScopeValues: { IDCustomer: 7, OwnerIDUser: 43 }, RoleSetHash: '' })).to.not.equal(tmpKey);
						Expect(libUtil.principalKey(null)).to.equal(null);

						let libInterim = require(SOURCE + 'change/Change-Intake-Interim.js');
						let libBus = require(SOURCE + 'change/Change-Intake-Bus.js');
						Expect(libInterim).to.be.a('function');
						Expect(libInterim.INTAKE_MARKER).to.equal(Symbol.for('RetoldFaceting.Intake'));
						Expect(libBus).to.be.a('function');
						let libIntake = require(SOURCE + 'change/Retold-Faceting-ChangeIntake.js');
						let tmpIntake = new libIntake(newFable());
						Expect(tmpIntake.NodeEpoch).to.match(libUtil.NODE_EPOCH_PATTERN);
						Expect(tmpIntake.currentSeq()).to.equal(`${tmpIntake.NodeEpoch}:0`);
						Expect(tmpIntake.Interim).to.be.an.instanceof(libInterim);
						Expect(tmpIntake.Bus).to.be.an.instanceof(libBus);
						Expect(tmpIntake.Bus.available()).to.equal(false);
						Expect(Object.keys(libIntake.INTERIM_SLOTS)).to.deep.equal([ 'Create-PostOperation', 'Update-PostOperation', 'Delete-PostOperation', 'Undelete-PostOperation' ]);

						let libGenerations = require(SOURCE + 'cache/Retold-Faceting-Generations.js');
						Expect(libGenerations.tenantKey(7)).to.equal('7');
						Expect(libGenerations.tenantKey('7', 42)).to.equal('7/42');
						Expect(libGenerations.tenantKey(7, 0)).to.equal('7/*');
						Expect(libGenerations.tenantKey(0)).to.equal('*');
						Expect(libGenerations.tenantKey('*', 42)).to.equal('*');
						Expect(libGenerations.tenantKey('#none', 42)).to.equal('#none/42');
						Expect(libGenerations.tenantKey('a/b*|c')).to.equal('a%2Fb%2A%7Cc');
						Expect(libGenerations.genKey('Project', '7', '#row')).to.equal('Project|7|#row');
						Expect(new libGenerations(newFable()).BootEpoch).to.match(/^g:[0-9a-f]{8}$/);
						let libCacheKey = require(SOURCE + 'security/Retold-Faceting-CacheKey.js');
						Expect(new libCacheKey(newFable()).version('ck:x', 'g:y')).to.match(/^fv1:[0-9a-f]{16}$/);

						// Host.entityScopeColumns (§41.2) over a tiny model.
						let libHostBase = require(SOURCE + 'host/Retold-Faceting-Host-Base.js');
						let fColumns = (pNames) => { return pNames.map((pName) => { return { Column: pName }; }); };
						let tmpModel = { Tables:
							{
								Project: { Columns: fColumns([ 'IDProject', 'IDCustomer', 'Status', 'Deleted' ]) },
								LabForm: { Columns: fColumns([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'Status', 'Deleted' ]) },
								FormType: { Columns: fColumns([ 'IDFormType', 'Name' ]) }
							} };
						class TinyHost extends libHostBase
						{
							getModelSync()
							{
								return tmpModel;
							}

							getScopePolicy()
							{
								return this.buildScopePolicy(this.options.Scope, (pEntity, pColumn) => { return this.entityHasColumn(pEntity, pColumn); });
							}

							getDeleteColumn(pEntity)
							{
								return this.entityHasColumn(pEntity, 'Deleted') ? 'Deleted' : null;
							}

							getPrimaryKey(pEntity)
							{
								return `ID${pEntity}`;
							}
						}
						let tmpHost = new TinyHost(newFable(), { Scope: { Policy: { Column: 'IDCustomer', SessionField: 'CustomerID', Exclude: [ 'FormType' ], PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' } } } } });
						Expect(tmpHost.entityScopeColumns('Project')).to.deep.include({ Kind: 'Tenant', TenantColumn: 'IDCustomer', OwnerColumn: null, DeleteColumn: 'Deleted', PrimaryKey: 'IDProject' });
						Expect(tmpHost.entityScopeColumns('Project').RowColumns).to.deep.equal([ 'Deleted', 'IDCustomer', 'IDProject' ]);
						Expect(tmpHost.entityScopeColumns('LabForm')).to.deep.include({ Kind: 'Personal', TenantColumn: 'IDCustomer', OwnerColumn: 'OwnerIDUser' });
						Expect(tmpHost.entityScopeColumns('LabForm').RowColumns).to.deep.equal([ 'Deleted', 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ]);
						Expect(tmpHost.entityScopeColumns('FormType')).to.deep.include({ Kind: 'Global', TenantColumn: null, OwnerColumn: null, DeleteColumn: null });
						Expect(new TinyHost(newFable(), {}).entityScopeColumns('Project').Kind).to.equal('Unscoped');
					});

				test('wiring (M2): the Records / Count / Keys pipeline, the Bind stage, the route handlers and the request modes (internal-contracts §22.6, §28)',
					() =>
					{
						let libService = require(SOURCE + 'Retold-Faceting-Service.js');
						[ 'records', 'count', 'keys', 'baseInternal', 'stageBase', 'recordsPage', 'hydrate', 'baseVersion', 'withPathScope',
							'stageGuard', 'stageBind', 'stagePlan', 'stageRecords', 'bindHash', 'rebuildCatalog' ].forEach((pName) => { Expect(libService.prototype[pName], pName).to.be.a('function'); });
						let libRoutes = require(SOURCE + 'routes/Retold-Faceting-Routes.js');
						[ 'handleQuery', 'handleRecords', 'handleCount', 'handleKeys', 'routeBody', 'routeEntity' ].forEach((pName) => { Expect(libRoutes.prototype[pName], pName).to.be.a('function'); });
						let libRequest = require(SOURCE + 'contract/Facet-Contract-Request.js');
						Expect(libRequest.MILESTONE).to.equal(2);
						Expect(libRequest.REQUEST_MODES).to.deep.equal([ 'Query', 'Records', 'Count', 'Keys' ]);
						[ 'normalizeScopes', 'normalizeParams', 'normalizeRecordsPage' ].forEach((pName) => { Expect(libRequest[pName], pName).to.be.a('function'); });
						Expect(libRequest.FOLDS).to.include.members([ 'ChildRollup', 'ExistsSplit' ]);
						Expect(libRequest.LIMIT_DEFAULTS).to.include({ MaxRecordsPage: 500, MaxRecordsOffset: 10000, MaxKeys: 50000 });
						let libPlanner = require(SOURCE + 'plan/Retold-Faceting-Planner.js');
						Expect(libPlanner.prototype.checkRequestParams).to.be.a('function');
					});
			}
		);
	}
);
