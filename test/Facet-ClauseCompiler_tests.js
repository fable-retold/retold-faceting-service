/**
 * Facet-ClauseCompiler: pict's own Filter.js (headless) is the oracle for clause compilation (D-04,
 * 10 §5 O1).  For every M1 clause type and option combination the clause array is compiled TWO
 * ways on the seeded Bookstore:
 *
 *   pict    pict/source/filters/Filter.js builds the meadow-filter string exactly as
 *           pict-section-recordset does (generate → normalize → compile); the real LIST route reads
 *           the rows for it;
 *   facet   ClauseCompiler.compile + FilterAST.applyToQuery on a fresh query of the entity's
 *           route-bound DAL (the Live engine's rendering), read with doReads.
 *
 * The two live-row ID sets must be equal.  (The comparison is on live rows: the stock list appends
 * its implicit soft delete without parentheses, so a pict top-level OR leaks soft-deleted rows into
 * the LIST — an upstream precedence issue the facet's fence does not have.)
 *
 * Documented deviations are asserted as such: a numeric Start of 0 IS a bound for the facet (pict
 * drops it as falsy).
 *
 * Port 19113 (internal-contracts §14.4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libPictFilter = require('pict/source/filters/Filter.js');

const libHarness = require('./support/Facet-Test-Harness.js');

const PORT = 19113;

/**
 * The meadow-filter string pict-section-recordset sends for a clause array (decoded once: the
 * route decodes the URL segment exactly once).
 *
 * @param {any} pFable
 * @param {string} pEntity
 * @param {Array<Record<string, any>>} pClauses
 * @return {string}
 */
const pictFilterString = (pFable, pEntity, pClauses) =>
{
	let tmpGenerator = new libPictFilter(pFable);
	let tmpState = { Entity: pEntity, FilterConfiguration: JSON.parse(JSON.stringify(pClauses)), Mode: 'Records', ResultDestinationAddress: 'AppData.Rows' };
	tmpGenerator.generateMeadowFilterStanzas(tmpState);
	tmpGenerator.normalizeMeadowFilterStanzas(tmpState);
	tmpGenerator.compileMeadowFilterStanzas(tmpState);
	let tmpLoad = tmpState.BundleConfig[tmpState.BundleConfig.length - 1];
	return decodeURIComponent(tmpLoad.Filter || '');
};

/**
 * Live-row IDs (sorted) of a list of records.
 *
 * @param {Array<Record<string, any>>} pRecords
 * @param {string} pPrimaryKey
 * @return {Array<number>}
 */
const liveIDs = (pRecords, pPrimaryKey) =>
{
	return pRecords.filter((pRecord) => { return !pRecord.Deleted; }).map((pRecord) => { return pRecord[pPrimaryKey]; }).sort((pA, pB) => { return pA - pB; });
};

