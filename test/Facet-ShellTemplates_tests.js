/**
 * Facet-ShellTemplates tests (oracle O9): the shell registry (tag scan, required templates,
 * dry-build on every dialect, scalar-only binds, identifier whitelist), the Dialects harvest
 * (rename, '::' / '@@' skipping, MSSQL array expansion and parameterTypes), SQLite expression parity
 * with the canonical contract math (dates and integer-unit indexes, executed on node:sqlite), and the
 * SQL text + parameter-map GOLDENS per fold per dialect, compiled through a real behavior-scoped
 * Scoped Relation (route-bound meadow-endpoints controller with a tenancy behavior, FilterAST
 * conjuncts, explicit soft-delete).  SQLite goldens are also executed.
 *
 * Goldens live in test/goldens/Facet-ShellTemplates-Goldens.json.  Regenerate (then REVIEW the diff):
 *   FACET_UPDATE_GOLDENS=1 npx mocha --no-package --ui tdd --timeout 10000 test/Facet-ShellTemplates_tests.js
 *
 * No port (nothing listens).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFS = require('fs');
const libPath = require('path');
const { DatabaseSync } = require('node:sqlite');

const libMeadow = require('meadow');
const libMeadowEndpoints = require('meadow-endpoints');
const libFoxHound = require('foxhound');

const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const libRetoldFacetingDialects = require('../source/engine/live/Retold-Faceting-Dialects.js');
const libRetoldFacetingShellTemplates = require('../source/engine/live/Retold-Faceting-ShellTemplates.js');
const libRetoldFacetingScopedRelationBuilder = require('../source/engine/live/Retold-Faceting-ScopedRelationBuilder.js');
const libRetoldFacetingScopeCapture = require('../source/security/Retold-Faceting-ScopeCapture.js');
const libRetoldFacetingScopeGuard = require('../source/security/Retold-Faceting-ScopeGuard.js');
const libRetoldFacetingEngineLive = require('../source/engine/Retold-Faceting-EngineLive.js');
const libRetoldFacetingFilterAST = require('../source/request/Retold-Faceting-FilterAST.js');

const libShellSQLite = require('../source/engine/live/Shell-Templates-SQLite.js');

const GOLDEN_FILE = libPath.join(__dirname, 'goldens', 'Facet-ShellTemplates-Goldens.json');
const UPDATE_GOLDENS = (process.env.FACET_UPDATE_GOLDENS === '1');

const DIALECTS = [ 'SQLite', 'PostgreSQL', 'MySQL', 'MSSQL' ];

const ENTITY = 'BookStoreSale';

const newFable = () => { return libBuilders.newFable('RetoldFacetingShellTest'); };

/**
 * Register the live-engine services (and the real FilterAST) on a fable.
 *
 * @param {any} pFable
 * @param {Record<string, any>} pOptions - resolved RetoldFaceting options
 */
const registerLiveServices = (pFable, pOptions) =>
{
	[
		[ 'RetoldFacetingDialects', libRetoldFacetingDialects ],
		[ 'RetoldFacetingShellTemplates', libRetoldFacetingShellTemplates ],
		[ 'RetoldFacetingScopeGuard', libRetoldFacetingScopeGuard ],
		[ 'RetoldFacetingScopeCapture', libRetoldFacetingScopeCapture ],
		[ 'RetoldFacetingScopedRelationBuilder', libRetoldFacetingScopedRelationBuilder ],
		[ 'RetoldFacetingEngineLive', libRetoldFacetingEngineLive ],
		[ 'RetoldFacetingFilterAST', libRetoldFacetingFilterAST ]
	].forEach(
		(pEntry) =>
		{
			pFable.addServiceType(pEntry[0], pEntry[1]);
			pFable.instantiateServiceProvider(pEntry[0], pOptions);
		});
};

const conjunct = libBuilders.conjunct;

// The golden filter: an IN, a numeric comparison and an Or holding a NULL test (dialect-specific NULL rendering).
const GOLDEN_CONJUNCTS = (
	[
		conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit', 'Cash' ] }),
		conjunct('c2', { Field: 'TotalAmount', Op: 'GE', Value: 10 }),
		conjunct('c3', { Or: [ { Field: 'SaleDate', Op: 'NULL' }, { Field: 'SaleDate', Op: 'LT', Value: '2024-01-01 00:00:00' } ] })
	]);

/**
 * The column info the catalog would give a Stats / DistinctCount / Missing Agg.
 *
 * @param {string} pDataType
 * @param {number} pScale
 * @return {Record<string, any>}
 */
const fieldInfo = (pDataType, pScale) =>
{
	return { DataType: pDataType, Scale: pScale, IsInteger: (pScale === 0) && (pDataType !== 'DateTime') };
};

