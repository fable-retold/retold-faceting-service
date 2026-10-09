/**
 * Facet-Reference tests: the deterministic Bookstore fixtures, the Reference engine's
 * pure folds on hand-checkable mini fixtures, the Reference engine over the real list waterfall
 * (cross-checked against raw SQL on the seeded database, never against the drifting harness
 * DB), two-tenant isolation through the list behaviors, and the O2 selection round-trip helper.
 *
 * Port 19106 (internal-contracts §14.4); the Bookstore and Bookstore-Tenant harnesses run one
 * after the other on it.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const { DatabaseSync } = require('node:sqlite');

const libFable = require('fable');

const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libRetoldFacetingEngineReference = require('../source/engine/Retold-Faceting-EngineReference.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');

const PORT = 19106;

const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * A fresh engine on a fresh fable (pure fold tests).
 *
 * @return {RetoldFacetingEngineReference}
 */
const newEngine = () =>
{
	let tmpFable = new libFable({ Product: 'RetoldFacetingReferenceTest', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
	return new libRetoldFacetingEngineReference(tmpFable);
};

/**
 * Rows of one column as records.
 *
 * @param {string} pField
 * @param {Array<any>} pValues
 * @return {Array<Record<string, any>>}
 */
const records = (pField, pValues) =>
{
	return pValues.map((pValue, pIndex) => { let tmpRecord = { ID: pIndex + 1 }; tmpRecord[pField] = pValue; return tmpRecord; });
};

/**
 * Groups as a { key: count } map (keys stringified).
 *
 * @param {Array<{ Key: any, Count: number }>} pGroups
 * @return {Record<string, number>}
 */
const groupMap = (pGroups) =>
{
	let tmpMap = {};
	for (let i = 0; i < pGroups.length; i++)
	{
		tmpMap[String(pGroups[i].Key)] = pGroups[i].Count;
	}
	return tmpMap;
};

/**
 * SQL rows → plain objects (node:sqlite returns null-prototype rows).
 *
 * @param {any} pDB
 * @param {string} pSQL
 * @param {Array<any>} [pBinds]
 * @return {Array<Record<string, any>>}
 */
const sqlAll = (pDB, pSQL, pBinds) =>
{
	return pDB.prepare(pSQL).all(...(pBinds || [])).map((pRow) => { return Object.assign({}, pRow); });
};

const conjunct = libBuilders.conjunct;

const variant = libBuilders.variant;

/**
 * A request context (internal-contracts §2.2) for driving the engine directly.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pVariants
 * @param {{ Tenant?: number, User?: number }} [pSession]
 * @return {Record<string, any>}
 */
const newContext = (pHarness, pEntity, pVariants, pSession) =>
{
	return (
		{
			RequestID: 'rfq-reference-test',
			Entity: pEntity,
			Request: libHarness.syntheticRequest(pEntity, pSession || {}),
			Host: pHarness.fable.RetoldFacetingHostDataService,
			Options: pHarness.faceting.options,
			Principal: null,
			NormalizedRequest: null,
			FilterAST: null,
			Variants: pVariants,
			Dialect: 'SQLite',
			Now: '2026-10-08T15:02:11.120Z',
			Deadline: Date.now() + 30000,
			ForceEngine: 'Reference',
			Memo: { Relations: {}, Captures: {}, VariantRows: {} },
			Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
			Warnings: []
		});
};

/**
 * Run the engine and leave its stack before asserting.
 */
const execute = (pHarness, pContext, pAggs, fCallback) =>
{
	pHarness.fable.RetoldFacetingEngineReference.execute(pContext, pAggs,
		(pError, pExecution) =>
		{
			setImmediate(() => { fCallback(pError, pExecution); });
		});
};

suite
(
	'Facet-Reference',
	() =>
	{
		// ---------------------------------------------------------------- fixtures
		suite
		(
			'Bookstore-Seed',
			() =>
			{
				test('prng is deterministic, in [0, 1), and seed-sensitive',
					() =>
					{
						let fA = libBookstoreSeed.prng(20261008);
						let fB = libBookstoreSeed.prng(20261008);
						let fC = libBookstoreSeed.prng(20261009);
						let tmpA = [];
						let tmpB = [];
						let tmpC = [];
						for (let i = 0; i < 1000; i++)
						{
							tmpA.push(fA());
							tmpB.push(fB());
							tmpC.push(fC());
						}
						Expect(tmpA).to.deep.equal(tmpB);
						Expect(tmpA).to.not.deep.equal(tmpC);
						Expect(tmpA.every((pValue) => { return (pValue >= 0) && (pValue < 1); })).to.equal(true);
					});

				test('same seed → same counts and the same content fingerprint; another seed differs',
					() =>
					{
						let tmpDB1 = new DatabaseSync(':memory:');
						let tmpDB2 = new DatabaseSync(':memory:');
						let tmpDB3 = new DatabaseSync(':memory:');
						let tmpSeed1 = libBookstoreSeed.build(tmpDB1, { Fixture: 'Bookstore', Seed: 20261008 });
						let tmpSeed2 = libBookstoreSeed.build(tmpDB2, { Fixture: 'Bookstore', Seed: 20261008 });
						let tmpSeed3 = libBookstoreSeed.build(tmpDB3, { Fixture: 'Bookstore', Seed: 7 });
						Expect(tmpSeed1.Counts).to.deep.equal(tmpSeed2.Counts);
						Expect(tmpSeed1.LiveCounts).to.deep.equal(tmpSeed2.LiveCounts);
						Expect(libBookstoreSeed.fingerprint(tmpDB1, tmpSeed1.Model)).to.equal(libBookstoreSeed.fingerprint(tmpDB2, tmpSeed2.Model));
						Expect(libBookstoreSeed.fingerprint(tmpDB1, tmpSeed1.Model)).to.not.equal(libBookstoreSeed.fingerprint(tmpDB3, tmpSeed3.Model));
						// Fixed-size tables keep their size across seeds; content moves.
						Expect(tmpSeed3.Counts.Book).to.equal(tmpSeed1.Counts.Book);
						Expect(tmpSeed3.Counts.Review).to.equal(tmpSeed1.Counts.Review);
						tmpDB1.close();
						tmpDB2.close();
						tmpDB3.close();
					});

				test('the Bookstore data carries every trap the fixtures need (08 §5)',
					() =>
					{
						let tmpDB = new DatabaseSync(':memory:');
						let tmpSeed = libBookstoreSeed.build(tmpDB, { Fixture: 'Bookstore' });
						let fOne = (pSQL) => { return sqlAll(tmpDB, pSQL)[0]; };

						Expect(tmpSeed.Fixture).to.equal('Bookstore');
						Expect(tmpSeed.Tenants).to.deep.equal([]);
						Expect(tmpSeed.Counts.Book).to.equal(1500);
						Expect(tmpSeed.Counts.Author).to.equal(400);
						Expect(tmpSeed.Counts.Review).to.equal(6000);
						Expect(tmpSeed.Counts.BookStoreCatalogJoin).to.be.greaterThan(0);
						Expect(tmpSeed.Counts.BookAuthorJoin).to.be.greaterThan(tmpSeed.Counts.Book);

						// Soft-deleted rows in every table that has Deleted (~3 %, at least one)
						Object.keys(tmpSeed.Model.Tables).forEach(
							(pTable) =>
							{
								let tmpHasDeleted = tmpSeed.Model.Tables[pTable].Columns.some((pColumn) => { return pColumn.Column === 'Deleted'; });
								if (tmpHasDeleted)
								{
									Expect(tmpSeed.LiveCounts[pTable], pTable).to.be.lessThan(tmpSeed.Counts[pTable]);
									Expect(tmpSeed.Counts[pTable] - tmpSeed.LiveCounts[pTable], pTable).to.be.at.most(Math.max(3, tmpSeed.Counts[pTable] * 0.08));
								}
								else
								{
									Expect(tmpSeed.LiveCounts[pTable], pTable).to.equal(tmpSeed.Counts[pTable]);
								}
							});

						// SaleDate: 2020-12-31 … 2024-12-30, a single-day first month, NULLs, 49 months
						let tmpSale = fOne('SELECT min(SaleDate) AS Lo, max(SaleDate) AS Hi, count(*) - count(SaleDate) AS Nulls FROM BookStoreSale');
						Expect(tmpSale.Lo).to.equal('2020-12-31 09:33:32');
						Expect(tmpSale.Hi).to.equal('2024-12-30 21:55:33');
						Expect(tmpSale.Nulls).to.be.greaterThan(0);
						Expect(fOne("SELECT count(*) AS N FROM BookStoreSale WHERE SaleDate LIKE '2020-12-%'").N).to.equal(1);
						Expect(fOne("SELECT count(DISTINCT substr(SaleDate, 1, 7)) AS N FROM BookStoreSale WHERE Deleted = 0 AND SaleDate IS NOT NULL").N).to.equal(49);
						// Every SaleDate is canonical text except the boundary traps (date-only, HH:mm, 'T' form).
						let tmpOddDates = sqlAll(tmpDB, 'SELECT SaleDate FROM BookStoreSale WHERE SaleDate IS NOT NULL').filter((pRow) => { return !DATETIME_PATTERN.test(pRow.SaleDate); }).map((pRow) => { return pRow.SaleDate; });
						Expect(tmpOddDates.sort()).to.deep.equal(tmpSeed.Traps.BoundarySaleDates.slice().sort());
						Expect(fOne(`SELECT count(*) AS N FROM BookStoreSale WHERE Deleted = 0 AND SaleDate IN ('${tmpSeed.Traps.BoundarySaleDates.join("', '")}')`).N).to.equal(3);

						// TotalAmount: two-decimal values, an outlier, NULLs
						let tmpAmount = fOne('SELECT max(TotalAmount) AS Hi, count(*) - count(TotalAmount) AS Nulls FROM BookStoreSale');
						Expect(tmpAmount.Hi).to.equal(tmpSeed.Traps.TotalAmountOutlier);
						Expect(tmpAmount.Nulls).to.be.greaterThan(0);
						// Two-decimal values, except one sub-Scale trap just below the Nice edge 500.00
						let tmpSubScale = sqlAll(tmpDB, 'SELECT TotalAmount FROM BookStoreSale WHERE TotalAmount IS NOT NULL').filter(
							(pRow) => { return Math.abs((pRow.TotalAmount * 100) - Math.round(pRow.TotalAmount * 100)) >= 1e-6; });
						Expect(tmpSubScale.map((pRow) => { return pRow.TotalAmount; })).to.deep.equal([ tmpSeed.Traps.SubScaleAmount ]);
						// '~' genres (UnsafeKey) and '' / ' ' text in an integer column
						Expect(fOne(`SELECT count(*) AS N FROM Book WHERE Deleted = 0 AND Genre = '${tmpSeed.Traps.UnsafeGenre}'`).N).to.equal(3);
						Expect(sqlAll(tmpDB, "SELECT BookCount AS V, typeof(BookCount) AS T FROM BookStoreInventory WHERE typeof(BookCount) = 'text' ORDER BY IDBookStoreInventory")).to.deep.equal([ { V: '', T: 'text' }, { V: ' ', T: 'text' } ]);

						// Skewed categories, '' vs NULL
						let tmpPayments = groupMap(sqlAll(tmpDB, 'SELECT PaymentMethod AS Key, count(*) AS Count FROM BookStoreSale GROUP BY 1'));
						Expect(tmpPayments.Credit).to.be.greaterThan(tmpPayments.Debit);
						Expect(tmpPayments.Debit).to.be.greaterThan(tmpPayments.Cash);
						Expect(tmpPayments['']).to.be.greaterThan(0);
						Expect(tmpPayments.null).to.be.greaterThan(0);
						let tmpLanguages = groupMap(sqlAll(tmpDB, 'SELECT Language AS Key, count(*) AS Count FROM Book GROUP BY 1'));
						Expect(tmpLanguages['']).to.be.greaterThan(0);
						Expect(tmpLanguages.null).to.be.greaterThan(0);
						Expect(tmpLanguages.eng).to.be.greaterThan(tmpLanguages['en-US']);
						let tmpRatings = groupMap(sqlAll(tmpDB, 'SELECT Rating AS Key, count(*) AS Count FROM Review GROUP BY 1'));
						Expect(tmpRatings['4']).to.be.greaterThan(tmpRatings['3']);
						Expect(tmpRatings['3']).to.be.greaterThan(tmpRatings['1']);
						Expect(tmpRatings.null).to.be.greaterThan(0);

						// PublicationYear: negative outlier and NULLs; '' dates in BookPrice.EndDate
						let tmpYears = fOne('SELECT min(PublicationYear) AS Lo, max(PublicationYear) AS Hi, count(*) - count(PublicationYear) AS Nulls FROM Book');
						Expect(tmpYears.Lo).to.equal(-1750);
						Expect(tmpYears.Hi).to.equal(2017);
						Expect(tmpYears.Nulls).to.be.greaterThan(0);
						Expect(fOne("SELECT count(*) AS N FROM BookPrice WHERE EndDate = ''").N).to.be.greaterThan(0);
						Expect(fOne('SELECT count(*) AS N FROM BookPrice WHERE EndDate IS NULL').N).to.be.greaterThan(0);

						// Sales at soft-deleted stores and at missing stores
						Expect(fOne('SELECT count(*) AS N FROM BookStoreSale s WHERE NOT EXISTS (SELECT 1 FROM BookStore b WHERE b.IDBookStore = s.IDBookStore)').N).to.be.greaterThan(0);
						Expect(fOne('SELECT count(*) AS N FROM BookStoreSale s JOIN BookStore b ON b.IDBookStore = s.IDBookStore WHERE b.Deleted = 1').N).to.be.greaterThan(0);
						tmpDB.close();
					});

				test('Bookstore-Tenant: IDTenant everywhere, tenant 2 is a ~5 % clone with distinct IDs and cross-tenant references',
					() =>
					{
						let tmpDB = new DatabaseSync(':memory:');
						let tmpSeed = libBookstoreSeed.build(tmpDB, { Fixture: 'Bookstore-Tenant' });
						Expect(tmpSeed.Tenants).to.deep.equal([ 1, 2 ]);
						Object.keys(tmpSeed.Model.Tables).forEach(
							(pTable) =>
							{
								let tmpTable = tmpSeed.Model.Tables[pTable];
								Expect(tmpTable.Columns.some((pColumn) => { return pColumn.Column === 'IDTenant'; }), pTable).to.equal(true);
								Expect(tmpTable.MeadowSchema.Schema.some((pColumn) => { return pColumn.Column === 'IDTenant'; }), pTable).to.equal(true);
								Expect(tmpTable.MeadowSchema.DefaultObject.IDTenant, pTable).to.equal(0);
								let tmpPK = libBookstoreSeed.primaryKeyOf(tmpSeed.Model, pTable);
								let tmpRange = sqlAll(tmpDB, `SELECT IDTenant AS T, min("${tmpPK}") AS Lo, max("${tmpPK}") AS Hi, count(*) AS N FROM "${pTable}" GROUP BY 1 ORDER BY 1`);
								Expect(tmpRange.map((pRow) => { return pRow.T; }), pTable).to.deep.equal([ 1, 2 ]);
								// Distinct IDs: every tenant-2 ID is above every tenant-1 ID
								Expect(tmpRange[1].Lo, pTable).to.be.greaterThan(tmpRange[0].Hi);
								Expect(tmpSeed.TenantCounts[1][pTable] + tmpSeed.TenantCounts[2][pTable], pTable).to.equal(tmpSeed.Counts[pTable]);
								if (tmpSeed.TenantCounts[1][pTable] >= 400)
								{
									let tmpShare = tmpSeed.TenantCounts[2][pTable] / tmpSeed.TenantCounts[1][pTable];
									Expect(tmpShare, pTable).to.be.within(0.02, 0.12);
								}
							});
						// Tenant 1 is exactly the base fixture
						let tmpBaseDB = new DatabaseSync(':memory:');
						let tmpBase = libBookstoreSeed.build(tmpBaseDB, { Fixture: 'Bookstore' });
						Expect(tmpSeed.TenantCounts[1]).to.deep.equal(tmpBase.Counts);
						// Cross-tenant references both ways
						Expect(sqlAll(tmpDB, 'SELECT count(*) AS N FROM Review r JOIN Book b ON b.IDBook = r.IDBook WHERE r.IDTenant = 2 AND b.IDTenant = 1')[0].N).to.be.greaterThan(0);
						Expect(sqlAll(tmpDB, 'SELECT count(*) AS N FROM Review r JOIN Book b ON b.IDBook = r.IDBook WHERE r.IDTenant = 1 AND b.IDTenant = 2')[0].N).to.be.greaterThan(0);
						Expect(sqlAll(tmpDB, 'SELECT count(*) AS N FROM Review r JOIN Book b ON b.IDBook = r.IDBook WHERE r.IDTenant = 2 AND b.IDTenant = 2')[0].N).to.be.greaterThan(0);
						tmpDB.close();
						tmpBaseDB.close();
					});

				test('Medium scale multiplies the base sizes; unknown fixtures and scales throw',
					() =>
					{
						let tmpDB = new DatabaseSync(':memory:');
						let tmpSeed = libBookstoreSeed.build(tmpDB, { Fixture: 'Bookstore', Scale: 'Medium' });
						Expect(tmpSeed.Counts.Book).to.equal(6000);
						Expect(tmpSeed.Counts.Review).to.equal(24000);
						tmpDB.close();
						Expect(() => { libBookstoreSeed.model('Nope'); }).to.throw();
						Expect(() => { libBookstoreSeed.build(new DatabaseSync(':memory:'), { Scale: 'Huge' }); }).to.throw();
					});
			}
		);

		// ---------------------------------------------------------------- pure folds
		suite
		(
			'Reference fold (mini fixtures)',
			() =>
			{
				let _Engine = null;

				suiteSetup(() => { _Engine = newEngine(); });

				test('capable() answers only when the Reference is forced',
					() =>
					{
						Expect(_Engine.EngineName).to.equal('Reference');
						Expect(_Engine.capable({ Kind: 'Terms' }, { ForceEngine: null }).Capable).to.equal(false);
						Expect(_Engine.capable({ Kind: 'Terms' }, { ForceEngine: 'Reference' }).Capable).to.equal(true);
						Expect(_Engine.capable({ Kind: 'PathTerms' }, { ForceEngine: 'Reference' }).Capable).to.equal(false);
						Expect(_Engine.freshness({}).Exact).to.equal(true);
					});

				test('Count: Total only',
					() =>
					{
						let tmpRaw = _Engine.fold({ Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] }, records('X', [ 1, 2, null ]));
						Expect(tmpRaw).to.deep.include({ Key: '#Total', Kind: 'Count', VariantId: 'v0', Total: 3, MissingCount: 0 });
					});

				test('Terms: every non-null key in canonical order, NULL → Missing, \'\' is a key',
					() =>
					{
						let tmpAgg = { Key: 'Lang', Kind: 'Terms', VariantId: 'v1', Dimensions: [ { Kind: 'Column', Field: 'Language', DataType: 'String' } ] };
						let tmpRaw = _Engine.fold(tmpAgg, records('Language', [ 'eng', 'spa', 'eng', null, '', 'spa', 'eng', 'fre', undefined ]));
						Expect(tmpRaw.Total).to.equal(9);
						Expect(tmpRaw.MissingCount).to.equal(2);
						Expect(tmpRaw.DistinctKeys).to.equal(4);
						// Count desc, then key ascending ('' < 'fre')
						Expect(tmpRaw.Groups).to.deep.equal([ { Key: 'eng', Count: 3 }, { Key: 'spa', Count: 2 }, { Key: '', Count: 1 }, { Key: 'fre', Count: 1 } ]);
					});

				test('Terms on numeric columns: keys are numbers; 0 is a key',
					() =>
					{
						let tmpAgg = { Key: 'Rating', Kind: 'Terms', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] };
						let tmpRaw = _Engine.fold(tmpAgg, records('Rating', [ 5, 4, 4, 5, 0, null, 3 ]));
						Expect(tmpRaw.Groups).to.deep.equal([ { Key: 4, Count: 2 }, { Key: 5, Count: 2 }, { Key: 0, Count: 1 }, { Key: 3, Count: 1 } ]);
						Expect(tmpRaw.MissingCount).to.equal(1);
						let tmpBoolean = _Engine.fold({ Key: 'B', Kind: 'Terms', Dimensions: [ { Kind: 'Column', Field: 'IsActive', DataType: 'Boolean' } ] }, records('IsActive', [ 1, 0, 1, true ]));
						Expect(tmpBoolean.Groups).to.deep.equal([ { Key: 1, Count: 3 }, { Key: 0, Count: 1 } ]);
					});

				test('DateHistogram: month keys, single-day first month, NULL / \'\' / unparseable → Missing, Bounds',
					() =>
					{
						let tmpAgg = { Key: 'ByMonth', Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'month' } ] };
						let tmpRaw = _Engine.fold(tmpAgg, records('SaleDate',
							[ '2020-12-31 09:33:32', '2021-01-05 00:00:00', '2021-01-31 23:59:59', null, '', 'not a date', '2021-03-01T10:00:00Z' ]));
						Expect(tmpRaw.Total).to.equal(7);
						Expect(tmpRaw.MissingCount).to.equal(3);
						Expect(tmpRaw.Groups).to.deep.equal(
							[
								{ Key: '2020-12-01 00:00:00', Count: 1 },
								{ Key: '2021-01-01 00:00:00', Count: 2 },
								{ Key: '2021-03-01 00:00:00', Count: 1 }
							]);
						Expect(tmpRaw.Bounds).to.deep.equal({ Lo: '2020-12-31 09:33:32', Hi: '2021-03-01 10:00:00' });
						Expect(_Engine.fold(tmpAgg, records('SaleDate', [ null, '' ])).Bounds).to.equal(null);
					});

				test('DateHistogram: day, ISO week, quarter and year keys',
					() =>
					{
						let fKeys = (pInterval, pValues) =>
						{
							return _Engine.fold({ Key: 'D', Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'D', Interval: pInterval } ] }, records('D', pValues)).Groups.map((pGroup) => { return pGroup.Key; });
						};
						// 2026-10-05 is a Monday; 2026-10-08 a Thursday; 2026-10-11 a Sunday
						Expect(fKeys('week', [ '2026-10-05 00:00:00', '2026-10-08 12:00:00', '2026-10-11 23:59:59', '2026-10-12 00:00:00' ])).to.deep.equal([ '2026-10-05 00:00:00', '2026-10-12 00:00:00' ]);
						Expect(fKeys('day', [ '2026-10-08 12:00:00', '2026-10-08 23:00:00' ])).to.deep.equal([ '2026-10-08 00:00:00' ]);
						Expect(fKeys('quarter', [ '2026-08-15 01:02:03', '2026-01-01 00:00:00', '2026-03-31 23:59:59' ])).to.deep.equal([ '2026-01-01 00:00:00', '2026-07-01 00:00:00' ]);
						Expect(fKeys('year', [ '2026-08-15 01:02:03', '2025-12-31 23:59:59' ])).to.deep.equal([ '2025-01-01 00:00:00', '2026-01-01 00:00:00' ]);
					});

				test('NumericHistogram (Nice, integer): 0..100 in 10 buckets, the last bucket is closed on Hi',
					() =>
					{
						let tmpValues = [];
						for (let i = 0; i <= 100; i++)
						{
							tmpValues.push(i);
						}
						tmpValues.push(null);
						let tmpAgg = { Key: 'N', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'N', Mode: 'Nice', Buckets: 10, Edges: null, OpenEnded: false, IsInteger: true, Scale: 0 } ] };
						let tmpRaw = _Engine.fold(tmpAgg, records('N', tmpValues));
						Expect(tmpRaw.Total).to.equal(102);
						Expect(tmpRaw.MissingCount).to.equal(1);
						Expect(tmpRaw.Bounds).to.deep.equal({ Lo: 0, Hi: 100 });
						Expect(tmpRaw.Geometry).to.deep.include({ Mode: 'Nice', LoUnits: 0, WidthUnits: 10, N: 10 });
						Expect(tmpRaw.Geometry.Edges).to.deep.equal([ 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 ]);
						let tmpExpected = [];
						for (let i = 0; i < 10; i++)
						{
							tmpExpected.push({ Key: i, Count: (i === 9) ? 11 : 10 });
						}
						Expect(tmpRaw.Groups).to.deep.equal(tmpExpected);
					});

				test('NumericHistogram (Nice, Decimal scale 2): integer-unit edges, 8.4 / 0.2 lands exactly',
					() =>
					{
						// units: 20 … 1000, range 980 → width 200 units (2.00) × 5 buckets, LoUnits 0
						let tmpAgg = { Key: 'A', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'A', Mode: 'Nice', Buckets: 5, Edges: null, OpenEnded: false, IsInteger: false, Scale: 2 } ] };
						let tmpRaw = _Engine.fold(tmpAgg, records('A', [ 8.4, 8.6, 0.2, 10, 6, 5.99, null ]));
						Expect(tmpRaw.Geometry).to.deep.include({ LoUnits: 0, WidthUnits: 200, Width: 2, N: 5 });
						Expect(tmpRaw.Geometry.Edges).to.deep.equal([ 0, 2, 4, 6, 8, 10 ]);
						Expect(tmpRaw.Groups).to.deep.equal([ { Key: 0, Count: 1 }, { Key: 2, Count: 1 }, { Key: 3, Count: 1 }, { Key: 4, Count: 3 } ]);
						Expect(tmpRaw.MissingCount).to.equal(1);
						// No non-null values: no geometry buckets, no Bounds
						let tmpEmpty = _Engine.fold(tmpAgg, records('A', [ null, null ]));
						Expect(tmpEmpty.Bounds).to.equal(null);
						Expect(tmpEmpty.Geometry.N).to.equal(0);
						Expect(tmpEmpty.Groups).to.deep.equal([]);
						Expect(tmpEmpty.MissingCount).to.equal(2);
					});

				test('NumericHistogram (Edges): outside rows are in no group; OpenEnded adds [last, ∞)',
					() =>
					{
						let tmpValues = [ -5, 0, 9, 10, 49, 50, 100, null ];
						let tmpClosed = _Engine.fold({ Key: 'E', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'E', Mode: 'Edges', Edges: [ 0, 10, 50 ], OpenEnded: false, IsInteger: true, Scale: 0 } ] }, records('E', tmpValues));
						Expect(tmpClosed.Geometry.N).to.equal(2);
						Expect(tmpClosed.Groups).to.deep.equal([ { Key: 0, Count: 2 }, { Key: 1, Count: 2 } ]);
						Expect(tmpClosed.MissingCount).to.equal(1);
						Expect(tmpClosed.Bounds).to.deep.equal({ Lo: -5, Hi: 100 });
						let tmpOpen = _Engine.fold({ Key: 'E', Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'E', Mode: 'Edges', Edges: [ 0, 10, 50 ], OpenEnded: true, IsInteger: true, Scale: 0 } ] }, records('E', tmpValues));
						Expect(tmpOpen.Geometry.N).to.equal(3);
						Expect(tmpOpen.Groups).to.deep.equal([ { Key: 0, Count: 2 }, { Key: 1, Count: 2 }, { Key: 2, Count: 2 } ]);
					});

				test('Ranges: first matching range wins (From inclusive, To exclusive), NULL → Missing, no range → no group',
					() =>
					{
						let tmpRanges = [ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'mid', From: 3, To: 4, Label: 'Mid' }, { Key: 'high', From: 4, To: null, Label: 'High' } ];
						let tmpRaw = _Engine.fold({ Key: 'R', Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'Rating', Ranges: tmpRanges, IsInteger: true, Scale: 0 } ] }, records('Rating', [ 1, 2, 3, 4, 5, 5, null ]));
						Expect(tmpRaw.Groups).to.deep.equal([ { Key: 'low', Count: 2 }, { Key: 'mid', Count: 1 }, { Key: 'high', Count: 3 } ]);
						Expect(tmpRaw.MissingCount).to.equal(1);
						let tmpOverlap = [ { Key: 'a', From: 0, To: 10 }, { Key: 'b', From: 5, To: 20 } ];
						let tmpOverlapRaw = _Engine.fold({ Key: 'R', Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'V', Ranges: tmpOverlap } ] }, records('V', [ 7, 15, 25, -1 ]));
						Expect(tmpOverlapRaw.Groups).to.deep.equal([ { Key: 'a', Count: 1 }, { Key: 'b', Count: 1 } ]);
						Expect(tmpOverlapRaw.MissingCount).to.equal(0);
						Expect(tmpOverlapRaw.Total).to.equal(4);
					});

				test('Stats: exact integer-unit sums for Decimal and integer columns; canonical Min/Max for dates',
					() =>
					{
						let tmpDecimal = _Engine.fold({ Key: 'S', Kind: 'Stats', Field: 'TotalAmount', FieldInfo: { Column: 'TotalAmount', DataType: 'Decimal', IsInteger: false, Scale: 2 }, Dimensions: [] },
							records('TotalAmount', [ 8.49, 291.21, 0.3, null ]));
						Expect(tmpDecimal.Stats).to.deep.equal({ Rows: 4, NonNull: 3, Min: 0.3, Max: 291.21, SumUnits: 30000, Factor: 100 });
						Expect(tmpDecimal.MissingCount).to.equal(1);
						Expect(tmpDecimal.Total).to.equal(4);

						let tmpInteger = _Engine.fold({ Key: 'S', Kind: 'Stats', Field: 'Rating', FieldInfo: { Column: 'Rating', DataType: 'Numeric', IsInteger: true, Scale: 0 }, Dimensions: [] },
							records('Rating', [ 1, 2, 3, null, -1 ]));
						Expect(tmpInteger.Stats).to.deep.equal({ Rows: 5, NonNull: 4, Min: -1, Max: 3, SumUnits: 5, Factor: 1 });

						let tmpDate = _Engine.fold({ Key: 'S', Kind: 'Stats', Field: 'SaleDate', FieldInfo: { Column: 'SaleDate', DataType: 'DateTime', IsInteger: false, Scale: 0 }, Dimensions: [] },
							records('SaleDate', [ '2021-01-01 00:00:00', '', null, '2020-12-31 09:33:32', 'x' ]));
						Expect(tmpDate.Stats).to.deep.include({ Rows: 5, NonNull: 2, Min: '2020-12-31 09:33:32', Max: '2021-01-01 00:00:00', SumUnits: null });
						Expect(tmpDate.MissingCount).to.equal(3);

						let tmpNone = _Engine.fold({ Key: 'S', Kind: 'Stats', Field: 'TotalAmount', FieldInfo: { Column: 'TotalAmount', DataType: 'Decimal', IsInteger: false, Scale: 2 }, Dimensions: [] }, records('TotalAmount', [ null ]));
						Expect(tmpNone.Stats).to.deep.include({ Rows: 1, NonNull: 0, Min: null, Max: null, SumUnits: 0 });
					});

				test('DistinctCount (binary comparison) and Missing (dates: NULL or unparseable)',
					() =>
					{
						let tmpDistinct = _Engine.fold({ Key: 'D', Kind: 'DistinctCount', Field: 'Name', FieldInfo: { Column: 'Name', DataType: 'String' }, Dimensions: [] }, records('Name', [ 'a', 'A', 'a', null, '' ]));
						Expect(tmpDistinct.DistinctCount).to.equal(3);
						Expect(tmpDistinct.MissingCount).to.equal(1);
						let tmpNumbers = _Engine.fold({ Key: 'D', Kind: 'DistinctCount', Field: 'IDBook', FieldInfo: { Column: 'IDBook', DataType: 'Numeric' }, Dimensions: [] }, records('IDBook', [ 1, 2, 2, 3, null ]));
						Expect(tmpNumbers.DistinctCount).to.equal(3);

						let tmpString = _Engine.fold({ Key: 'M', Kind: 'Missing', Field: 'Language', FieldInfo: { Column: 'Language', DataType: 'String' }, Dimensions: [] }, records('Language', [ '', null, 'eng' ]));
						Expect(tmpString.MissingCount).to.equal(1);
						Expect(tmpString.Total).to.equal(3);
						let tmpDate = _Engine.fold({ Key: 'M', Kind: 'Missing', Field: 'EndDate', FieldInfo: { Column: 'EndDate', DataType: 'DateTime' }, Dimensions: [] }, records('EndDate', [ '', null, '2020-01-01 00:00:00' ]));
						Expect(tmpDate.MissingCount).to.equal(2);
					});

				test('Pivot: every non-empty cell including null keys; Range and DateBucket axes',
					() =>
					{
						let tmpRows = [
							{ PaymentMethod: 'Credit', SaleDate: '2021-02-03 00:00:00' },
							{ PaymentMethod: 'Credit', SaleDate: '2021-12-31 23:59:59' },
							{ PaymentMethod: 'Cash', SaleDate: '2022-01-01 00:00:00' },
							{ PaymentMethod: null, SaleDate: '2022-06-01 00:00:00' },
							{ PaymentMethod: 'Cash', SaleDate: null }
						];
						let tmpAgg = (
							{
								Key: 'P', Kind: 'Pivot', Field: null,
								Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'year' } ]
							});
						let tmpRaw = _Engine.fold(tmpAgg, tmpRows);
						Expect(tmpRaw.Total).to.equal(5);
						Expect(tmpRaw.Cells).to.deep.equal(
							[
								{ Keys: [ 'Cash', '2022-01-01 00:00:00' ], Count: 1 },
								{ Keys: [ 'Cash', null ], Count: 1 },
								{ Keys: [ 'Credit', '2021-01-01 00:00:00' ], Count: 2 },
								{ Keys: [ null, '2022-01-01 00:00:00' ], Count: 1 }
							]);
						let tmpRangeAgg = (
							{
								Key: 'P2', Kind: 'Pivot',
								Dimensions: [ { Kind: 'Range', Field: 'Rating', Ranges: [ { Key: 'low', To: 3 }, { Key: 'high', From: 3 } ] }, { Kind: 'Column', Field: 'IsActive', DataType: 'Boolean' } ]
							});
						let tmpRangeRaw = _Engine.fold(tmpRangeAgg, [ { Rating: 1, IsActive: 1 }, { Rating: 5, IsActive: 1 }, { Rating: 4, IsActive: 1 }, { Rating: null, IsActive: 0 } ]);
						Expect(tmpRangeRaw.Cells).to.deep.equal(
							[
								{ Keys: [ 'high', 1 ], Count: 2 },
								{ Keys: [ 'low', 1 ], Count: 1 },
								{ Keys: [ null, 0 ], Count: 1 }
							]);
					});

				test('unsupported kinds and pivot axes are refused with FACET_FOLD_UNSUPPORTED',
					() =>
					{
						Expect(() => { _Engine.fold({ Key: 'X', Kind: 'PathTerms', Dimensions: [] }, []); }).to.throw().with.property('Code', 'FACET_FOLD_UNSUPPORTED');
						let tmpNumericAxis = { Key: 'P', Kind: 'Pivot', Dimensions: [ { Kind: 'NumericBucket', Field: 'A', Mode: 'Nice', Buckets: 5 }, { Kind: 'Column', Field: 'B', DataType: 'String' } ] };
						Expect(() => { _Engine.fold(tmpNumericAxis, [ { A: 1, B: 'x' } ]); }).to.throw().with.property('Code', 'FACET_FOLD_UNSUPPORTED');
					});
			}
		);

		// ---------------------------------------------------------------- over the list (Bookstore)
		suite
		(
			'Reference over the list waterfall (Bookstore)',
			() =>
			{
				let _Harness = null;
				let _DB = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' },
						(pError) =>
						{
							_DB = _Harness.db;
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('an unfiltered Variant reads every live row (implicit soft-delete, Cap 0) and records match the list rows',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) });
						_Harness.fable.RetoldFacetingEngineReference.readVariantRows(tmpContext, tmpContext.Variants.v0,
							(pError, pRecords) =>
							{
								Expect(pError).to.not.exist;
								Expect(pRecords.length).to.equal(_Harness.seed.LiveCounts.Review);
								Expect(pRecords.every((pRecord) => { return pRecord.Deleted === 0; })).to.equal(true);
								Expect(tmpContext.Counters.BehaviorRuns).to.equal(1);
								let tmpFive = conjunct('c1', { Field: 'Rating', Op: 'EQ', Value: 5 });
								let tmpFiveContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', [ tmpFive ]) });
								_Harness.fable.RetoldFacetingEngineReference.readVariantRows(tmpFiveContext, tmpFiveContext.Variants.v0,
									(pFiveError, pFiveRecords) =>
									{
										Expect(pFiveError).to.not.exist;
										_Harness.listRows('Review', 'FBV~Rating~EQ~5', {},
											(pListError, pListRows) =>
											{
												Expect(pListError).to.not.exist;
												let tmpReferenceIDs = pFiveRecords.map((pRecord) => { return pRecord.IDReview; }).sort((pA, pB) => { return pA - pB; });
												let tmpListIDs = pListRows.map((pRecord) => { return pRecord.IDReview; }).sort((pA, pB) => { return pA - pB; });
												Expect(tmpReferenceIDs).to.deep.equal(tmpListIDs);
												Expect(tmpReferenceIDs.length).to.equal(sqlAll(_DB, 'SELECT count(*) AS N FROM Review WHERE Deleted = 0 AND Rating = 5')[0].N);
												return fDone();
											});
									});
							});
					});

				test('Terms and Count per Variant (disjunctive pair), one list read per Variant, memoized per request',
					(fDone) =>
					{
						let tmpRatingGE4 = conjunct('c1', { Field: 'Rating', Op: 'GE', Value: 4 });
						let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', [ tmpRatingGE4 ]), v1: variant('v1', 'Review', []) });
						let tmpAggs = (
							[
								{ Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] },
								{ Key: 'RatingSelf', Kind: 'Terms', VariantId: 'v1', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] },
								{ Key: 'RatingNone', Kind: 'Terms', VariantId: 'v0', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] }
							]);
						execute(_Harness, tmpContext, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Engine).to.equal('Reference');
								Expect(pExecution.Exact).to.equal(true);
								Expect(pExecution.AsOf).to.equal(tmpContext.Now);
								Expect(pExecution.Statements).to.equal(2);
								Expect(pExecution.Errors).to.deep.equal({});
								Expect(pExecution.Captures.Review.Fingerprint).to.equal('ref:c1');
								Expect(pExecution.Captures.Review.Repaired).to.equal(false);

								let tmpTotal = sqlAll(_DB, 'SELECT count(*) AS N FROM Review WHERE Deleted = 0 AND Rating >= 4')[0].N;
								Expect(pExecution.Results['#Total'].Total).to.equal(tmpTotal);
								let tmpAll = sqlAll(_DB, 'SELECT Rating AS Key, count(*) AS Count FROM Review WHERE Deleted = 0 GROUP BY 1');
								Expect(groupMap(pExecution.Results.RatingSelf.Groups)).to.deep.equal(groupMap(tmpAll.filter((pRow) => { return pRow.Key !== null; })));
								Expect(pExecution.Results.RatingSelf.Groups.length).to.equal(5);
								Expect(pExecution.Results.RatingSelf.MissingCount).to.equal(tmpAll.find((pRow) => { return pRow.Key === null; }).Count);
								Expect(pExecution.Results.RatingSelf.VariantId).to.equal('v1');
								Expect(pExecution.Results.RatingNone.Groups.map((pGroup) => { return pGroup.Key; }).sort()).to.deep.equal([ 4, 5 ]);
								Expect(pExecution.Results.RatingNone.Total).to.equal(tmpTotal);

								// Same context again: every Variant comes from the memo
								execute(_Harness, tmpContext, tmpAggs,
									(pAgainError, pAgain) =>
									{
										Expect(pAgainError).to.not.exist;
										Expect(pAgain.Statements).to.equal(0);
										Expect(pAgain.Results.RatingSelf).to.deep.equal(pExecution.Results.RatingSelf);
										return fDone();
									});
							});
					});

				test('NULL, Or and Show-deleted predicates go through the list path',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'Review',
							{
								v0: variant('v0', 'Review', [ conjunct('c1', { Field: 'Rating', Op: 'NULL' }) ]),
								// Conjunct Ids are unique within a request (the Variant rows are memoized by them)
								v1: variant('v1', 'Review', [ conjunct('c2', { Or: [ { Field: 'Rating', Op: 'EQ', Value: 1 }, { Field: 'Rating', Op: 'EQ', Value: 5 } ] }) ]),
								v2: variant('v2', 'Review', [ conjunct('c3', { Field: 'Deleted', Op: 'IN', Value: [ 0, 1 ] }, { Origin: { Kind: 'RawFilter', Hash: null, FilterKey: null, ClauseType: 'RawFilter', Index: 1 }, NeverExclude: true }) ])
							});
						let tmpAggs = (
							[
								{ Key: 'Nulls', Kind: 'Count', VariantId: 'v0', Dimensions: [] },
								{ Key: 'OneOrFive', Kind: 'Terms', VariantId: 'v1', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] },
								{ Key: 'WithDeleted', Kind: 'Count', VariantId: 'v2', Dimensions: [] }
							]);
						execute(_Harness, tmpContext, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Results.Nulls.Total).to.equal(sqlAll(_DB, 'SELECT count(*) AS N FROM Review WHERE Deleted = 0 AND Rating IS NULL')[0].N);
								Expect(pExecution.Results.Nulls.Total).to.be.greaterThan(0);
								Expect(groupMap(pExecution.Results.OneOrFive.Groups)).to.deep.equal(
									groupMap(sqlAll(_DB, 'SELECT Rating AS Key, count(*) AS Count FROM Review WHERE Deleted = 0 AND Rating IN (1, 5) GROUP BY 1')));
								Expect(pExecution.Results.WithDeleted.Total).to.equal(_Harness.seed.Counts.Review);
								return fDone();
							});
					});

				test('DateHistogram keys equal SQLite strftime for month, ISO week and quarter (BookStoreSale.SaleDate)',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) });
						let tmpAggs = [ 'month', 'week', 'quarter', 'year' ].map(
							(pInterval) =>
							{
								return { Key: pInterval, Kind: 'DateHistogram', VariantId: 'v0', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: pInterval } ] };
							});
						let tmpExpressions = (
							{
								month: "strftime('%Y-%m-01 00:00:00', SaleDate)",
								week: "strftime('%Y-%m-%d 00:00:00', SaleDate, '-6 days', 'weekday 1')",
								quarter: "printf('%s-%02d-01 00:00:00', strftime('%Y', SaleDate), ((CAST(strftime('%m', SaleDate) AS integer) - 1) / 3) * 3 + 1)",
								year: "strftime('%Y-01-01 00:00:00', SaleDate)"
							});
						execute(_Harness, tmpContext, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Statements).to.equal(1);
								Object.keys(tmpExpressions).forEach(
									(pInterval) =>
									{
										let tmpSQL = sqlAll(_DB, `SELECT ${tmpExpressions[pInterval]} AS Key, count(*) AS Count FROM BookStoreSale WHERE Deleted = 0 AND SaleDate IS NOT NULL GROUP BY 1`);
										Expect(groupMap(pExecution.Results[pInterval].Groups), pInterval).to.deep.equal(groupMap(tmpSQL));
										Expect(pExecution.Results[pInterval].MissingCount, pInterval).to.equal(sqlAll(_DB, 'SELECT count(*) AS N FROM BookStoreSale WHERE Deleted = 0 AND SaleDate IS NULL')[0].N);
									});
								Expect(pExecution.Results.month.Groups.length).to.equal(49);
								Expect(pExecution.Results.month.Groups[0]).to.deep.equal({ Key: '2020-12-01 00:00:00', Count: 1 });
								Expect(pExecution.Results.month.Bounds).to.deep.equal({ Lo: '2020-12-31 09:33:32', Hi: '2024-12-30 21:55:33' });
								return fDone();
							});
					});

				test('NumericHistogram and Stats on a Decimal agree with integer SQL over the same rows (BookStoreSale.TotalAmount)',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) });
						let tmpAggs = (
							[
								{ Key: 'Hist', Kind: 'NumericHistogram', VariantId: 'v0', Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice', Buckets: 20, Edges: null, OpenEnded: false, IsInteger: false, Scale: 2 } ] },
								{ Key: 'Stats', Kind: 'Stats', VariantId: 'v0', Field: 'TotalAmount', FieldInfo: { Column: 'TotalAmount', DataType: 'Decimal', IsInteger: false, Scale: 2 }, Dimensions: [] },
								{ Key: 'Dates', Kind: 'Stats', VariantId: 'v0', Field: 'SaleDate', FieldInfo: { Column: 'SaleDate', DataType: 'DateTime', IsInteger: false, Scale: 0 }, Dimensions: [] }
							]);
						execute(_Harness, tmpContext, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpSQL = sqlAll(_DB, 'SELECT min(TotalAmount) AS Lo, max(TotalAmount) AS Hi, count(TotalAmount) AS NonNull, count(*) AS Rows, sum(CAST(round(TotalAmount * 100) AS INTEGER)) AS SumUnits FROM BookStoreSale WHERE Deleted = 0')[0];
								let tmpHist = pExecution.Results.Hist;
								Expect(tmpHist.Bounds).to.deep.equal({ Lo: tmpSQL.Lo, Hi: tmpSQL.Hi });
								Expect(tmpHist.MissingCount).to.equal(tmpSQL.Rows - tmpSQL.NonNull);
								let tmpGeometry = tmpHist.Geometry;
								Expect(tmpGeometry).to.deep.equal(libFacetBuckets.numericGeometry(tmpSQL.Lo, tmpSQL.Hi, 20, 2, _Harness.faceting.options.Limits.MaxBuckets));
								// Independent membership: the RAW value against the exact edges (the comparison the
								// bucket's NumericRange Clause makes), last bucket closed.
								let tmpByEdge = {};
								sqlAll(_DB, 'SELECT TotalAmount AS V FROM BookStoreSale WHERE Deleted = 0 AND TotalAmount IS NOT NULL').forEach(
									(pRow) =>
									{
										let tmpIndex = 0;
										while ((tmpIndex < (tmpGeometry.N - 1)) && (pRow.V >= tmpGeometry.Edges[tmpIndex + 1]))
										{
											tmpIndex++;
										}
										tmpByEdge[tmpIndex] = (tmpByEdge[tmpIndex] || 0) + 1;
									});
								Expect(groupMap(tmpHist.Groups)).to.deep.equal(tmpByEdge);
								// The sub-Scale trap (499.996) sits in bucket 0 ([0, 500)), where its Clause puts it.
								Expect(tmpByEdge[1]).to.equal(undefined);
								let tmpSum = tmpHist.Groups.reduce((pSum, pGroup) => { return pSum + pGroup.Count; }, 0);
								Expect(tmpSum + tmpHist.MissingCount).to.equal(tmpHist.Total);

								Expect(pExecution.Results.Stats.Stats).to.deep.equal({ Rows: tmpSQL.Rows, NonNull: tmpSQL.NonNull, Min: tmpSQL.Lo, Max: tmpSQL.Hi, SumUnits: tmpSQL.SumUnits, Factor: 100 });
								let tmpDates = sqlAll(_DB, "SELECT min(SaleDate) AS Lo, max(SaleDate) AS Hi, count(SaleDate) AS NonNull FROM BookStoreSale WHERE Deleted = 0 AND SaleDate <> ''")[0];
								Expect(pExecution.Results.Dates.Stats).to.deep.include({ NonNull: tmpDates.NonNull, Min: tmpDates.Lo, Max: tmpDates.Hi, SumUnits: null });
								return fDone();
							});
					});

				test('Terms with \'\' keys, Missing, DistinctCount, Ranges with a negative outlier, and a 2-D Pivot agree with SQL',
					(fDone) =>
					{
						let tmpBookContext = newContext(_Harness, 'Book', { v0: variant('v0', 'Book', []) });
						let tmpRanges = [ { Key: 'ancient', From: null, To: 0 }, { Key: 'old', From: 0, To: 1950 }, { Key: 'modern', From: 1950, To: null } ];
						let tmpBookAggs = (
							[
								{ Key: 'Language', Kind: 'Terms', VariantId: 'v0', Dimensions: [ { Kind: 'Column', Field: 'Language', DataType: 'String' } ] },
								{ Key: 'LanguageMissing', Kind: 'Missing', VariantId: 'v0', Field: 'Language', FieldInfo: { Column: 'Language', DataType: 'String' }, Dimensions: [] },
								{ Key: 'Era', Kind: 'Ranges', VariantId: 'v0', Dimensions: [ { Kind: 'Range', Field: 'PublicationYear', Ranges: tmpRanges, IsInteger: true, Scale: 0 } ] }
							]);
						execute(_Harness, tmpBookContext, tmpBookAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpLanguages = sqlAll(_DB, 'SELECT Language AS Key, count(*) AS Count FROM Book WHERE Deleted = 0 GROUP BY 1');
								Expect(groupMap(pExecution.Results.Language.Groups)).to.deep.equal(groupMap(tmpLanguages.filter((pRow) => { return pRow.Key !== null; })));
								Expect(pExecution.Results.Language.Groups.some((pGroup) => { return pGroup.Key === ''; })).to.equal(true);
								Expect(pExecution.Results.LanguageMissing.MissingCount).to.equal(tmpLanguages.find((pRow) => { return pRow.Key === null; }).Count);
								let tmpEra = sqlAll(_DB,
									"SELECT CASE WHEN PublicationYear < 0 THEN 'ancient' WHEN PublicationYear >= 0 AND PublicationYear < 1950 THEN 'old' WHEN PublicationYear >= 1950 THEN 'modern' END AS Key, count(*) AS Count FROM Book WHERE Deleted = 0 AND PublicationYear IS NOT NULL GROUP BY 1");
								Expect(groupMap(pExecution.Results.Era.Groups)).to.deep.equal(groupMap(tmpEra));
								Expect(pExecution.Results.Era.Groups[0].Key).to.equal('ancient');

								let tmpSaleContext = newContext(_Harness, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', [ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit', 'Cash', '' ] }) ]) });
								let tmpSaleAggs = (
									[
										{ Key: 'Pivot', Kind: 'Pivot', VariantId: 'v0', Field: null, Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'year' } ] },
										{ Key: 'Stores', Kind: 'DistinctCount', VariantId: 'v0', Field: 'IDBookStore', FieldInfo: { Column: 'IDBookStore', DataType: 'Numeric' }, Dimensions: [] }
									]);
								execute(_Harness, tmpSaleContext, tmpSaleAggs,
									(pSaleError, pSaleExecution) =>
									{
										Expect(pSaleError).to.not.exist;
										let tmpCells = sqlAll(_DB,
											"SELECT PaymentMethod AS K1, strftime('%Y-01-01 00:00:00', SaleDate) AS K2, count(*) AS Count FROM BookStoreSale WHERE Deleted = 0 AND PaymentMethod IN ('Credit', 'Cash', '') GROUP BY 1, 2");
										let fCellMap = (pCells) =>
										{
											let tmpMap = {};
											pCells.forEach((pCell) => { tmpMap[JSON.stringify(pCell.Keys || [ pCell.K1, pCell.K2 ])] = pCell.Count; });
											return tmpMap;
										};
										Expect(fCellMap(pSaleExecution.Results.Pivot.Cells)).to.deep.equal(fCellMap(tmpCells));
										Expect(pSaleExecution.Results.Pivot.Cells.reduce((pSum, pCell) => { return pSum + pCell.Count; }, 0)).to.equal(pSaleExecution.Results.Pivot.Total);
										Expect(pSaleExecution.Results.Stores.DistinctCount).to.equal(
											sqlAll(_DB, "SELECT count(DISTINCT IDBookStore) AS N FROM BookStoreSale WHERE Deleted = 0 AND PaymentMethod IN ('Credit', 'Cash', '')")[0].N);
										return fDone();
									});
							});
					});

				test('per-Agg failures: unknown Variant → FACET_INTERNAL, past deadline → FACET_TIMEOUT (no read)',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) });
						tmpContext.Deadline = Date.now() - 1;
						let tmpAggs = (
							[
								{ Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] },
								{ Key: 'Lost', Kind: 'Count', VariantId: 'v9', Dimensions: [] }
							]);
						execute(_Harness, tmpContext, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								Expect(pExecution.Errors.Lost.Code).to.equal('FACET_INTERNAL');
								Expect(pExecution.Errors['#Total']).to.deep.include({ Code: 'FACET_TIMEOUT', Status: 504 });
								Expect(pExecution.Statements).to.equal(0);
								Expect(pExecution.Results).to.deep.equal({});
								return fDone();
							});
					});

				test('O2 helper: list counts confirm correct buckets and catch a wrong one',
					(fDone) =>
					{
						// Body: Rating >= 4 (owned by the Rating facet, excluded) AND IDBook <= 500 (kept)
						let tmpBody = { FilterString: 'FBV~Rating~GE~4~FBV~IDBook~LE~500', Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] };
						let tmpConjuncts = _Harness.fable.RetoldFacetingFilterAST.build('Review', tmpBody).Conjuncts;
						Expect(tmpConjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c2' ]);
						let tmpRows = sqlAll(_DB, 'SELECT Rating AS Key, count(*) AS Count FROM Review WHERE Deleted = 0 AND IDBook <= 500 GROUP BY 1 ORDER BY 2 DESC');
						let tmpTotal = tmpRows.reduce((pSum, pRow) => { return pSum + pRow.Count; }, 0);
						let tmpMissing = tmpRows.filter((pRow) => { return pRow.Key === null; }).reduce((pSum, pRow) => { return pSum + pRow.Count; }, 0);
						let tmpBuckets = tmpRows.filter((pRow) => { return pRow.Key !== null; }).map(
							(pRow) =>
							{
								return (
									{
										Key: pRow.Key, Label: String(pRow.Key), Count: pRow.Count, Selected: pRow.Key >= 4,
										Clause: { Type: 'DistinctSelectedValueList', FilterByColumn: 'Rating', Values: [ pRow.Key ], FilterKey: 'Rating', ClauseKey: 'DistinctSelectedValueList' }
									});
							});
						tmpBuckets.push({ Key: 9, Label: '9', Count: 0, Selected: false, Clause: { Type: 'DistinctSelectedValueList', FilterByColumn: 'Rating', Values: [ 9 ], FilterKey: 'Rating', ClauseKey: 'DistinctSelectedValueList' } });
						let tmpEnvelope = (
							{
								ContractVersion: 1,
								Entity: 'Review',
								Total: sqlAll(_DB, 'SELECT count(*) AS N FROM Review WHERE Deleted = 0 AND IDBook <= 500 AND Rating >= 4')[0].N,
								Facets:
									{
										Rating:
											{
												Key: 'Rating', Facet: 'Review.Rating', Field: 'Rating', Fold: 'Terms', Selectable: true,
												Disjunctive: 'Exact', Excluded: [ 'c1' ], KeptMixed: [],
												Total: tmpTotal, SumOfCounts: tmpTotal - tmpMissing, MissingCount: tmpMissing, OtherCount: 0, MultiValued: false,
												Buckets: tmpBuckets
											}
									}
							});
						_Harness.assertSelectionRoundTrip('Review', tmpBody, tmpEnvelope, {},
							(pError, pReport) =>
							{
								Expect(pError).to.not.exist;
								// derived Excluded + envelope Total + facet Total + identity + 5 positive buckets + 1 zero bucket
								Expect(pReport.Checked).to.equal(10);
								Expect(pReport.Mismatches).to.deep.equal([]);

								let tmpBroken = JSON.parse(JSON.stringify(tmpEnvelope));
								tmpBroken.Facets.Rating.Buckets[0].Count += 1;
								tmpBroken.Total += 1;
								_Harness.assertSelectionRoundTrip('Review', tmpBody, tmpBroken, { MaxBuckets: 2, ZeroSample: 0 },
									(pBrokenError, pBrokenReport) =>
									{
										Expect(pBrokenError).to.be.an('error');
										Expect(pBrokenReport.Skipped).to.equal(3);
										Expect(pBrokenReport.Mismatches.map((pMismatch) => { return pMismatch.Check; }).sort()).to.deep.equal([ 'BucketCount', 'EnvelopeTotal' ]);

										// A planner that excluded the wrong conjunct is caught by the request-derived exclusion,
										// even though every count agrees with its own (wrong) filter.
										let tmpWrongExclusion = JSON.parse(JSON.stringify(tmpEnvelope));
										tmpWrongExclusion.Facets.Rating.Excluded = [ 'c2' ];
										let tmpBucketMismatch = pBrokenReport.Mismatches.find((pMismatch) => { return pMismatch.Check === 'BucketCount'; });
										Expect(tmpBucketMismatch.Key).to.equal(tmpBuckets[0].Key);
										Expect(tmpBucketMismatch.Actual).to.equal(tmpBuckets[0].Count);
										_Harness.assertSelectionRoundTrip('Review', tmpBody, tmpWrongExclusion, { MaxBuckets: 0, ZeroSample: 0 },
											(pWrongError, pWrongReport) =>
											{
												Expect(pWrongError).to.be.an('error');
												Expect(pWrongReport.Mismatches.map((pMismatch) => { return pMismatch.Check; })).to.include('Excluded');
												return fDone();
											});
									});
							});
					});

				test('harness.reference() runs the pipeline with ForceEngine Reference',
					function (fDone)
					{
						let tmpBody = { FilterString: 'FBV~Rating~GE~4', Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ], Total: true };
						_Harness.reference('Review', tmpBody, {},
							(pError, pEnvelope) =>
							{
								setImmediate(
									() =>
									{
										Expect(pError).to.not.exist;
										Expect(pEnvelope.Engine).to.equal('Reference');
										_Harness.assertSelectionRoundTrip('Review', tmpBody, pEnvelope, {}, fDone);
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- tenancy (Bookstore-Tenant)
		suite
		(
			'Reference over the list waterfall (Bookstore-Tenant)',
			() =>
			{
				let _Harness = null;
				let _DB = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant' },
						(pError) =>
						{
							_DB = _Harness.db;
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('the tenancy behavior is installed on every entity (Reads and Count)',
					() =>
					{
						Expect(_Harness.tenancyEntities.slice().sort()).to.deep.equal(Object.keys(_Harness.model.Tables).sort());
						Expect(_Harness.faceting.options.Scope.Policy).to.deep.include({ Column: 'IDTenant', SessionField: 'IDTenant' });
					});

				test('each tenant sees only its own rows; facets equal that tenant\'s own list and SQL',
					(fDone) =>
					{
						let tmpAggs = (
							[
								{ Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] },
								{ Key: 'Rating', Kind: 'Terms', VariantId: 'v0', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric' } ] }
							]);
						let fTenant = (pTenant, fNext) =>
						{
							let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) }, { Tenant: pTenant });
							execute(_Harness, tmpContext, tmpAggs,
								(pError, pExecution) =>
								{
									Expect(pError).to.not.exist;
									Expect(pExecution.Results['#Total'].Total).to.equal(_Harness.seed.TenantLiveCounts[pTenant].Review);
									let tmpSQL = sqlAll(_DB, 'SELECT Rating AS Key, count(*) AS Count FROM Review WHERE Deleted = 0 AND IDTenant = ? AND Rating IS NOT NULL GROUP BY 1', [ pTenant ]);
									Expect(groupMap(pExecution.Results.Rating.Groups)).to.deep.equal(groupMap(tmpSQL));
									Expect(tmpContext.Memo.VariantRows['Review|'].every((pRecord) => { return pRecord.IDTenant === pTenant; })).to.equal(true);
									_Harness.listCount('Review', '', { Tenant: pTenant },
										(pCountError, pCount) =>
										{
											Expect(pCountError).to.not.exist;
											Expect(pCount).to.equal(pExecution.Results['#Total'].Total);
											return fNext();
										});
								});
						};
						fTenant(1, () => { fTenant(2, fDone); });
					});

				test('anonymous → whole-request FACET_UNAUTHENTICATED (the behavior\'s 401)',
					(fDone) =>
					{
						let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) });
						execute(_Harness, tmpContext, [ { Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] } ],
							(pError, pExecution) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Code).to.equal('FACET_UNAUTHENTICATED');
								Expect(pError.Status).to.equal(401);
								Expect(pExecution).to.not.exist;
								return fDone();
							});
					});

				test('behaviors chain: an added behavior composes with tenancy in the list and the Reference alike; other errors → FACET_INTERNAL',
					(fDone) =>
					{
						// User 77 only sees Rating >= 4 (on top of tenancy); user 99 gets a 418 from the behavior.
						let fRatingScope = function (pRequest, pRequestState, fCallback)
						{
							if (pRequestState.SessionData && (pRequestState.SessionData.UserID === 99))
							{
								return fCallback(this.ErrorHandler.getError('I am a teapot.', 418));
							}
							if (pRequestState.SessionData && (pRequestState.SessionData.UserID === 77))
							{
								pRequestState.Query.addFilter('Rating', 4, '>=', 'AND', 'TestRatingScope');
							}
							return fCallback();
						};
						_Harness.installBehavior('Review', 'Reads-QueryConfiguration', fRatingScope);
						_Harness.installBehavior('Review', 'Count-QueryConfiguration', fRatingScope);

						let tmpContext = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) }, { Tenant: 2, User: 77 });
						execute(_Harness, tmpContext, [ { Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] } ],
							(pError, pExecution) =>
							{
								Expect(pError).to.not.exist;
								let tmpExpected = sqlAll(_DB, 'SELECT count(*) AS N FROM Review WHERE Deleted = 0 AND IDTenant = 2 AND Rating >= 4')[0].N;
								Expect(pExecution.Results['#Total'].Total).to.equal(tmpExpected);
								_Harness.listCount('Review', '', { Tenant: 2, User: 77 },
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.not.exist;
										Expect(pCount).to.equal(tmpExpected);
										let tmpTeapot = newContext(_Harness, 'Review', { v0: variant('v0', 'Review', []) }, { Tenant: 2, User: 99 });
										execute(_Harness, tmpTeapot, [ { Key: '#Total', Kind: 'Count', VariantId: 'v0', Dimensions: [] } ],
											(pTeapotError) =>
											{
												Expect(pTeapotError).to.be.an('error');
												Expect(pTeapotError.Code).to.equal('FACET_INTERNAL');
												Expect(pTeapotError.message).to.not.match(/teapot/);
												return fDone();
											});
									});
							});
					});
			}
		);
	}
);
