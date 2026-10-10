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
		[ 'routes/Retold-Faceting-SSE.js', 'RetoldFacetingSSE' ],
		// Milestone 5 (internal-contracts §53.3)
		[ 'store/Retold-Faceting-StoreBase.js', 'RetoldFacetingStoreBase' ],
		[ 'store/clickhouse/Retold-Faceting-StoreClickHouse.js', 'RetoldFacetingStoreClickHouse' ],
		[ 'persistence/Retold-Faceting-MirrorSpec.js', 'RetoldFacetingMirrorSpec' ],
		[ 'persistence/Retold-Faceting-Materializer.js', 'RetoldFacetingMaterializer' ],
		[ 'persistence/Retold-Faceting-WriterLoop.js', 'RetoldFacetingWriterLoop' ],
		[ 'persistence/Retold-Faceting-WriterClock.js', 'RetoldFacetingWriterClock' ],
		[ 'persistence/Retold-Faceting-PendingSet.js', 'RetoldFacetingPendingSet' ],
		[ 'persistence/Retold-Faceting-FlushBuffer.js', 'RetoldFacetingFlushBuffer' ],
		[ 'persistence/MaterializeSource-InProcess.js', 'RetoldFacetingMaterializeSourceInProcess' ],
		[ 'persistence/Retold-Faceting-Freshness.js', 'RetoldFacetingFreshness' ],
		[ 'persistence/Retold-Faceting-Rebuilder.js', 'RetoldFacetingRebuilder' ],
		[ 'persistence/Retold-Faceting-Reconciler.js', 'RetoldFacetingReconciler' ],
		[ 'engine/Retold-Faceting-EngineClickHouse.js', 'RetoldFacetingEngineClickHouse' ]
	]);