// One Agg per golden fold (internal-contracts §5.1 subset the engine reads).
const GOLDEN_AGGS = (
	{
		Count: { Key: '#Total', Kind: 'Count', Dimensions: [] },
		Terms: { Key: 'ByPayment', Kind: 'Terms', Top: 5, Order: 'CountDesc', Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String', IsInteger: false, Scale: 0 } ] },
		TermsKeyAsc: { Key: 'ByStoreKey', Kind: 'Terms', Top: 5, Order: 'KeyAsc', Dimensions: [ { Kind: 'Column', Field: 'IDBookStore', DataType: 'Numeric', IsInteger: true, Scale: 0 } ] },
		DateHistogramMonth: { Key: 'ByMonth', Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'month' } ] },
		DateHistogramWeek: { Key: 'ByWeek', Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'week' } ] },
		DateHistogramQuarter: { Key: 'ByQuarter', Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'quarter' } ] },
		NumericHistogramNice: { Key: 'ByAmount', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice', Buckets: 10, Edges: null, OpenEnded: false, IsInteger: false, Scale: 2 } ], Geometry: { Mode: 'Nice', Factor: 100, LoUnits: 0, WidthUnits: 50000, N: 10 } },
		NumericHistogramEdges: { Key: 'ByAmountEdges', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Edges', Buckets: null, Edges: [ 0, 25, 100, 1000 ], OpenEnded: true, IsInteger: false, Scale: 2 } ] },
		Ranges: { Key: 'AmountBands', Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'small', From: null, To: 25, Label: 'Small' }, { Key: 'medium', From: 25, To: 250, Label: 'Medium' }, { Key: 'large', From: 250, To: null, Label: 'Large' } ], IsInteger: false, Scale: 2 } ] },
		StatsDecimal: { Key: 'AmountStats', Kind: 'Stats', Field: 'TotalAmount', FieldInfo: fieldInfo('Decimal', 2), Dimensions: [] },
		StatsDate: { Key: 'SaleDateStats', Kind: 'Stats', Field: 'SaleDate', FieldInfo: fieldInfo('DateTime', 0), Dimensions: [] },
		DistinctCount: { Key: 'PaymentDistinct', Kind: 'DistinctCount', Field: 'PaymentMethod', FieldInfo: fieldInfo('String', 0), Dimensions: [] },
		MissingDate: { Key: 'SaleDateMissing', Kind: 'Missing', Field: 'SaleDate', FieldInfo: fieldInfo('DateTime', 0), Dimensions: [] },
		PivotColumnDate: { Key: 'PaymentByYear', Kind: 'Pivot', Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String', IsInteger: false, Scale: 0 }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'year' } ] },
		PivotRangeColumn: { Key: 'BandByStore', Kind: 'Pivot', Dimensions: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'small', From: null, To: 25 }, { Key: 'large', From: 25, To: null } ], IsInteger: false, Scale: 2 }, { Kind: 'Column', Field: 'IDBookStore', DataType: 'Numeric', IsInteger: true, Scale: 0 } ] }
	});

/**
 * A minimal in-memory host for one entity: a meadow DAL (no connection needed to compile), a
 * meadow-endpoints controller carrying a tenancy behavior, and an IDTenant policy.
 *
 * @param {any} pFable
 * @param {string} pDialectName
 * @return {Record<string, any>}
 */
const newGoldenHost = (pFable, pDialectName) =>
{
	let tmpModel = libBookstoreSeed.model('Bookstore-Tenant');
	let tmpDAL = libMeadow.new(pFable).loadFromPackageObject(tmpModel.Tables[ENTITY].MeadowSchema);
	let tmpController = new libMeadowEndpoints(tmpDAL).controller;
	tmpController.BehaviorInjection.setBehavior('Reads-QueryConfiguration',
		function (pRequest, pRequestState, fCallback)
		{
			if (!pRequestState.SessionData || !pRequestState.SessionData.IDTenant)
			{
				return fCallback(this.ErrorHandler.getError('Authentication required.', 401));
			}
			pRequestState.Query.addFilter('IDTenant', pRequestState.SessionData.IDTenant, '=', 'AND', 'TestTenancy');
			return fCallback();
		});
	return (
		{
			DAL: tmpDAL,
			Model: tmpModel,
			Controller: tmpController,
			getDAL: () => { return tmpDAL; },
			getExecutionDAL: () => { return tmpDAL; },
			getRouteBoundController: () => { return tmpController; },
			getDialectProfile: () => { return { Name: pDialectName }; },
			hasDeleteColumn: () => { return true; },
			getDeleteColumn: () => { return 'Deleted'; },
			getPrimaryKey: () => { return 'IDBookStoreSale'; },
			getScopePolicy: () =>
			{
				return (
					{
						Kind: 'Policy', Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [], PersonalScopes: {}, Required: {},
						UnsetValues: [ 0, '', null ], Guard: 'Strict',
						requiredFor: (pEntity, pPrincipal) => { return [ { Column: 'IDTenant', Value: (pPrincipal && pPrincipal.ScopeValues) ? pPrincipal.ScopeValues.IDTenant : undefined } ]; },
						isScoped: () => { return true; }
					});
			}
		});
};

/**
 * A request context for one dialect (tenant 1).
 *
 * @param {Record<string, any>} pHost
 * @param {string} pDialectName
 * @param {Record<string, any>} pOptions
 * @return {Record<string, any>}
 */
const newGoldenContext = (pHost, pDialectName, pOptions) =>
{
	return (
		{
			RequestID: 'rfq-golden',
			Entity: ENTITY,
			Request: { params: { Entity: ENTITY }, headers: {}, query: {}, UserSession: { LoggedIn: true, UserID: 1, IDTenant: 1, CustomerID: 1 } },
			Host: pHost,
			Options: pOptions,
			Principal: Object.freeze({ Kind: 'User', Source: 'InProcess', IDUser: 1, IDCustomer: 1, ScopeValues: { IDTenant: 1 }, UserRecord: {}, RoleSetHash: '', ResolvedAt: 0 }),
			Variants: { v0: { VariantId: 'v0', Hash: 'c1,c2,c3', Entity: ENTITY, ConjunctIds: [ 'c1', 'c2', 'c3' ], Conjuncts: GOLDEN_CONJUNCTS, ExcludedIds: [], IncludesDeleted: false, Facets: [] } },
			Dialect: pDialectName,
			Now: '2026-10-08T15:02:11.120Z',
			Deadline: Date.now() + 60000,
			Memo: { Relations: {}, Captures: {}, VariantRows: {} },
			Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
			Warnings: []
		});
};