suite
(
	'Facet-ClauseCompiler (pict Filter.js oracle)',
	() =>
	{
		let _Harness = null;

		suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' }, fDone); });
		suiteTeardown((fDone) => { _Harness.stop(fDone); });

		/**
		 * The facet's rows for a clause array: ClauseCompiler + applyToQuery on the route-bound DAL.
		 *
		 * @param {string} pEntity
		 * @param {Array<Record<string, any>>} pClauses
		 * @param {(pIDs: Array<number>) => void} fCallback
		 */
		let fFacetRows = (pEntity, pClauses, fCallback) =>
		{
			let tmpConjuncts = _Harness.fable.RetoldFacetingClauseCompiler.compile(pEntity, pClauses).Conjuncts;
			tmpConjuncts.forEach((pConjunct, pIndex) => { pConjunct.Id = `c${pIndex + 1}`; });
			let tmpDAL = _Harness.faceting.Host.getExecutionDAL(pEntity);
			let tmpQuery = tmpDAL.query;
			tmpQuery.setCap(0).setBegin(0);
			if (tmpConjuncts.length > 0)
			{
				tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
				_Harness.fable.RetoldFacetingFilterAST.applyToQuery(tmpConjuncts, tmpQuery, { Dialect: 'SQLite', ParameterPrefix: 'c' });
				tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			}
			tmpDAL.doReads(tmpQuery,
				(pError, pQuery, pRecords) =>
				{
					Expect(pError).to.not.exist;
					setImmediate(() => { fCallback(liveIDs(pRecords, tmpDAL.defaultIdentifier)); });
				});
		};

		/**
		 * pict's rows for a clause array, through the real LIST route.
		 *
		 * @param {string} pEntity
		 * @param {Array<Record<string, any>>} pClauses
		 * @param {(pIDs: Array<number>, pFilter: string) => void} fCallback
		 */
		let fPictRows = (pEntity, pClauses, fCallback) =>
		{
			let tmpFilter = pictFilterString(_Harness.fable, pEntity, pClauses);
			_Harness.listRows(pEntity, tmpFilter, {},
				(pError, pRecords) =>
				{
					Expect(pError, pError ? pError.message : '').to.not.exist;
					return fCallback(liveIDs(pRecords, _Harness.faceting.Host.getPrimaryKey(pEntity)), tmpFilter);
				});
		};

		const CASES =
			[
				[ 'DistinctSelectedValueList, several values', 'Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction', 'Mystery' ] } ] ],
				[ 'DistinctSelectedValueList on an integer column', 'Review', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Rating', Values: [ 4, 5 ] } ] ],
				[ 'DistinctSelectedValueList on a foreign key (numeric strings)', 'BookStoreSale', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'IDBookStore', Values: [ '3', '7' ] } ] ],
				[ 'DistinctSelectedValueList across FilterByColumns (OR across columns)', 'Book', [ { Type: 'DistinctSelectedValueList', FilterByColumns: [ 'Genre', 'Type' ], Values: [ 'Fiction', 'eBook' ] } ] ],
				[ 'DistinctSelectedValueList with a null value (skipped)', 'Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'fre', null ] } ] ],
				[ 'DateRange inclusive (date-only bounds)', 'BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2023-01-01', End: '2023-06-30' } } ] ],
				[ 'DateRange EndExclusive on a boundary trap', 'BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2023-04-01', End: '2023-07-01' }, EndExclusive: true } ] ],
				[ 'DateRange StartExclusive', 'BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2023-04-01' }, StartExclusive: true } ] ],
				[ 'DateRange with only End', 'BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { End: '2021-03-01' }, EndExclusive: true } ] ],
				[ 'DateRange with \'0\' bounds is no filter', 'BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '0', End: '0' } } ] ],
				[ 'NumericRange EndExclusive on a decimal', 'BookStoreSale', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 50, End: 200 }, EndExclusive: true } ] ],
				[ 'NumericRange inclusive with string bounds', 'BookStoreSale', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: '100.5', End: '150' } } ] ],
				[ 'NumericRange StartExclusive on an integer', 'Review', [ { Type: 'NumericRange', FilterByColumn: 'Rating', Values: { Start: 3 }, StartExclusive: true } ] ],
				[ 'StringRange', 'Book', [ { Type: 'StringRange', FilterByColumn: 'Genre', Values: { Start: 'F', End: 'M' } } ] ],
				[ 'Range (generic)', 'Book', [ { Type: 'Range', FilterByColumn: 'PublicationYear', Values: { Start: 1990, End: 2000 }, EndExclusive: true } ] ],
				[ 'StringMatch (LIKE %v%)', 'Book', [ { Type: 'StringMatch', FilterByColumn: 'Title', Values: [ 'the' ] } ] ],
				[ 'Match with ExactMatch', 'Book', [ { Type: 'Match', FilterByColumn: 'Genre', Values: [ 'Fiction' ], ExactMatch: true } ] ],
				[ 'Match across columns and values (OR)', 'Book', [ { Type: 'Match', FilterByColumns: [ 'Genre', 'Type' ], Values: [ 'Fic', 'Audio' ] } ] ],
				[ 'NumericMatch (EQ by default)', 'Review', [ { Type: 'NumericMatch', FilterByColumn: 'Rating', Values: [ 3 ] } ] ],
				[ 'DateMatch (EQ by default) on a canonical value', 'BookStoreSale', [ { Type: 'DateMatch', FilterByColumn: 'SaleDate', Values: [ '2020-12-31 09:33:32' ] } ] ],
				[ 'Enabled: false clauses are skipped', 'Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Poetry' ], Enabled: false }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Type', Values: [ 'eBook' ] } ] ],
				[ 'several clauses ANDed', 'BookStoreSale', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Cash', 'Credit' ] }, { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 20 } }, { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2022-01-01', End: '2023-01-01' }, EndExclusive: true } ] ],
				[ 'ungrouped Junction OR (FOPOR precedence: A AND B OR C)', 'Book',
					[
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Poetry' ] },
						{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 2010 } },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'fre' ], Junction: 'OR' }
					] ],
				[ 'a GUIDGroup with an OR junction, members ordered by Ordinal, after an ungrouped clause', 'BookStoreSale',
					[
						{ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 100 } },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Cash' ], GUIDGroup: 'g1', Ordinal: 2, Junction: 'OR' },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Online' ], GUIDGroup: 'g1', Ordinal: 1 }
					] ],
				[ 'Ordinal reorders top-level clauses (the OR junction moves with its clause)', 'Book',
					[
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'spa' ], Junction: 'OR', Ordinal: 2 },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'History' ], Ordinal: 1 },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Type', Values: [ 'Book' ], Ordinal: 1 }
					] ],
				[ 'RawFilter next to a clause', 'Book', [ { Type: 'RawFilter', Value: 'FBV~PublicationYear~GE~2000' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction' ] } ] ],
				// pict prepends RawFilter stanzas unwrapped: their OR binds the clause into its last branch.
				[ 'RawFilter with its own OR', 'BookStoreSale', [ { Type: 'RawFilter', Value: 'FBV~PaymentMethod~EQ~Cash~FBVOR~PaymentMethod~EQ~Online' }, { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { End: 60 }, EndExclusive: true } ] ],
				[ 'a clause OR after a RawFilter (the RawFilter joins the first branch)', 'Book',
					[
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction' ] },
						{ Type: 'RawFilter', Value: 'FBV~Type~EQ~eBook' },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'eng' ] },
						{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Poetry' ], Junction: 'OR' }
					] ],
				[ 'two RawFilters, the second OR-connected', 'Book', [ { Type: 'RawFilter', Value: 'FBV~Genre~EQ~History' }, { Type: 'RawFilter', Value: 'FBVOR~Genre~EQ~Travel' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Type', Values: [ 'Book' ] } ] ]
			];

		CASES.forEach(
			(pCase) =>
			{
				test(pCase[0],
					(fDone) =>
					{
						fPictRows(pCase[1], pCase[2],
							(pPictIDs, pFilter) =>
							{
								fFacetRows(pCase[1], pCase[2],
									(pFacetIDs) =>
									{
										Expect(pFacetIDs.length, `pict filter: ${pFilter}`).to.equal(pPictIDs.length);
										Expect(pFacetIDs, `pict filter: ${pFilter}`).to.deep.equal(pPictIDs);
										return fDone();
									});
							});
					});
			});

		test('the oracle is not vacuous: every case selects some rows and most select a strict subset',
			(fDone) =>
			{
				let tmpStrict = 0;
				let fNext = (pIndex) =>
				{
					if (pIndex >= CASES.length)
					{
						Expect(tmpStrict).to.be.at.least(CASES.length - 2);
						return fDone();
					}
					fFacetRows(CASES[pIndex][1], CASES[pIndex][2],
						(pIDs) =>
						{
							Expect(pIDs.length, CASES[pIndex][0]).to.be.above(0);
							if (pIDs.length < _Harness.seed.LiveCounts[CASES[pIndex][1]])
							{
								tmpStrict++;
							}
							return fNext(pIndex + 1);
						});
				};
				fNext(0);
			});

		test('documented deviation: a numeric Start of 0 IS a bound for the facet (pict drops a falsy 0)',
			(fDone) =>
			{
				let tmpClauses = [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 0 } } ];
				Expect(pictFilterString(_Harness.fable, 'BookStoreSale', tmpClauses)).to.equal('');
				fFacetRows('BookStoreSale', tmpClauses,
					(pFacetIDs) =>
					{
						_Harness.listRows('BookStoreSale', 'FBV~TotalAmount~GE~0', {},
							(pError, pRecords) =>
							{
								Expect(pFacetIDs).to.deep.equal(liveIDs(pRecords, 'IDBookStoreSale'));
								Expect(pFacetIDs.length).to.be.below(_Harness.seed.LiveCounts.BookStoreSale);
								return fDone();
							});
					});
			});
	}
);