// [ relative path, required export names ] for every pure / function module
const PURE_MODULES = (
	[
		[ 'Retold-Faceting-Service-Options.js', [ 'DEFAULTS', 'ROUTE_RESERVED_NAMES', 'NEVER_FACETABLE', 'resolve', 'deepMerge', 'hasScopePolicy', 'STORE_DEFAULTS' ] ],
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
		[ 'engine/live/Shell-Templates-MSSQL.js', [ 'Dialect', 'Templates', 'Expressions' ] ],
		// Milestone 5 (internal-contracts §53.3): the pure ClickHouse modules
		[ 'store/clickhouse/ClickHouse-TypeMap.js', [ 'TYPE_MAP_VERSION', 'DATETIME_MIN', 'DATETIME_MAX', 'mirrorType', 'baseType', 'paramType', 'isNullableType', 'toStoreValue', 'toStoreRow', 'fromStoreValue', 'canonicalDateLiteral' ] ],
		[ 'store/clickhouse/ClickHouse-DDL.js', [ 'DDL_VERSION', 'IDENTIFIER_PATTERN', 'META_COLUMNS', 'STATE_TABLE', 'KEYMAP_PREFIX', 'SHADOW_INFIX', 'sanitizeInstanceKey', 'databaseName', 'quoteIdentifier', 'qualified', 'mirrorTableName', 'keymapTableName', 'createDatabaseDDL', 'mirrorDDL', 'keymapDDL', 'entityStateDDL', 'addColumnsDDL', 'exchangeDDL', 'renameDDL', 'dropTableDDL', 'specComment', 'parseSpecComment' ] ],
		[ 'store/clickhouse/ClickHouse-FoldCompiler.js', [ 'COMPILER_VERSION', 'OPERATOR_MAP', 'READ_SETTINGS', 'REASON_CLASSES', 'paramName', 'compileFilter', 'compileRelation', 'compileFoldPred', 'dimensionExpression', 'compileAgg', 'compileCube' ] ]
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

				test('contracts (M5): the ClickHouse client, the store names, the writer clock, the M5 options and the module boundaries (internal-contracts §53–§58, §69)',
					() =>
					{
						let libFS = require('fs');
						let libPath = require('path');
						// The pure store modules and the client require nothing outside contract/ and store/clickhouse/ (they move to
						// meadow-connection-clickhouse unchanged, §53.3).
						[ 'store/clickhouse/ClickHouse-Client.js', 'store/clickhouse/ClickHouse-TypeMap.js', 'store/clickhouse/ClickHouse-DDL.js', 'store/clickhouse/ClickHouse-FoldCompiler.js' ].forEach(
							(pFile) =>
							{
								let tmpSource = libFS.readFileSync(libPath.join(__dirname, SOURCE, pFile), 'utf8');
								(tmpSource.match(/require\(\s*['"`][^'"`]+['"`]\s*\)/g) || []).forEach(
									(pRequire) =>
									{
										let tmpTarget = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(pRequire)[1];
										let tmpAllowed = [ 'http', 'https', 'crypto' ].indexOf(tmpTarget) >= 0
											|| /^\.\/ClickHouse-[A-Za-z]+\.js$/.test(tmpTarget)
											|| /^\.\.\/\.\.\/contract\/Facet-Contract-[A-Za-z]+\.js$/.test(tmpTarget);
										Expect(tmpAllowed, `${pFile}: ${pRequire}`).to.equal(true);
									});
							});

						// The client: a plain class; parameters render as ClickHouse literals, never into SQL text.
						let libClient = require(SOURCE + 'store/clickhouse/ClickHouse-Client.js');
						let tmpClient = new libClient({ URL: 'http://127.0.0.1:18123', User: 'rfs_test', Password: 'secret' });
						Expect(tmpClient.formatParam(null)).to.equal('\\N');
						Expect(tmpClient.formatParam(7)).to.equal('7');
						Expect(tmpClient.formatParam(true)).to.equal('1');
						Expect(tmpClient.formatParam("it's")).to.equal("it's");
						Expect(tmpClient.formatParam([ 1, 2 ])).to.equal('[1,2]');
						Expect(tmpClient.formatParam([ "a'b", 'c\\d', null ])).to.equal("['a\\'b','c\\\\d',NULL]");
						Expect(() => { return new libClient({ URL: 'http://user:pw@127.0.0.1:18123' }); }).to.throw(/credentials/);
						Expect(libClient.redact('bad secret here', 'secret')).to.equal('bad <redacted> here');
						Expect(libClient.normalizeRows([ { N: '42', B: '18446744073709551615', S: '7' } ], [ { name: 'N', type: 'UInt64' }, { name: 'B', type: 'UInt64' }, { name: 'S', type: 'String' } ]))
							.to.deep.equal([ { N: 42, B: '18446744073709551615', S: '7' } ]);

						// Names (§56.1).
						let libDDL = require(SOURCE + 'store/clickhouse/ClickHouse-DDL.js');
						Expect(libDDL.sanitizeInstanceKey('sluice-juicebox')).to.equal('sluice_juicebox');
						Expect(libDDL.databaseName('main')).to.equal('rfs_main');
						Expect(libDDL.databaseName('main', 'rfs_123_4')).to.equal('rfs_123_4');
						Expect(() => { return libDDL.databaseName('main', 'bad-name'); }).to.throw();
						Expect(libDDL.qualified('rfs_main', 'LabForm')).to.equal('`rfs_main`.`LabForm`');
						Expect(libDDL.mirrorTableName('LabForm', '0a1b2c3d')).to.equal('LabForm__shadow_0a1b2c3d');
						Expect(libDDL.keymapTableName('LabForm')).to.equal('_rfs_keys_LabForm');
						Expect(libDDL.keymapTableName('LabForm', '0a1b2c3d')).to.equal('_rfs_keys_LabForm__shadow_0a1b2c3d');
						Expect(() => { return libDDL.mirrorTableName('_rfs_entity_state'); }).to.throw();
						Expect(libDDL.createDatabaseDDL('rfs_main')).to.equal('CREATE DATABASE IF NOT EXISTS `rfs_main` ENGINE = Atomic');

						// Targets, the writer clock (§54.3, §58.4).
						let libStoreBase = require(SOURCE + 'store/Retold-Faceting-StoreBase.js');
						Expect(libStoreBase.TARGET_LIVE).to.equal('Live');
						Expect(libStoreBase.shadowTarget('0a1b2c3d')).to.equal('Shadow:0a1b2c3d');
						Expect(libStoreBase.isShadowTarget('Shadow:0a1b2c3d')).to.equal('0a1b2c3d');
						Expect(libStoreBase.isShadowTarget('Live')).to.equal(null);
						let libClock = require(SOURCE + 'persistence/Retold-Faceting-WriterClock.js');
						let tmpClock = new libClock(newFable());
						let tmpFirst = tmpClock.next();
						Expect(tmpClock.next()).to.be.above(tmpFirst);
						Expect(tmpClock.seed(tmpFirst + 1e12)).to.equal(tmpFirst + 1e12);
						Expect(tmpClock.next()).to.equal(tmpFirst + 1e12 + 1);
						Expect(tmpClock.seed(5)).to.equal(tmpFirst + 1e12 + 1);
						Expect(libClient).to.be.a('function');
						Expect(require(SOURCE + 'store/clickhouse/ClickHouse-TypeMap.js').paramType('Nullable(Int64)')).to.equal('Int64');

						// Options (§53.4): stores off by default, the M5 keys present.
						let libOptions = require(SOURCE + 'Retold-Faceting-Service-Options.js');
						let tmpOptions = libOptions.resolve({});
						Expect(tmpOptions.Stores.ClickHouse).to.equal(false);
						Expect(tmpOptions.Materializer.Enabled).to.equal('Auto');
						Expect(tmpOptions.Reconcile.LeafRange).to.equal(2000);
						Expect(tmpOptions.Freshness.DefaultMode).to.equal('Exact');
						Expect(tmpOptions.Admin.Routes).to.equal(false);
						Expect(libOptions.STORE_DEFAULTS.ClickHouse.ExposeReasons).to.equal(false);
						Expect(require(SOURCE + 'persistence/Retold-Faceting-MirrorSpec.js').MATERIALIZE_SCHEMA.title).to.equal('RetoldFaceting.Materialize');
						Expect(require(SOURCE + 'engine/Retold-Faceting-EngineClickHouse.js').ENGINE_NAME).to.equal('ClickHouse');
						// Builder C (§63, §64): the engine's dry-run compile and the static-mirror seam, the capture
						// entry point, the compiler's relation collector; every reason class (ShapeUnsupported added).
						let libEngineClickHouse = require(SOURCE + 'engine/Retold-Faceting-EngineClickHouse.js');
						[ 'capable', 'freshness', 'execute', 'compile', 'useStaticMirrors' ].forEach((pMethod) => { Expect(libEngineClickHouse.prototype[pMethod], pMethod).to.be.a('function'); });
						Expect(require(SOURCE + 'engine/live/Retold-Faceting-ScopedRelationBuilder.js').prototype.captureRelation).to.be.a('function');
						let libFoldCompilerSmoke = require(SOURCE + 'store/clickhouse/ClickHouse-FoldCompiler.js');
						Expect(libFoldCompilerSmoke.collectRelations).to.be.a('function');
						Expect(libFoldCompilerSmoke.REASON_CLASSES).to.include.members([ 'NotMirrored', 'LossyColumn', 'ScopeMissing', 'OpaqueScope', 'StoreError', 'ShapeUnsupported' ]);
						Expect(libFoldCompilerSmoke.compileFilter({ Entity: 'Smoke', Identity: 'IDSmoke', Columns: [ { Column: 'IDSmoke', Mirror: 'Int64' } ] }, [ { Column: 'IDSmoke', Operator: '=', Value: 7, Connector: 'AND' } ], { SourceDialect: 'SQLite' }))
							.to.deep.equal({ SQL: '`IDSmoke` = {w_0:Int64}', Params: { w_0: 7 }, Types: { w_0: 'Int64' } });

						// The test container helper only ever targets its own container (§69.1).
						let libDocker = require('./support/Facet-Docker-ClickHouse.js');
						Expect(libDocker.CONTAINER_NAME).to.equal('rfs-test-clickhouse');
						Expect(libDocker.IMAGE).to.equal('clickhouse/clickhouse-server:24.8');
						Expect(() => { return libDocker.assertOwnContainer([ 'stop', 'rfs-test-postgres' ]); }).to.throw();
						Expect(() => { return libDocker.assertOwnContainer([ 'exec', 'rfs-test-clickhouse', 'sh' ]); }).to.throw();
						Expect(() => { return libDocker.assertOwnContainer(libDocker.runArguments()); }).to.not.throw();
						Expect(libDocker.runArguments()).to.include('127.0.0.1:18123:8123');
					});

				test('builder D (M5): the Rebuilder and the Reconciler surface (internal-contracts §59.4, §60, §68 #32–#33)',
					() =>
					{
						let libRebuilder = require(SOURCE + 'persistence/Retold-Faceting-Rebuilder.js');
						let libReconciler = require(SOURCE + 'persistence/Retold-Faceting-Reconciler.js');
						Expect(libRebuilder.REBUILD_REASONS).to.deep.equal([ 'Admin', 'SpecChange', 'Divergence', 'Wipe' ]);
						Expect(libRebuilder.PHASES).to.deep.equal([ 'Pages', 'Swapping', 'CatchingUp' ]);
						Expect(libReconciler.LEVELS).to.deep.equal([ 'Sweep', 'Bisect', 'Scrub', 'Verify' ]);
						[ 'backfill', 'rebuild', 'status', 'cancel', 'lastCompleted', 'stateFields', 'stop', 'stats' ].forEach((pName) => { Expect(libRebuilder.prototype[pName], pName).to.be.a('function'); });
						[ 'start', 'stop', 'sweep', 'bisect', 'scrub', 'verify', 'status', 'isRunning', 'stateFields', 'stats' ].forEach((pName) => { Expect(libReconciler.prototype[pName], pName).to.be.a('function'); });
						// Constructing them starts nothing (no timer, no run) until start() / a call.
						let tmpReconciler = new libReconciler(newFable());
						Expect(tmpReconciler.stats().Timers).to.equal(0);
						Expect(tmpReconciler.status('ClickHouse', 'Nope')).to.deep.include({ Watermark: null, Running: [] });
						Expect(new libRebuilder(newFable()).status('ClickHouse', 'Nope')).to.equal(null);
						// A BuildID is a shadow-target BuildID.
						Expect(libRebuilder.newBuildID()).to.match(/^[0-9a-f]{8}$/);
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

				test('wiring (M5): installStores / storeAdmin / the admin routes, the Router\'s store engines, Engine on the request, Store in the envelope and the cache (internal-contracts §54.2, §60.5, §62)',
					() =>
					{
						let libService = require(SOURCE + 'Retold-Faceting-Service.js');
						[ 'installStores', 'storeRegistered', 'storeAvailability', 'storeAdmin', 'storeAdminRefusal', 'adminRequest', 'shutdownM4',
							'engineFields', 'envelopeEngineFields', 'storeBlock', 'cachedStoreBlock', 'storeMeta', 'storeAnswered', 'describeStoreEngine', 'describeEntityStore' ].forEach((pName) => { Expect(libService.prototype[pName], pName).to.be.a('function'); });
						let libRoutes = require(SOURCE + 'routes/Retold-Faceting-Routes.js');
						Expect(libRoutes.prototype.handleAdmin).to.be.a('function');
						let libRequest = require(SOURCE + 'contract/Facet-Contract-Request.js');
						Expect(libRequest.REQUEST_ENGINES).to.deep.equal([ 'Auto', 'Live' ]);
						Expect(libRequest.normalizeRequest('E', { Facets: [ { Facet: 'E.A' } ] }).Engine).to.equal('Auto');
						Expect(require(SOURCE + 'contract/Facet-Contract-Envelope.js').VOLATILE_FIELDS).to.include('Store');
						Expect(require(SOURCE + 'security/Retold-Faceting-CacheKey.js').UNCACHEABLE_REASONS).to.include('Store');
						// A store engine registers BEFORE Live, idempotently; the M4 whole-request rule never picks it.
						let tmpFable = newFable();
						let libRouter = require(SOURCE + 'engine/Retold-Faceting-Router.js');
						let tmpRouter = new libRouter(tmpFable);
						let tmpLive = { EngineName: 'Live', execute: () => {}, capable: () => { return { Capable: true }; } };
						let tmpStore = { EngineName: 'ClickHouse', execute: () => {}, capable: () => { return { Capable: true }; } };
						tmpRouter.register(tmpLive);
						Expect(tmpRouter.storeEngine()).to.equal(null);
						tmpRouter.register(tmpStore, { Store: true });
						tmpRouter.register(tmpStore, { Store: true });
						Expect(tmpRouter.engineNames()).to.deep.equal([ 'ClickHouse', 'Live' ]);
						Expect(tmpRouter.storeEngine()).to.equal(tmpStore);
						Expect(tmpRouter.restrictCubes([ { CubeId: 'c', Members: [ { AggKey: 'A' }, { AggKey: 'B' } ] }, { CubeId: 'd', Members: [ { AggKey: 'C' } ] } ], [ { Key: 'B' } ])).to.deep.equal([ { CubeId: 'c', Members: [ { AggKey: 'B' } ] } ]);
						Expect(tmpRouter.unregister(tmpStore)).to.equal(true);
						Expect(tmpRouter.engineNames()).to.deep.equal([ 'Live' ]);
						// A service without Stores.ClickHouse: nothing registered, Describe says Configured false.
						let tmpService = new libService(newFable(), {});
						Expect(tmpService.installStores()).to.deep.equal({ Configured: false, Available: false, Reason: null });
						Expect(tmpService.storeRegistered()).to.equal(false);
						Expect(tmpService.storeAvailability()).to.deep.equal({ Configured: false, Available: false, Reason: null });
						Expect(tmpService.storeAdminRefusal('Rebuild', 'ClickHouse', 'Task').Code).to.equal('FACET_UNKNOWN_ENTITY');
						Expect(tmpService.storeAdminRefusal('Explode', 'ClickHouse', 'Task').Code).to.equal('FACET_REQUEST_INVALID');
					});
			}
		);
	}
);