/**
 * Every bind name referenced in a statement (string literals stripped; '::' and '@@' skipped).
 *
 * @param {string} pSQL
 * @param {string} pSigil
 * @return {Array<string>}
 */
const referencedBinds = (pSQL, pSigil) =>
{
	let tmpSQL = pSQL.replace(/'[^']*'/g, "''");
	let tmpPattern = (pSigil === '@') ? /(@{1,2})([A-Za-z_][A-Za-z0-9_]*)/g : /(:{1,2})([A-Za-z_][A-Za-z0-9_]*)/g;
	let tmpNames = {};
	let tmpMatch;
	while ((tmpMatch = tmpPattern.exec(tmpSQL)) !== null)
	{
		if (tmpMatch[1].length === 1)
		{
			tmpNames[tmpMatch[2]] = true;
		}
	}
	return Object.keys(tmpNames).sort();
};

/**
 * JSON-safe copy (stable key order for the golden file).
 *
 * @param {any} pValue
 * @return {any}
 */
const sortedCopy = (pValue) =>
{
	if (Array.isArray(pValue))
	{
		return pValue.map(sortedCopy);
	}
	if ((pValue === null) || (typeof(pValue) !== 'object'))
	{
		return pValue;
	}
	let tmpCopy = {};
	Object.keys(pValue).sort().forEach((pKey) => { tmpCopy[pKey] = sortedCopy(pValue[pKey]); });
	return tmpCopy;
};

suite
(
	'Facet-ShellTemplates',
	() =>
	{
		suite
		(
			'Registry',
			() =>
			{
				test('validateAll(): every dialect has every template and expression, passes the tag scan and dry-builds',
					() =>
					{
						let tmpRegistry = new libRetoldFacetingShellTemplates(newFable());
						Expect(tmpRegistry.validateAll().Errors).to.deep.equal([]);
						DIALECTS.forEach(
							(pDialect) =>
							{
								libRetoldFacetingShellTemplates.REQUIRED_TEMPLATES.forEach(
									(pTemplate) =>
									{
										Expect(tmpRegistry.dialect(pDialect).Templates, `${pDialect}.${pTemplate}`).to.have.property(pTemplate);
									});
							});
					});

				test('the tag scan rejects any tag outside the allowed slots and any code block',
					() =>
					{
						let tmpRegistry = new libRetoldFacetingShellTemplates(newFable());
						let tmpBogus = (
							{
								Dialect: 'SQLite',
								Templates: Object.assign({}, libShellSQLite.Templates,
									{
										Count: 'SELECT count(*) AS "Total" FROM (<%= _Params.SR0 %>) "p" WHERE <%= _Params.Filter %>',
										Missing: 'SELECT <% print(1) %> FROM (<%= _Params.SR0 %>) "p"'
									}),
								Expressions: libShellSQLite.Expressions
							});
						tmpRegistry._Dialects.SQLite = tmpBogus;
						let tmpErrors = tmpRegistry.validateAll().Errors.filter((pError) => { return pError.Dialect === 'SQLite'; });
						let tmpTags = tmpErrors.map((pError) => { return pError.Tag; });
						Expect(tmpTags).to.include('<%= _Params.Filter %>');
						Expect(tmpTags).to.include('<% print(1) %>');
					});

				test('render() binds only scalar f* values, never arrays; Edges and Ranges expand to scalars',
					() =>
					{
						let tmpRegistry = new libRetoldFacetingShellTemplates(newFable());
						DIALECTS.forEach(
							(pDialect) =>
							{
								let tmpEdges = tmpRegistry.render(pDialect, GOLDEN_AGGS.NumericHistogramEdges, { Geometry: { Mode: 'Edges', Edges: [ 0, 25, 100, 1000 ], OpenEnded: true } });
								Expect(tmpEdges.Bound).to.deep.equal({ fE0: 0, fE1: 25, fE2: 100, fE3: 1000 });
								let tmpRanges = tmpRegistry.render(pDialect, GOLDEN_AGGS.Ranges, {});
								Expect(tmpRanges.Bound).to.deep.equal({ fR0To: 25, fR1From: 25, fR1To: 250, fR2From: 250 });
								let tmpPivot = tmpRegistry.render(pDialect, GOLDEN_AGGS.PivotRangeColumn, {});
								// fMaxGroups bounds the cells returned (CubeMaxGroups + 1).
								Expect(Object.keys(tmpPivot.Bound).sort()).to.deep.equal([ 'fMaxGroups', 'fR0To', 'fR1From' ]);
								Expect(tmpPivot.Bound.fMaxGroups).to.equal(100001);
								Object.keys(tmpEdges.Bound).concat(Object.keys(tmpRanges.Bound)).forEach(
									(pName) =>
									{
										Expect(pName).to.match(/^f[A-Za-z0-9]+$/);
									});
								if (pDialect === 'MSSQL')
								{
									Expect(tmpEdges.ParamTypes).to.deep.equal({ fE0: 'Float', fE1: 'Float', fE2: 'Float', fE3: 'Float' });
								}
							});
						// A bound array (a malformed range bound) is refused, never bound.
						let tmpArrayRange = { Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'x', From: [ 1, 2 ], To: null } ] } ] };
						Expect(() => { tmpRegistry.render('SQLite', tmpArrayRange, {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						let tmpNaN = { Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice' } ] };
						Expect(() => { tmpRegistry.render('SQLite', tmpNaN, { Geometry: { Mode: 'Nice', Factor: NaN, LoUnits: 0, WidthUnits: 1, N: 1 } }); }).to.throw().with.property('Code', 'FACET_INTERNAL');
					});

				test('render() quotes only whitelisted identifiers and refuses anything else',
					() =>
					{
						let tmpRegistry = new libRetoldFacetingShellTemplates(newFable());
						let tmpEvil = { Kind: 'Terms', Top: 5, Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod" FROM x; --', DataType: 'String' } ] };
						Expect(() => { tmpRegistry.render('PostgreSQL', tmpEvil, {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						let tmpTerms = tmpRegistry.render('MySQL', GOLDEN_AGGS.Terms, {});
						Expect(tmpTerms.Slots.D0).to.equal('CONVERT(`p`.`PaymentMethod` USING utf8mb4) COLLATE utf8mb4_bin');
						Expect(tmpRegistry.render('MSSQL', GOLDEN_AGGS.Terms, {}).Slots.D0).to.equal('[p].[PaymentMethod] COLLATE Latin1_General_BIN2');
						Expect(tmpRegistry.render('PostgreSQL', GOLDEN_AGGS.Terms, {}).Slots.D0).to.equal('"p"."PaymentMethod"');
						// Terms: Top + 1 by count whatever the Order (the kept set is the top by count; Order only
						// re-sorts it), and never more than max(Top + 1, MaxTermsGroups) rows.
						Expect(tmpTerms.Bound).to.deep.equal({ fTopPlusOne: 6, fMaxGroups: 10000 });
						Expect(tmpTerms.Slots.P0).to.equal('');
						Expect(tmpRegistry.render('SQLite', GOLDEN_AGGS.TermsKeyAsc, {}).Bound).to.deep.equal({ fTopPlusOne: 6, fMaxGroups: 10000 });
						// No Top → Limits.DefaultTop (20).
						Expect(tmpRegistry.render('SQLite', Object.assign({}, GOLDEN_AGGS.Terms, { Top: null }), {}).Bound.fTopPlusOne).to.equal(21);
						// Selected keys bind one scalar each and are OR-ed into the row filter (never an array).
						let tmpSelected = tmpRegistry.render('SQLite', Object.assign({}, GOLDEN_AGGS.Terms, { SelectedKeys: [ 'Cash', 'Online' ] }), {});
						Expect(tmpSelected.Bound).to.deep.equal({ fTopPlusOne: 6, fMaxGroups: 10000, fS0: 'Cash', fS1: 'Online' });
						Expect(tmpSelected.Slots.P0).to.equal(' OR "r"."Key" IN (:fS0, :fS1)');
						Expect(tmpRegistry.render('MSSQL', Object.assign({}, GOLDEN_AGGS.Terms, { SelectedKeys: [ 3 ] }), {}).Slots.P0).to.equal(' OR [r].[Key] IN (@fS0)');
						// A numeric Terms key goes through numericValue (text in a numeric column is Missing).
						Expect(tmpRegistry.render('SQLite', { Kind: 'Terms', Top: 5, Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] }, {}).Slots.D0)
							.to.equal('CASE WHEN typeof("p"."Rating") IN (\'integer\', \'real\') THEN "p"."Rating" END');
						// Unknown dialect / fold
						Expect(() => { tmpRegistry.render('Oracle', GOLDEN_AGGS.Terms, {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { tmpRegistry.render('SQLite', { Kind: 'Bridge', Dimensions: [] }, {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { tmpRegistry.render('SQLite', { Kind: 'Pivot', Dimensions: [ GOLDEN_AGGS.NumericHistogramNice.Dimensions[0], GOLDEN_AGGS.Terms.Dimensions[0] ] }, {}); }).to.throw().with.property('Code', 'FACET_FOLD_UNSUPPORTED');
					});
			}
		);

		suite
		(
			'Dialects harvest',
			() =>
			{
				let _Dialects = null;
				let _Fable = null;

				suiteSetup(() =>
				{
					_Fable = newFable();
					_Dialects = new libRetoldFacetingDialects(_Fable);
				});

				test('rename is one maximal-munch pass: :p_w1 never eats the front of :p_w10; casts and @@ are left alone',
					() =>
					{
						let tmpParams = { Rating_w1: 1, Rating_w10: 2, x: 3 };
						Expect(_Dialects.renameParameters('a = :Rating_w1 AND b = :Rating_w10 AND c::numeric AND d = :x AND e = :unknown', tmpParams, 'p_', ':'))
							.to.equal('a = :p_Rating_w1 AND b = :p_Rating_w10 AND c::numeric AND d = :p_x AND e = :unknown');
						Expect(_Dialects.renameParameters('@x + @@DATEFIRST + @xx', { x: 1, xx: 2, DATEFIRST: 3 }, 'h1_', '@'))
							.to.equal('@h1_x + @@DATEFIRST + @h1_xx');
						Expect(_Dialects.renameParameters('"T"::text = :x', { text: 1, x: 2 }, 'p_', ':')).to.equal('"T"::text = :p_x');
					});

				test('harvest: SQLite IN expansion keys, trailing semicolon, renamed params',
					() =>
					{
						let tmpQuery = libFoxHound.new(_Fable).setScope('Sale');
						tmpQuery.addFilter('Method', [ 'a', 'b' ], 'IN', 'AND', 'c1_Method');
						tmpQuery.addFilter('Amount', 5, '>=', 'AND', 'c2_Amount');
						tmpQuery.setDialect('SQLite').buildReadQuery();
						Expect(tmpQuery.query.body).to.match(/;$/);
						let tmpHarvest = _Dialects.harvest(tmpQuery, 'p', 'SQLite');
						Expect(tmpHarvest.SQL).to.equal('SELECT * FROM Sale WHERE `Method` IN ( :p_c1_Method_w0_0, :p_c1_Method_w0_1 ) AND `Amount` >= :p_c2_Amount_w1');
						Expect(tmpHarvest.Params).to.deep.equal({ p_c1_Method_w0_0: 'a', p_c1_Method_w0_1: 'b', p_c2_Amount_w1: 5 });
						Expect(tmpHarvest.ParamTypes).to.deep.equal({});
						Expect(() => { _Dialects.harvest(tmpQuery, 'p q', 'SQLite'); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { _Dialects.harvest(libFoxHound.new(_Fable).setScope('Sale'), 'p', 'SQLite'); }).to.throw().with.property('Code', 'FACET_INTERNAL');
					});

				test('harvest: MSSQL expands array binds into typed scalars and types filter binds by their column',
					() =>
					{
						let tmpQuery = libFoxHound.new(_Fable).setScope('Sale');
						tmpQuery.query.schema = [ { Column: 'IDSale', Type: 'AutoIdentity' }, { Column: 'Method', Type: 'String' }, { Column: 'Rating', Type: 'Integer' }, { Column: 'Deleted', Type: 'Deleted' } ];
						tmpQuery.addFilter('Method', [ 'a', 'b' ], 'IN', 'AND', 'c1_Method');
						tmpQuery.addFilter('Rating', 4, '>=', 'AND', 'c2_Rating');
						tmpQuery.addFilter('Deleted', 0, '=', 'AND', 'FacetSoftDelete');
						tmpQuery.setDialect('MSSQL').buildReadQuery();
						let tmpHarvest = _Dialects.harvest(tmpQuery, 'p', 'MSSQL');
						Expect(tmpHarvest.SQL).to.equal('SELECT [Sale].* FROM [Sale] WHERE [Method] IN ( @p_c1_Method_w0_0, @p_c1_Method_w0_1 ) AND [Rating] >= @p_c2_Rating_w1 AND [Deleted] = @p_FacetSoftDelete_w2');
						Expect(tmpHarvest.Params).to.deep.equal({ p_c1_Method_w0_0: 'a', p_c1_Method_w0_1: 'b', p_c2_Rating_w1: 4, p_FacetSoftDelete_w2: 0 });
						Expect(tmpHarvest.ParamTypes).to.deep.equal({ p_c1_Method_w0_0: 'VarChar', p_c1_Method_w0_1: 'VarChar', p_c2_Rating_w1: 'Int', p_FacetSoftDelete_w2: 'TinyInt' });
						let tmpOuter = libFoxHound.new(_Fable).setScope('Sale');
						_Dialects.mergeParameterTypes(tmpOuter, tmpHarvest.ParamTypes);
						Expect(tmpOuter.query.parameterTypes).to.deep.equal(tmpHarvest.ParamTypes);
					});

				test('profiles, quoting and provider mapping',
					() =>
					{
						Expect(_Dialects.quote('SQLite', 'Rating')).to.equal('"Rating"');
						Expect(_Dialects.quote('MySQL', 'Rating')).to.equal('`Rating`');
						Expect(_Dialects.quote('MSSQL', 'Rating')).to.equal('[Rating]');
						Expect(_Dialects.qualify('PostgreSQL', 'p', 'Rating')).to.equal('"p"."Rating"');
						Expect(() => { _Dialects.quote('SQLite', 'Rating"; DROP TABLE x; --'); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(_Dialects.forDAL({ providerName: 'PostgreSQL' }).Sigil).to.equal(':');
						Expect(_Dialects.forDAL({ providerName: 'MSSQL' }).Sigil).to.equal('@');
						Expect(_Dialects.forDAL({ providerName: 'MongoDB' })).to.equal(null);
						Expect(_Dialects.forName('Oracle')).to.equal(null);
					});
			}
		);

		suite
		(
			'SQLite expression parity with the canonical contract math (executed on node:sqlite)',
			() =>
			{
				let _DB = null;

				suiteSetup(() => { _DB = new DatabaseSync(':memory:'); });
				suiteTeardown(() => { _DB.close(); });

				test('dateCanonical / dateKey equal Facet-Contract-Buckets for every accepted and refused shape',
					() =>
					{
						let tmpValues = (
							[
								'2026-03-04', '2026-03-04 10:11', '2026-03-04 10:11:12', '2026-03-04T10:11:12', '2026-03-04t10:11:12',
								'2026-03-04 10:11:12.5', '2026-03-04 10:11:12.123456', '2026-03-04 10:11:12Z', '2026-03-04 10:11:12z',
								'2026-03-04 10:11Z', '2026-03-04 10:11:12+00:00', '2026-03-04 10:11:12-00:00', '2026-03-04 10:11:12+05:00',
								'2026-03-04 10:11:12-05:00', '2026-03-04 10:11:12+00:30', '2026-03-04Z', '2026-03-04 10', '2026-03-04 24:00:00',
								'2026-03-04 23:60:00', '2026-03-04 23:59:60', '2026-02-29', '2024-02-29', '2026-13-01', '2026-00-10',
								'2026-03-00', '2026-03-04 ', ' 2026-03-04', '2026-03-04 10:11:12 ', '2026-03-04x', '2026', '0000-01-01',
								'9999-12-31 23:59:59', '2026-03-04 10:11:12.', '2026-03-04 10:11.5', '', '20260304', '2026-3-4',
								'2026-03-04 1:02:03', '2026-03-04  10:11', '2026-03-04 10:11:12 Z', '2026-03-04\t10:11', '2026-03-04 10:11:12+0000',
								'2025-12-29 00:00:00', '2026-01-01 00:00:00', '2027-01-03 23:59:59', 12345, 2026.5, null
							]);
						let tmpCanonicalSQL = `SELECT ${libShellSQLite.Expressions.dateCanonical(':v')} AS "C"`;
						tmpValues.forEach(
							(pValue) =>
							{
								let tmpSQL = _DB.prepare(tmpCanonicalSQL).get({ v: pValue }).C;
								Expect(tmpSQL, `canonical ${JSON.stringify(pValue)}`).to.equal(libFacetBuckets.canonicalDateTime(pValue));
								[ 'day', 'week', 'month', 'quarter', 'year' ].forEach(
									(pInterval) =>
									{
										if ((pValue === '0000-01-01') && (pInterval === 'week'))
										{
											// The ISO week of 0000-01-01 starts in year -1, which neither side formats canonically.
											return;
										}
										let tmpKey = _DB.prepare(`SELECT ${libShellSQLite.Expressions.dateKey(':v', pInterval)} AS "K"`).get({ v: pValue }).K;
										Expect(tmpKey, `${pInterval} key ${JSON.stringify(pValue)}`).to.equal(libFacetBuckets.dateKey(pValue, pInterval));
									});
							});
					});

				test('numericIndex (integer units) equals Facet-Contract-Buckets.numericIndex, including 8.4 / 0.2 edges and negatives',
					() =>
					{
						let tmpCases = (
							[
								{ Lo: 0.2, Hi: 8.4, Buckets: 7, Scale: 1, Values: [ 0.2, 0.4, 1.4, 1.6, 8.2, 8.4, 3.0, 2.8 ] },
								{ Lo: 15.58, Hi: 4875.5, Buckets: 10, Scale: 2, Values: [ 15.58, 499.99, 500, 500.01, 4875.5, 1000.25, 2.5 ] },
								{ Lo: -150, Hi: 2024, Buckets: 20, Scale: 0, Values: [ -150, -1, 0, 1, 99, 100, 2024, 1999 ] },
								{ Lo: 3, Hi: 3, Buckets: 5, Scale: 0, Values: [ 3 ] },
								{ Lo: 0.005, Hi: 0.995, Buckets: 4, Scale: 3, Values: [ 0.005, 0.25, 0.5, 0.995, 0.749 ] }
							]);
						let tmpSQL = `SELECT ${libShellSQLite.Expressions.numericIndex(libShellSQLite.Expressions.numericValue(':v'))} AS "I"`;
						tmpCases.forEach(
							(pCase) =>
							{
								let tmpGeometry = libFacetBuckets.numericGeometry(pCase.Lo, pCase.Hi, pCase.Buckets, pCase.Scale, 500);
								pCase.Values.forEach(
									(pValue) =>
									{
										let tmpIndex = _DB.prepare(tmpSQL).get({ v: pValue, fFactor: tmpGeometry.Factor, fLoUnits: tmpGeometry.LoUnits, fWidthUnits: tmpGeometry.WidthUnits, fLastIndex: tmpGeometry.N - 1 }).I;
										Expect(tmpIndex, `${pValue} in ${JSON.stringify(tmpGeometry.Edges)}`).to.equal(libFacetBuckets.numericIndex(pValue, tmpGeometry));
									});
								// Sum of units is exact (Stats SumUnits)
								let tmpUnits = _DB.prepare(`SELECT CAST(ROUND(:v * :fFactor) AS INTEGER) AS "U"`);
								pCase.Values.forEach(
									(pValue) =>
									{
										Expect(tmpUnits.get({ v: pValue, fFactor: tmpGeometry.Factor }).U).to.equal(libFacetBuckets.units(pValue, pCase.Scale));
									});
							});
						// '' and text in a numeric column are not values (Missing), exactly like the Reference fold.
						Expect(_DB.prepare(`SELECT ${libShellSQLite.Expressions.numericValue(':v')} AS "V"`).get({ v: '' }).V).to.equal(null);
						Expect(_DB.prepare(`SELECT ${libShellSQLite.Expressions.numericValue(':v')} AS "V"`).get({ v: 2.5 }).V).to.equal(2.5);
					});

				test('edgesIndex and rangeIndex follow the contract (first match, half-open, open last bucket)',
					() =>
					{
						let tmpGeometry = libFacetBuckets.edgesGeometry([ 0, 25, 100, 1000 ], true, 2);
						let tmpEdgesSQL = `SELECT ${libShellSQLite.Expressions.edgesIndex(':v', [ 'fE0', 'fE1', 'fE2', 'fE3' ], true)} AS "I"`;
						[ -1, 0, 24.99, 25, 99.99, 100, 999.99, 1000, 5000 ].forEach(
							(pValue) =>
							{
								let tmpIndex = _DB.prepare(tmpEdgesSQL).get({ v: pValue, fE0: 0, fE1: 25, fE2: 100, fE3: 1000 }).I;
								Expect(tmpIndex, String(pValue)).to.equal(libFacetBuckets.numericIndex(pValue, tmpGeometry));
							});
						let tmpRangeSQL = `SELECT ${libShellSQLite.Expressions.rangeIndex(':v', [ { From: null, To: 'fR0To' }, { From: 'fR1From', To: 'fR1To' }, { From: 'fR2From', To: null } ])} AS "I"`;
						let tmpBinds = { fR0To: 3, fR1From: 2, fR1To: 5, fR2From: 4 };
						[ [ null, -1 ], [ 1, 0 ], [ 2.5, 0 ], [ 3, 1 ], [ 4.5, 1 ], [ 5, 2 ], [ 99, 2 ] ].forEach(
							(pCase) =>
							{
								Expect(_DB.prepare(tmpRangeSQL).get(Object.assign({ v: pCase[0] }, tmpBinds)).I, String(pCase[0])).to.equal(pCase[1]);
							});
					});
			}
		);

		suite
		(
			'O9 goldens: SQL text and parameter maps per fold per dialect',
			() =>
			{
				let _Goldens = { Relations: {}, Statements: {} };
				let _Expected = null;

				suiteSetup(() =>
				{
					if (!UPDATE_GOLDENS)
					{
						_Expected = JSON.parse(libFS.readFileSync(GOLDEN_FILE, 'utf8'));
					}
				});

				suiteTeardown(() =>
				{
					if (UPDATE_GOLDENS)
					{
						libFS.mkdirSync(libPath.dirname(GOLDEN_FILE), { recursive: true });
						libFS.writeFileSync(GOLDEN_FILE, `${JSON.stringify(sortedCopy(_Goldens), null, '\t')}\n`);
					}
				});

				DIALECTS.forEach(
					(pDialect) =>
					{
						test(`${pDialect}: a behavior-scoped relation and every fold compile to the golden SQL and binds`,
							(fDone) =>
							{
								let tmpFable = newFable();
								let tmpOptions = libOptions.resolve({});
								registerLiveServices(tmpFable, tmpOptions);
								let tmpHost = newGoldenHost(tmpFable, pDialect);
								let tmpContext = newGoldenContext(tmpHost, pDialect, tmpOptions);
								let tmpEngine = tmpFable.RetoldFacetingEngineLive;
								let tmpAggNames = Object.keys(GOLDEN_AGGS);
								let tmpColumns = [];
								tmpAggNames.forEach((pName) => { tmpColumns = tmpColumns.concat(tmpEngine.aggColumns(GOLDEN_AGGS[pName])); });
								let tmpRel = tmpEngine.pivotRel(tmpContext, ENTITY, { Conjuncts: GOLDEN_CONJUNCTS, IncludesDeleted: false }, tmpColumns);
								tmpFable.RetoldFacetingScopedRelationBuilder.buildRelation(tmpContext, tmpRel,
									(pError, pRelation) =>
									{
										setImmediate(() =>
										{
											Expect(pError).to.equal(null);
											// The relation: fenced client predicates, explicit soft-delete, tenancy at depth 0, renamed binds.
											Expect(pRelation.SQL).to.not.match(/;\s*$/);
											Expect(pRelation.Capture.Appended).to.have.length(1);
											Expect(pRelation.Capture.Appended[0]).to.include({ Column: 'IDTenant', Operator: '=', Connector: 'AND', Depth: 0 });
											Expect(pRelation.Capture.Guard.Satisfied).to.equal(true);
											Object.keys(pRelation.Params).forEach((pName) => { Expect(pName).to.match(/^p_/); });
											_Goldens.Relations[pDialect] = { SQL: pRelation.SQL, Params: pRelation.Params, ParamTypes: pRelation.ParamTypes };
											_Goldens.Statements[pDialect] = {};
											let tmpSigil = (pDialect === 'MSSQL') ? '@' : ':';
											tmpAggNames.forEach(
												(pName) =>
												{
													let tmpAgg = Object.assign({ Pivot: ENTITY, VariantId: 'v0', CountMode: 'Rows' }, GOLDEN_AGGS[pName]);
													let tmpCompiled = tmpEngine.compileAgg(tmpContext, tmpAgg, [ pRelation ], pDialect, { Geometry: GOLDEN_AGGS[pName].Geometry || null });
													Expect(tmpCompiled.Dialect).to.equal(pDialect);
													let tmpExpectedStatements = (tmpAgg.Kind === 'NumericHistogram') ? 2 : 1;
													Expect(tmpCompiled.Statements, pName).to.have.length(tmpExpectedStatements);
													tmpCompiled.Statements.forEach(
														(pStatement) =>
														{
															// Every referenced bind exists; no JS array is ever bound by a shell.
															referencedBinds(pStatement.SQL, tmpSigil).forEach(
																(pBind) =>
																{
																	Expect(pStatement.Params, `${pDialect} ${pName} bind ${pBind}`).to.have.property(pBind);
																});
															Object.keys(pStatement.Params).filter((pBind) => { return pBind.charAt(0) === 'f'; }).forEach(
																(pBind) =>
																{
																	Expect(Array.isArray(pStatement.Params[pBind]), pBind).to.equal(false);
																});
															if (pDialect === 'MSSQL')
															{
																// MSSQL binds only declared, scalar inputs.
																Object.keys(pStatement.Params).forEach(
																	(pBind) =>
																	{
																		Expect(pStatement.ParamTypes, `MSSQL ${pName} type of ${pBind}`).to.have.property(pBind);
																		Expect(Array.isArray(pStatement.Params[pBind]), pBind).to.equal(false);
																	});
															}
															Expect(pStatement.SQL).to.not.include('<%');
														});
													_Goldens.Statements[pDialect][pName] = tmpCompiled.Statements;
												});
											if (!UPDATE_GOLDENS)
											{
												Expect(sortedCopy(_Goldens.Relations[pDialect]), `${pDialect} relation golden`).to.deep.equal(_Expected.Relations[pDialect]);
												tmpAggNames.forEach(
													(pName) =>
													{
														Expect(sortedCopy(_Goldens.Statements[pDialect][pName]), `${pDialect} ${pName} golden`).to.deep.equal(_Expected.Statements[pDialect][pName]);
													});
											}
											return fDone();
										});
									});
							});
					});

				test('the SQLite goldens execute on node:sqlite against the seeded schema (tenant 1, live rows, the golden filter)',
					() =>
					{
						let tmpStatements = UPDATE_GOLDENS ? _Goldens.Statements.SQLite : _Expected.Statements.SQLite;
						Expect(tmpStatements).to.be.an('object');
						let tmpDB = new DatabaseSync(':memory:');
						try
						{
							let tmpModel = libBookstoreSeed.model('Bookstore-Tenant');
							libBookstoreSeed.createTables(tmpDB, tmpModel);
							let tmpInsert = tmpDB.prepare('INSERT INTO BookStoreSale (Deleted, SaleDate, TotalAmount, PaymentMethod, IDBookStore, IDTenant) VALUES (?, ?, ?, ?, ?, ?)');
							let tmpRows = (
								[
									[ 0, '2023-03-04 10:00:00', 12.5, 'Credit', 1, 1 ],
									[ 0, '2023-07-01 09:00:00', 300, 'Cash', 2, 1 ],
									[ 0, null, 40, 'Credit', 1, 1 ],
									[ 1, '2023-03-05 10:00:00', 50, 'Credit', 1, 1 ],         // soft-deleted
									[ 0, '2023-03-06 10:00:00', 60, 'Credit', 1, 2 ],         // tenant 2
									[ 0, '2025-01-01 10:00:00', 70, 'Credit', 1, 1 ],         // fails c3
									[ 0, '2023-04-01 10:00:00', 5, 'Credit', 1, 1 ],          // fails c2
									[ 0, '2023-04-02 10:00:00', 80, 'Debit', 1, 1 ]           // fails c1
								]);
							tmpRows.forEach((pRow) => { tmpInsert.run(...pRow); });
							let tmpRun = (pStatement) =>
							{
								let tmpBinds = {};
								Object.keys(pStatement.Params).forEach(
									(pName) =>
									{
										if (pStatement.SQL.indexOf(`:${pName}`) >= 0)
										{
											tmpBinds[pName] = pStatement.Params[pName];
										}
									});
								return tmpDB.prepare(pStatement.SQL).all(tmpBinds).map((pRow) => { return Object.assign({}, pRow); });
							};
							// Three rows survive: tenant 1, live, Credit|Cash, >= 10, SaleDate NULL or < 2024.
							Expect(tmpRun(tmpStatements.Count[0])).to.deep.equal([ { Total: 3 } ]);
							let tmpTerms = tmpRun(tmpStatements.Terms[0]);
							Expect(tmpTerms.map((pRow) => { return [ pRow.Key, pRow.Count, pRow.FacetTotal, pRow.FacetMissing, pRow.FacetDistinct ]; }).sort())
								.to.deep.equal([ [ 'Cash', 1, 3, 0, 2 ], [ 'Credit', 2, 3, 0, 2 ] ]);
							let tmpMonths = tmpRun(tmpStatements.DateHistogramMonth[0]).sort((pA, pB) => { return (pA.Key === null) ? -1 : ((pB.Key === null) ? 1 : libFacetBuckets.compareKeys(pA.Key, pB.Key)); });
							Expect(tmpMonths).to.deep.equal(
								[
									{ Key: null, Count: 1, Lo: null, Hi: null },
									{ Key: '2023-03-01 00:00:00', Count: 1, Lo: '2023-03-04 10:00:00', Hi: '2023-03-04 10:00:00' },
									{ Key: '2023-07-01 00:00:00', Count: 1, Lo: '2023-07-01 09:00:00', Hi: '2023-07-01 09:00:00' }
								]);
							Expect(tmpRun(tmpStatements.StatsDecimal[0])).to.deep.equal([ { Rows: 3, NonNull: 3, Min: 12.5, Max: 300, SumUnits: 35250 } ]);
							Expect(tmpRun(tmpStatements.MissingDate[0])).to.deep.equal([ { Rows: 3, NonNull: 2 } ]);
							// Edges [0, 25, 100, 1000) + [1000, ∞): 12.5 → 0, 40 → 1, 300 → 2.
							Expect(tmpRun(tmpStatements.NumericHistogramEdges[1]).sort((pA, pB) => { return pA.Key - pB.Key; })).to.deep.equal([ { Key: 0, Count: 1 }, { Key: 1, Count: 1 }, { Key: 2, Count: 1 } ]);
							Expect(tmpRun(tmpStatements.Ranges[0]).sort((pA, pB) => { return pA.Key - pB.Key; })).to.deep.equal([ { Key: 0, Count: 1 }, { Key: 1, Count: 1 }, { Key: 2, Count: 1 } ]);
							Expect(tmpRun(tmpStatements.PivotColumnDate[0]).length).to.equal(3);
							Object.keys(tmpStatements).forEach(
								(pName) =>
								{
									tmpStatements[pName].forEach((pStatement) => { Expect(() => { tmpRun(pStatement); }, pName).to.not.throw(); });
								});
						}
						finally
						{
							tmpDB.close();
						}
					});
			}
		);
	}
);
