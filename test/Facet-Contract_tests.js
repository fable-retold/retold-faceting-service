/**
 * Facet contract tests: the pure modules under source/contract/ (internal-contracts §3, §10, §13).
 *
 * No server, no port.  The SQLite parity suites use node:sqlite directly to prove the canonical
 * date keys and numeric bucket indexes equal what the SQLite shell expressions (03 §3.4,
 * internal-contracts §10.3) compute.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../source/contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libFacetClauses = require('../source/contract/Facet-Contract-Clauses.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

let libNodeSQLite = null;
try
{
	libNodeSQLite = require('node:sqlite');
}
catch (pError)
{
	libNodeSQLite = null;
}

const DASH = '–';

/**
 * Run fThrows and return the FacetError it threw (fails the test when nothing is thrown).
 *
 * @param {function} fThrows
 * @return {Error}
 */
const caught = (fThrows) =>
{
	try
	{
		fThrows();
	}
	catch (pError)
	{
		return pError;
	}
	throw new Error('Expected a throw.');
};

/**
 * Assert fThrows throws a FacetError with this code (and optional Detail subset).
 *
 * @param {function} fThrows
 * @param {string} pCode
 * @param {Record<string, any>} [pDetail]
 * @return {Error}
 */
const expectFacetError = (fThrows, pCode, pDetail) =>
{
	let tmpError = caught(fThrows);
	Expect(libFacetErrors.isFacetError(tmpError), String(tmpError && tmpError.stack)).to.equal(true);
	Expect(tmpError.Code).to.equal(pCode);
	Expect(tmpError.Status).to.equal(libFacetErrors.CODES[pCode].Status);
	if (pDetail)
	{
		Expect(tmpError.Detail).to.include(pDetail);
	}
	return tmpError;
};

// mulberry32, the fixture PRNG (its one owner is Bookstore-Seed).
const prng = libBuilders.prng;

/**
 * A minimal Agg (internal-contracts §5.1) for post-processing tests.
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
const agg = (pFields) =>
{
	return Object.assign(
		{
			Key: 'K',
			FacetID: 'BookStoreSale.PaymentMethod',
			FacetIDs: [ 'BookStoreSale.PaymentMethod' ],
			Kind: 'Terms',
			Pivot: 'BookStoreSale',
			Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String', IsInteger: false, Scale: 0 } ],
			Field: 'PaymentMethod',
			FieldInfo: null,
			Measures: [ { Op: 'count' } ],
			CountMode: 'Rows',
			Top: 20,
			Order: 'CountDesc',
			Missing: true,
			EmptyBuckets: true,
			Chart: false,
			Exclude: 'Self',
			VariantId: 'v1',
			Disjunctive: { Mode: 'Exact', Excluded: [], ExcludedHashes: [], KeptMixed: [], Owned: [] },
			ClauseType: 'DistinctSelectedValueList',
			FilterKey: 'PaymentMethod',
			Selectable: true,
			DisplayName: 'Payment Method'
		}, pFields);
};

const POST = { Engine: 'Live', AsOf: '2026-10-08T15:02:11.120Z', Exact: true, Limits: { MaxDateBuckets: 400, MaxTop: 500, DefaultTop: 20, MaxBuckets: 500, DefaultBuckets: 20 }, StorageTimeZone: 'UTC', OwnedConjuncts: [] };

/**
 * pPost with owned conjuncts.
 *
 * @param {Array<Record<string, any>>} pOwned
 * @return {Record<string, any>}
 */
const postWith = (pOwned) =>
{
	return Object.assign({}, POST, { OwnedConjuncts: pOwned });
};

/**
 * A conjunct (internal-contracts §4.2) from a Clause origin.
 *
 * @param {string} pId
 * @param {Record<string, any>} pPred
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const conjunct = (pId, pPred, pExtra) =>
{
	return libBuilders.conjunct(pId, pPred, Object.assign({ Origin: { Kind: 'Clause', Hash: null, FilterKey: null, ClauseType: null, Index: 0 }, NamesDeleted: false }, pExtra || {}));
};

/**
 * The conjunct the ClauseCompiler builds for a bucket clause (internal-contracts §4.4), used to
 * prove bucket clauses round-trip into Selected.
 *
 * @param {string} pId
 * @param {Record<string, any>} pClause
 * @return {Record<string, any>}
 */
const compileClause = (pId, pClause) =>
{
	let tmpPred = null;
	if (pClause.Type === 'DistinctSelectedValueList')
	{
		tmpPred = { Field: pClause.FilterByColumn, Op: 'IN', Value: pClause.Values.slice() };
	}
	else
	{
		let tmpTerms = [];
		if ((pClause.Values.Start !== null) && (typeof(pClause.Values.Start) !== 'undefined'))
		{
			tmpTerms.push({ Field: pClause.FilterByColumn, Op: pClause.StartExclusive ? 'GT' : 'GE', Value: pClause.Values.Start });
		}
		if ((pClause.Values.End !== null) && (typeof(pClause.Values.End) !== 'undefined'))
		{
			tmpTerms.push({ Field: pClause.FilterByColumn, Op: pClause.EndExclusive ? 'LT' : 'LE', Value: pClause.Values.End });
		}
		tmpPred = (tmpTerms.length === 1) ? tmpTerms[0] : { And: tmpTerms };
	}
	return conjunct(pId, tmpPred, { Origin: { Kind: 'Clause', Hash: null, FilterKey: pClause.FilterKey, ClauseType: pClause.Type, Index: 0 } });
};

suite
(
	'Facet-Contract',
	() =>
	{
		test('every contract module exposes its internal-contracts §15.1 exports',
			() =>
			{
				let tmpExports =
					[
						[ libFacetRequest, [ 'CONTRACT_VERSION', 'FOLDS', 'SELECTABLE_FOLDS', 'INTERVALS', 'ORDERS', 'NUMERIC_MODES', 'EXCLUDE_POLICIES', 'DEFAULT_EXCLUDE', 'FOLD_CLAUSE_TYPE', 'M1_CLAUSE_TYPES',
							'FILTER_INSTRUCTIONS', 'FILTER_STRIPPED_INSTRUCTIONS', 'FILTER_OPERATOR_MAP', 'PRED_OPS', 'IDENTIFIER_PATTERN', 'parseFacetID', 'defaultExcludeFor', 'clauseTypeFor', 'clampPositiveInteger',
							'LIMIT_DEFAULTS', 'LATER_FOLDS', 'RESERVED_KEY_PREFIX', 'checkLimits', 'normalizeFacetSpec', 'normalizeRequest', 'isLegacyPayload', 'legacyToRequest' ] ],
						[ libFacetEnvelope, [ 'CONTRACT_VERSION', 'NUMERIC_KEY_TYPES', 'VOLATILE_FIELDS', 'normalizeKey', 'emptyFacetResult', 'buildFacetResult', 'buildEnvelope', 'requestFailure', 'normalizeForComparison' ] ],
						[ libFacetBuckets, [ 'INTERVAL_ORDER', 'NUMERIC_KEY_TYPES', 'canonicalDateTime', 'dateKey', 'normalizeDateKey', 'compareDateKeys', 'nextDateKey', 'fillDateKeys', 'dateLabel', 'coarserInterval', 'units', 'formatUnits',
							'numericGeometry', 'edgesGeometry', 'numericIndex', 'numericBucketBounds', 'numericLabel', 'rangeKey', 'rangeLabel', 'normalizeKey', 'compareKeys' ] ],
						[ libFacetClauses, [ 'canonicalJSON', 'shortHash', 'clauseSignature', 'clauseHash', 'ownership', 'isMixed', 'exclusionFor', 'bucketClause', 'selectedFrom', 'bucketSelected' ] ],
						[ libFacetErrors, [ 'CODES', 'create', 'isFacetError', 'toResponse', 'toEntry' ] ]
					];
				tmpExports.forEach(
					(pEntry) =>
					{
						pEntry[1].forEach((pName) => { Expect(pEntry[0], pName).to.have.property(pName); });
					});
				Expect(libFacetEnvelope.CONTRACT_VERSION).to.equal(1);
			});

		// ============================================================ Errors
		suite
		(
			'Errors',
			() =>
			{
				test('the M1 code table carries the statuses of internal-contracts §13',
					() =>
					{
						let tmpExpected =
							{
								FACET_UNAUTHENTICATED: 401, FACET_FORBIDDEN: 403, FACET_ADHOC_FORBIDDEN: 403, FACET_UNKNOWN_ENTITY: 404,
								FACET_UNKNOWN_FACET: 400, FACET_UNKNOWN_FIELD: 400, FACET_UNKNOWN_SCOPE: 400, FACET_UNKNOWN_FOLD: 400,
								FACET_FILTER_INVALID: 400, FACET_REQUEST_INVALID: 400, FACET_TOO_MANY_FACETS: 400,
								FACET_INTERVAL_TOO_FINE: 422, FACET_FOLD_UNSUPPORTED: 422, FACET_TOO_LARGE: 422, FACET_TIMEZONE_UNSUPPORTED: 422,
								FACET_SCOPE_POLICY_VIOLATION: 500, FACET_INTERNAL: 500, FACET_MODEL_RELOADING: 503, FACET_TIMEOUT: 504
							};
						Object.keys(tmpExpected).forEach(
							(pCode) =>
							{
								Expect(libFacetErrors.CODES[pCode], pCode).to.be.an('object');
								Expect(libFacetErrors.CODES[pCode].Status, pCode).to.equal(tmpExpected[pCode]);
								Expect(libFacetErrors.CODES[pCode].Message, pCode).to.be.a('string').and.not.equal('');
							});
						Expect(Object.isFrozen(libFacetErrors.CODES)).to.equal(true);
					});

				test('create() builds an Error with Code, Status and Detail; unknown codes become FACET_INTERNAL',
					() =>
					{
						let tmpError = libFacetErrors.create('FACET_TIMEOUT');
						Expect(tmpError).to.be.an.instanceof(Error);
						Expect(tmpError.message).to.equal('Facet exceeded its deadline.');
						Expect(tmpError.Detail).to.equal(undefined);
						let tmpCustom = libFacetErrors.create('FACET_UNKNOWN_FIELD', 'No such field.', { Field: 'Nope' });
						Expect(tmpCustom.message).to.equal('No such field.');
						Expect(tmpCustom.Detail).to.deep.equal({ Field: 'Nope' });
						let tmpUnknown = libFacetErrors.create('NOT_A_CODE', 'x');
						Expect(tmpUnknown.Code).to.equal('FACET_INTERNAL');
						Expect(tmpUnknown.Status).to.equal(500);
						Expect(libFacetErrors.isFacetError(new Error('plain'))).to.equal(false);
						Expect(libFacetErrors.isFacetError(null)).to.equal(false);
						Expect(libFacetErrors.isFacetError({ FacetError: true, Code: 'NOPE' })).to.equal(false);
					});

				test('toResponse() and toEntry() never echo a non-facet error',
					() =>
					{
						let tmpResponse = libFacetErrors.toResponse(new Error('SELECT secret FROM x'));
						Expect(tmpResponse).to.deep.equal({ Status: 500, Body: { Error: { Code: 'FACET_INTERNAL', Status: 500, Message: 'Internal error.' } } });
						Expect(libFacetErrors.toEntry(libFacetErrors.create('FACET_TIMEOUT'))).to.deep.equal({ Code: 'FACET_TIMEOUT', Status: 504, Message: 'Facet exceeded its deadline.' });
						Expect(libFacetErrors.toEntry(libFacetErrors.create('FACET_INTERVAL_TOO_FINE', null, { Suggest: { Interval: 'week' } })).Detail).to.deep.equal({ Suggest: { Interval: 'week' } });
					});
			}
		);

		// ============================================================ Request
		suite
		(
			'Request constants and FacetIDs',
			() =>
			{
				test('fold tables agree with each other',
					() =>
					{
						libFacetRequest.FOLDS.forEach(
							(pFold) =>
							{
								Expect(libFacetRequest.DEFAULT_EXCLUDE, pFold).to.have.property(pFold);
								Expect(libFacetRequest.FOLD_CLAUSE_TYPE, pFold).to.have.property(pFold);
							});
						libFacetRequest.SELECTABLE_FOLDS.forEach(
							(pFold) =>
							{
								Expect(libFacetRequest.clauseTypeFor(pFold), pFold).to.be.a('string');
								Expect(libFacetRequest.defaultExcludeFor(pFold), pFold).to.equal('Self');
							});
						[ 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'Count' ].forEach(
							(pFold) =>
							{
								Expect(libFacetRequest.defaultExcludeFor(pFold), pFold).to.equal('None');
							});
						Expect(libFacetRequest.clauseTypeFor('Stats')).to.equal(null);
						Expect(libFacetRequest.clauseTypeFor('Nope')).to.equal(null);
						Expect(libFacetRequest.defaultExcludeFor('Nope')).to.equal('None');
						Expect(libFacetRequest.FILTER_OPERATOR_MAP.IN).to.equal('NULL');
						Expect(libFacetRequest.FILTER_OPERATOR_MAP.INN).to.equal('IN');
						Expect(libFacetRequest.INTERVALS).to.deep.equal(libFacetBuckets.INTERVAL_ORDER);
					});

				test('parseFacetID handles every M1 form and rejects bad identifiers',
					() =>
					{
						Expect(libFacetRequest.parseFacetID('Book.Language')).to.deep.equal({ Kind: 'Auto', Entity: 'Book', Column: 'Language', Raw: 'Book.Language' });
						Expect(libFacetRequest.parseFacetID('Review.IDBook>Book.Language')).to.deep.equal({ Kind: 'Path', Entity: 'Review', Raw: 'Review.IDBook>Book.Language' });
						Expect(libFacetRequest.parseFacetID('Book.ByAuthor/Top')).to.deep.equal({ Kind: 'Declared', Entity: 'Book', Name: 'ByAuthor/Top', Raw: 'Book.ByAuthor/Top' });
						[ 'Book', '.Language', 'Book.', 'Bo ok.Language', 'Book.Lang uage', 'Book.Lang;DROP', '1Book.Language', 'Book.By/', 'Book.By/1x', null, undefined, {}, 'B.' + 'x'.repeat(300) ].forEach(
							(pBad) =>
							{
								Expect(libFacetRequest.parseFacetID(pBad), String(pBad)).to.equal(null);
							});
						// Identifiers are at most 64 characters (IDENTIFIER_PATTERN).
						Expect(libFacetRequest.parseFacetID('Book.' + 'x'.repeat(65))).to.equal(null);
						Expect(libFacetRequest.parseFacetID('Book.' + 'x'.repeat(64)).Kind).to.equal('Auto');
						Expect(libFacetRequest.parseFacetID('x'.repeat(65) + '.Language')).to.equal(null);
					});

				test('clampPositiveInteger',
					() =>
					{
						Expect(libFacetRequest.clampPositiveInteger(undefined, 20, 500)).to.equal(20);
						Expect(libFacetRequest.clampPositiveInteger(null, 20, 500)).to.equal(20);
						Expect(libFacetRequest.clampPositiveInteger(7, 20, 500)).to.equal(7);
						Expect(libFacetRequest.clampPositiveInteger(9000, 20, 500)).to.equal(500);
						Expect(libFacetRequest.clampPositiveInteger(0, 20, 500)).to.equal(null);
						Expect(libFacetRequest.clampPositiveInteger(2.5, 20, 500)).to.equal(null);
						Expect(libFacetRequest.clampPositiveInteger('5', 20, 500)).to.equal(null);
					});
			}
		);

		suite
		(
			'Request normalization',
			() =>
			{
				const OPTIONS = { Limits: { MaxFacets: 20, MaxTop: 500, MaxBuckets: 500, TimeoutMS: 10000 }, Time: { StorageTimeZone: 'UTC' } };
				const normalize = (pBody, pOptions) => { return libFacetRequest.normalizeRequest('BookStoreSale', pBody, pOptions || OPTIONS); };
				const facet = (pFields) => { return normalize({ Facets: [ Object.assign({ Facet: 'BookStoreSale.PaymentMethod' }, pFields) ] }).Facets[0]; };

				test('a minimal body gets every default (internal-contracts §3)',
					() =>
					{
						Expect(normalize({ Facets: [ { Facet: 'BookStoreSale.PaymentMethod' } ] })).to.deep.equal(
							{
								Entity: 'BookStoreSale',
								Mode: 'Query',
								Clauses: [],
								FilterString: null,
								Scopes: [],
								Params: {},
								Facets:
								[
									{
										Key: 'BookStoreSale.PaymentMethod', FacetIDs: [ 'BookStoreSale.PaymentMethod' ], Fold: null, Interval: null, TimeZone: null,
										Top: null, Order: null, Missing: true, Buckets: null, Mode: null, Edges: null, OpenEnded: false, Ranges: null,
										Exclude: null, CountMode: null, Labels: null, Chart: false, EmptyBuckets: true
									}
								],
								Total: true,
								Records: null,
								Cap: null,
								TimeoutMS: 10000,
								Freshness: { Mode: 'Exact' },
								Warnings: []
							});
					});

				test('every option is carried through',
					() =>
					{
						let tmpRequest = normalize(
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], Hash: 'h1' } ],
								FilterString: 'FBV~PaymentMethod~EQ~Credit%20Card',
								Facets:
								[
									{ Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate', Fold: 'DateHistogram', Interval: 'week', TimeZone: 'UTC', EmptyBuckets: false, Chart: true },
									{ Key: 'Amounts', Facet: 'BookStoreSale.TotalAmount', Fold: 'NumericHistogram', Buckets: 12, Mode: 'Nice', Missing: false, Exclude: 'None' },
									{ Key: 'Years', Facet: 'Book.PublicationYear', Edges: [ 1800, 1900, 2000 ], OpenEnded: true },
									{ Key: 'Bands', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: [ { Key: 'low', To: 3, Label: 'Low' }, { Key: 'high', From: 3 } ], Exclude: [ 'h1', 'c2' ] },
									{ Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ], Fold: 'Pivot', Top: 5, Order: 'KeyAsc', CountMode: 'Rows', Labels: true }
								],
								Total: false,
								TimeoutMS: 2500.7,
								Freshness: { Mode: 'Fast', MaxLagMS: 50 },
								Explain: true
							});
						Expect(tmpRequest.Clauses).to.deep.equal([ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], Hash: 'h1' } ]);
						Expect(tmpRequest.FilterString).to.equal('FBV~PaymentMethod~EQ~Credit%20Card');
						Expect(tmpRequest.Total).to.equal(false);
						Expect(tmpRequest.TimeoutMS).to.equal(2500);
						Expect(tmpRequest.Freshness).to.deep.equal({ Mode: 'Exact' });
						let tmpFacets = tmpRequest.Facets;
						Expect(tmpFacets[0]).to.include({ Key: 'ByMonth', Fold: 'DateHistogram', Interval: 'week', TimeZone: 'UTC', EmptyBuckets: false, Chart: true });
						Expect(tmpFacets[1]).to.include({ Buckets: 12, Mode: 'Nice', Missing: false, Exclude: 'None' });
						Expect(tmpFacets[2]).to.include({ Mode: 'Edges', OpenEnded: true });
						Expect(tmpFacets[2].Edges).to.deep.equal([ 1800, 1900, 2000 ]);
						Expect(tmpFacets[3].Ranges).to.deep.equal([ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'high', From: 3, To: null, Label: null } ]);
						Expect(tmpFacets[3].Exclude).to.deep.equal([ 'h1', 'c2' ]);
						Expect(tmpFacets[4]).to.include({ Key: 'Cross', Fold: 'Pivot', Top: 5, Order: 'KeyAsc', CountMode: 'Rows', Labels: true });
						Expect(tmpFacets[4].FacetIDs).to.deep.equal([ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ]);
					});

				test('clauses are shallow copies; the body is never mutated',
					() =>
					{
						let tmpClause = { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2026-01-01' } };
						let tmpBody = { Clauses: [ tmpClause ], Facets: [ { Facet: 'BookStoreSale.SaleDate', Top: 900 } ] };
						let tmpSnapshot = JSON.stringify(tmpBody);
						let tmpRequest = normalize(tmpBody);
						Expect(tmpRequest.Clauses[0]).to.not.equal(tmpClause);
						Expect(tmpRequest.Clauses[0]).to.deep.equal(tmpClause);
						Expect(JSON.stringify(tmpBody)).to.equal(tmpSnapshot);
					});

				test('Key defaults to the FacetID (pivot: joined with |), must be unique and not reserved',
					() =>
					{
						Expect(facet({}).Key).to.equal('BookStoreSale.PaymentMethod');
						Expect(normalize({ Facets: [ { Facet: [ 'BookStoreSale.A', 'BookStoreSale.B' ], Fold: 'Pivot' } ] }).Facets[0].Key).to.equal('BookStoreSale.A|BookStoreSale.B');
						expectFacetError(() => { normalize({ Facets: [ { Facet: 'BookStoreSale.A' }, { Facet: 'BookStoreSale.A' } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'DuplicateKey', Index: 1 });
						expectFacetError(() => { normalize({ Facets: [ { Key: 'X', Facet: 'BookStoreSale.A' }, { Key: 'X', Facet: 'BookStoreSale.B' } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'DuplicateKey' });
						expectFacetError(() => { facet({ Key: '#Total' }); }, 'FACET_REQUEST_INVALID', { Reason: 'ReservedKey' });
						expectFacetError(() => { facet({ Key: '' }); }, 'FACET_REQUEST_INVALID', { Field: 'Key' });
						expectFacetError(() => { facet({ Key: 7 }); }, 'FACET_REQUEST_INVALID', { Field: 'Key' });
					});

				test('Facets must be a non-empty array within MaxFacets; the body must be an object',
					() =>
					{
						expectFacetError(() => { normalize({}); }, 'FACET_REQUEST_INVALID', { Field: 'Facets', Reason: 'Missing' });
						expectFacetError(() => { normalize({ Facets: [] }); }, 'FACET_REQUEST_INVALID', { Field: 'Facets' });
						expectFacetError(() => { normalize({ Facets: 'BookStoreSale.A' }); }, 'FACET_REQUEST_INVALID', { Field: 'Facets' });
						expectFacetError(() => { normalize({ Facets: [ 'BookStoreSale.A' ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Facets', Index: 0 });
						expectFacetError(() => { normalize(null); }, 'FACET_REQUEST_INVALID', { Reason: 'BodyNotObject' });
						expectFacetError(() => { normalize([ 1 ]); }, 'FACET_REQUEST_INVALID', { Reason: 'BodyNotObject' });
						let tmpTwentyOne = [];
						for (let i = 0; i < 21; i++)
						{
							tmpTwentyOne.push({ Key: `F${i}`, Facet: 'BookStoreSale.A' });
						}
						expectFacetError(() => { normalize({ Facets: tmpTwentyOne }); }, 'FACET_TOO_MANY_FACETS', { Max: 20, Count: 21 });
						expectFacetError(() => { normalize({ Facets: tmpTwentyOne.slice(0, 3) }, { Limits: { MaxFacets: 2 } }); }, 'FACET_TOO_MANY_FACETS', { Max: 2 });
						Expect(normalize({ Facets: tmpTwentyOne.slice(0, 20) }).Facets.length).to.equal(20);
					});

				test('Facet arrays require Fold: Pivot (exactly two) and every FacetID must parse',
					() =>
					{
						expectFacetError(() => { facet({ Facet: [ 'BookStoreSale.A', 'BookStoreSale.B' ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'FacetArrayNeedsPivot' });
						expectFacetError(() => { facet({ Fold: 'Pivot' }); }, 'FACET_REQUEST_INVALID', { Reason: 'PivotNeedsTwoFacets' });
						expectFacetError(() => { facet({ Facet: [ 'BookStoreSale.A' ], Fold: 'Pivot' }); }, 'FACET_REQUEST_INVALID', { Reason: 'PivotDimensions' });
						expectFacetError(() => { facet({ Facet: [ 'BookStoreSale.A', 'BookStoreSale.B', 'BookStoreSale.C' ], Fold: 'Pivot' }); }, 'FACET_REQUEST_INVALID', { Reason: 'PivotDimensions' });
						expectFacetError(() => { facet({ Facet: 'BookStoreSale."A' }); }, 'FACET_REQUEST_INVALID', { Reason: 'InvalidFacetID' });
						expectFacetError(() => { facet({ Facet: [ 'BookStoreSale.A', 7 ], Fold: 'Pivot' }); }, 'FACET_REQUEST_INVALID', { Reason: 'InvalidFacetID' });
						expectFacetError(() => { facet({ Facet: null }); }, 'FACET_REQUEST_INVALID', { Reason: 'Missing' });
						// Syntactically valid but not resolvable in M1: the Planner refuses these per facet.
						Expect(facet({ Facet: 'BookStoreSale.IDBook>Book.Language' }).FacetIDs).to.deep.equal([ 'BookStoreSale.IDBook>Book.Language' ]);
						Expect(facet({ Facet: 'Book.Language' }).FacetIDs).to.deep.equal([ 'Book.Language' ]);
					});

				test('Fold: unknown names are 400, later-milestone folds are 422',
					() =>
					{
						expectFacetError(() => { facet({ Fold: 'Histogram' }); }, 'FACET_UNKNOWN_FOLD', { Fold: 'Histogram', Index: 0 });
						expectFacetError(() => { facet({ Fold: 7 }); }, 'FACET_REQUEST_INVALID', { Field: 'Fold' });
						libFacetRequest.LATER_FOLDS.forEach(
							(pFold) =>
							{
								expectFacetError(() => { facet({ Fold: pFold }); }, 'FACET_FOLD_UNSUPPORTED', { Feature: pFold, Milestone: 2 });
							});
						libFacetRequest.FOLDS.filter((pFold) => { return pFold !== 'Pivot'; }).forEach(
							(pFold) =>
							{
								Expect(facet({ Fold: pFold }).Fold).to.equal(pFold);
							});
					});

				test('Top is clamped to MaxTop with a warning; Buckets to MaxBuckets; bad values are 400',
					() =>
					{
						let tmpRequest = normalize({ Facets: [ { Key: 'A', Facet: 'BookStoreSale.A', Top: 900 }, { Key: 'B', Facet: 'BookStoreSale.B', Buckets: 501, Top: 500 } ] });
						Expect(tmpRequest.Facets[0].Top).to.equal(500);
						Expect(tmpRequest.Facets[1].Top).to.equal(500);
						Expect(tmpRequest.Facets[1].Buckets).to.equal(500);
						Expect(tmpRequest.Warnings).to.deep.equal(
							[
								{ Code: 'FACET_TOP_CLAMPED', Detail: { Key: 'A', Requested: 900, Applied: 500 } },
								{ Code: 'FACET_BUCKETS_CLAMPED', Detail: { Key: 'B', Requested: 501, Applied: 500 } }
							]);
						Expect(normalize({ Facets: [ { Facet: 'BookStoreSale.A', Top: 60 } ] }, { Limits: { MaxTop: 50 } }).Facets[0].Top).to.equal(50);
						[ 0, -1, 2.5, '20', true ].forEach(
							(pBad) =>
							{
								expectFacetError(() => { facet({ Top: pBad }); }, 'FACET_REQUEST_INVALID', { Field: 'Top' });
								expectFacetError(() => { facet({ Buckets: pBad }); }, 'FACET_REQUEST_INVALID', { Field: 'Buckets' });
							});
					});

				test('Interval, Order and booleans are validated',
					() =>
					{
						expectFacetError(() => { facet({ Interval: 'hour' }); }, 'FACET_REQUEST_INVALID', { Field: 'Interval' });
						expectFacetError(() => { facet({ Interval: 'Month' }); }, 'FACET_REQUEST_INVALID', { Field: 'Interval' });
						expectFacetError(() => { facet({ Order: 'CountAsc' }); }, 'FACET_REQUEST_INVALID', { Field: 'Order' });
						[ 'Missing', 'Chart', 'EmptyBuckets', 'OpenEnded', 'Labels' ].forEach(
							(pField) =>
							{
								let tmpSpec = {};
								tmpSpec[pField] = 'yes';
								expectFacetError(() => { facet(tmpSpec); }, 'FACET_REQUEST_INVALID', { Field: pField });
							});
						expectFacetError(() => { normalize({ Facets: [ { Facet: 'BookStoreSale.A' } ], Total: 'yes' }); }, 'FACET_REQUEST_INVALID', { Field: 'Total' });
					});

				test('TimeZone must equal Time.StorageTimeZone (D-22)',
					() =>
					{
						Expect(facet({ TimeZone: 'UTC' }).TimeZone).to.equal('UTC');
						expectFacetError(() => { facet({ TimeZone: 'America/Chicago' }); }, 'FACET_TIMEZONE_UNSUPPORTED', { StorageTimeZone: 'UTC' });
						expectFacetError(() => { facet({ TimeZone: 5 }); }, 'FACET_REQUEST_INVALID', { Field: 'TimeZone' });
						Expect(normalize({ Facets: [ { Facet: 'BookStoreSale.A', TimeZone: 'America/Chicago' } ] }, { Time: { StorageTimeZone: 'America/Chicago' } }).Facets[0].TimeZone).to.equal('America/Chicago');
					});

				test('Mode / Edges: Log is 422, Edges imply Edges mode and must ascend',
					() =>
					{
						expectFacetError(() => { facet({ Mode: 'Log' }); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'LogMode' });
						expectFacetError(() => { facet({ Mode: 'Linear' }); }, 'FACET_REQUEST_INVALID', { Field: 'Mode' });
						expectFacetError(() => { facet({ Mode: 'Edges' }); }, 'FACET_REQUEST_INVALID', { Reason: 'EdgesRequired' });
						expectFacetError(() => { facet({ Mode: 'Nice', Edges: [ 0, 1 ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'EdgesWithNice' });
						expectFacetError(() => { facet({ Edges: [ 0 ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges' });
						expectFacetError(() => { facet({ Edges: [ 0, 0 ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges', EdgeIndex: 1 });
						expectFacetError(() => { facet({ Edges: [ 0, 5, 3 ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges', EdgeIndex: 2 });
						expectFacetError(() => { facet({ Edges: [ 0, Infinity ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges' });
						expectFacetError(() => { facet({ Edges: [ 0, '5' ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges' });
						expectFacetError(() => { normalize({ Facets: [ { Facet: 'BookStoreSale.A', Edges: [ 0, 1, 2, 3 ] } ] }, { Limits: { MaxBuckets: 2 } }); }, 'FACET_REQUEST_INVALID', { Field: 'Edges' });
						Expect(facet({ Mode: 'Edges', Edges: [ -1.5, 0, 2.25 ] })).to.include({ Mode: 'Edges' });
					});

				test('Ranges: unique keys, finite bounds, From < To',
					() =>
					{
						expectFacetError(() => { facet({ Ranges: [] }); }, 'FACET_REQUEST_INVALID', { Field: 'Ranges' });
						expectFacetError(() => { facet({ Ranges: [ { Key: 'a', To: 3 }, { Key: 'a', From: 3 } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'Key', RangeIndex: 1 });
						expectFacetError(() => { facet({ Ranges: [ { From: 1 } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'Key' });
						expectFacetError(() => { facet({ Ranges: [ { Key: 'a', From: 3, To: 3 } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'Order' });
						expectFacetError(() => { facet({ Ranges: [ { Key: 'a', From: '1' } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'Bound' });
						expectFacetError(() => { facet({ Ranges: [ { Key: 'a', Label: 4 } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'Label' });
						expectFacetError(() => { facet({ Ranges: [ 'a' ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'NotObject' });
						Expect(facet({ Ranges: [ { Key: 'all' } ] }).Ranges).to.deep.equal([ { Key: 'all', From: null, To: null, Label: null } ]);
					});

				test('Exclude: Self / None / arrays; Group: is 422; CountMode only Rows',
					() =>
					{
						Expect(facet({ Exclude: 'Self' }).Exclude).to.equal('Self');
						Expect(facet({ Exclude: 'None' }).Exclude).to.equal('None');
						expectFacetError(() => { facet({ Exclude: 'Group:Status' }); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'ExcludeGroup' });
						expectFacetError(() => { facet({ Exclude: 'All' }); }, 'FACET_REQUEST_INVALID', { Field: 'Exclude' });
						expectFacetError(() => { facet({ Exclude: [ '' ] }); }, 'FACET_REQUEST_INVALID', { Field: 'Exclude' });
						expectFacetError(() => { facet({ Exclude: 5 }); }, 'FACET_REQUEST_INVALID', { Field: 'Exclude' });
						expectFacetError(() => { facet({ CountMode: 'PivotDistinct' }); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'CountMode' });
						Expect(facet({ CountMode: 'Rows' }).CountMode).to.equal('Rows');
					});

				test('features of later milestones are refused, never ignored',
					() =>
					{
						const base = (pExtra) => { return Object.assign({ Facets: [ { Facet: 'BookStoreSale.A' } ] }, pExtra); };
						expectFacetError(() => { normalize(base({ Scopes: 'x' })); }, 'FACET_REQUEST_INVALID', { Field: 'Scopes' });
						expectFacetError(() => { normalize(base({ Selections: [ { Facet: 'BookStoreSale.A', Keys: [ 1 ] } ] })); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'Selections', Milestone: 2 });
						expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'FacetSelection', Facet: 'BookStoreSale.A', Keys: [ 1 ] } ] })); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'Selections', Milestone: 2 });
						expectFacetError(() => { normalize(base({ FilterExperience: 'H4sI' })); }, 'FACET_FOLD_UNSUPPORTED', { Feature: 'FilterExperience' });
						expectFacetError(() => { normalize(base({ Params: [] })); }, 'FACET_REQUEST_INVALID', { Field: 'Params' });
						expectFacetError(() => { facet({ Definition: { Path: [] } }); }, 'FACET_ADHOC_FORBIDDEN', { Index: 0 });
						// Empty / null forms are fine.
						Expect(normalize(base({ Scopes: [], Selections: [], FilterExperience: null, Records: false, Params: {} })).Facets.length).to.equal(1);
					});

				test('M2 filter inputs: Scopes, Params and NamedScope clauses are shape-checked and carried (internal-contracts §28.2)',
					() =>
					{
						const base = (pExtra) => { return Object.assign({ Facets: [ { Facet: 'BookStoreSale.A' } ] }, pExtra); };
						let tmpRequest = normalize(base(
							{
								Scopes: [ { Scope: 'BookStoreSale.Mine', Params: { Roles: [ 'Owner' ] } }, { Scope: 'BookStoreSale.Open' } ],
								Params: { Window: 30 },
								Clauses: [ { Type: 'NamedScope', Scope: 'BookStoreSale.Mine', Params: { Roles: [ 'Lead' ] } } ]
							}));
						Expect(tmpRequest.Scopes).to.deep.equal([ { Scope: 'BookStoreSale.Mine', Params: { Roles: [ 'Owner' ] } }, { Scope: 'BookStoreSale.Open', Params: {} } ]);
						Expect(tmpRequest.Params).to.deep.equal({ Window: 30 });
						Expect(tmpRequest.Clauses).to.deep.equal([ { Type: 'NamedScope', Scope: 'BookStoreSale.Mine', Params: { Roles: [ 'Lead' ] } } ]);
						expectFacetError(() => { normalize(base({ Scopes: [ 'BookStoreSale.Mine' ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Scopes', Index: 0 });
						expectFacetError(() => { normalize(base({ Scopes: [ { Scope: '' } ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Scopes', Index: 0 });
						expectFacetError(() => { normalize(base({ Scopes: [ { Scope: 'BookStoreSale.Mine', Params: [] } ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Scopes', Index: 0 });
						expectFacetError(() => { normalize(base({ Params: JSON.parse('{ "__proto__": { "x": 1 } }') })); }, 'FACET_REQUEST_INVALID', { Field: 'Params', Reason: 'ReservedKey' });
						expectFacetError(() => { normalize(base({ Scopes: [ { Scope: 'BookStoreSale.Mine', Params: JSON.parse('{ "constructor": 1 }') } ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Scopes', Reason: 'ReservedKey' });
					});

				test('Records on a Query body, and the Records / Count / Keys modes (internal-contracts §28.2)',
					() =>
					{
						const base = (pExtra) => { return Object.assign({ Facets: [ { Facet: 'BookStoreSale.A' } ] }, pExtra); };
						const mode = (pMode, pBody) => { return libFacetRequest.normalizeRequest('BookStoreSale', pBody, Object.assign({}, OPTIONS, { Mode: pMode })); };
						Expect(normalize(base({ Records: { Begin: 10, Cap: 50, Sort: [ { Field: 'SaleDate', Dir: 'desc' }, { Field: 'IDBookStoreSale' } ] } })).Records)
							.to.deep.equal({ Begin: 10, Cap: 50, Sort: [ { Field: 'SaleDate', Dir: 'DESC' }, { Field: 'IDBookStoreSale', Dir: 'ASC' } ] });
						Expect(normalize(base({ Records: {} })).Records).to.deep.equal({ Begin: 0, Cap: 250, Sort: [] });
						expectFacetError(() => { normalize(base({ Records: { Cap: 501 } })); }, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 500 });
						expectFacetError(() => { normalize(base({ Records: { Cap: 0 } })); }, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 500 });
						expectFacetError(() => { normalize(base({ Records: { Begin: 10001 } })); }, 'FACET_REQUEST_INVALID', { Field: 'Begin', Max: 10000 });
						expectFacetError(() => { normalize(base({ Records: { Begin: 1.5 } })); }, 'FACET_REQUEST_INVALID', { Field: 'Begin' });
						expectFacetError(() => { normalize(base({ Records: { Sort: [ { Field: 'a' }, { Field: 'b' }, { Field: 'c' }, { Field: 'd' }, { Field: 'e' } ] } })); }, 'FACET_REQUEST_INVALID', { Field: 'Sort', Max: 4 });
						expectFacetError(() => { normalize(base({ Records: { Sort: [ { Field: 'a b' } ] } })); }, 'FACET_REQUEST_INVALID', { Field: 'Sort', Index: 0 });
						expectFacetError(() => { normalize(base({ Records: { Sort: [ { Field: 'a', Dir: 'UP' } ] } })); }, 'FACET_REQUEST_INVALID', { Field: 'Sort', Reason: 'Dir' });
						expectFacetError(() => { normalize(base({ Records: [] })); }, 'FACET_REQUEST_INVALID', { Field: 'Records' });
						// Records mode: Facets optional and ignored, the page defaulted; the recordset's Experience is ignored.
						let tmpRecords = mode('Records', { Clauses: [], Experience: { ResultDestinationAddress: 'AppData.X' }, Facets: 'ignored' });
						Expect(tmpRecords).to.include({ Mode: 'Records', Total: false, Cap: null });
						Expect(tmpRecords.Facets).to.deep.equal([]);
						Expect(tmpRecords.Records).to.deep.equal({ Begin: 0, Cap: 250, Sort: [] });
						// Count mode: Records ignored; Keys mode: a top-level Cap (default MaxKeys).
						Expect(mode('Count', { Records: { Cap: 9999 } }).Records).to.equal(null);
						Expect(mode('Keys', {}).Cap).to.equal(50000);
						Expect(mode('Keys', { Cap: 7 }).Cap).to.equal(7);
						expectFacetError(() => { mode('Keys', { Cap: 50001 }); }, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 50000 });
						// The limits come from the options.
						expectFacetError(() => { libFacetRequest.normalizeRequest('BookStoreSale', { Records: { Cap: 11 } }, { Mode: 'Records', Limits: { MaxRecordsPage: 10 } }); }, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 10 });
					});

				test('Clauses and FilterString are shape-checked',
					() =>
					{
						const base = (pExtra) => { return Object.assign({ Facets: [ { Facet: 'BookStoreSale.A' } ] }, pExtra); };
						expectFacetError(() => { normalize(base({ Clauses: {} })); }, 'FACET_REQUEST_INVALID', { Field: 'Clauses' });
						expectFacetError(() => { normalize(base({ Clauses: [ { Values: [ 1 ] } ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Clauses', Index: 0 });
						expectFacetError(() => { normalize(base({ Clauses: [ 'FBV~A~EQ~1' ] })); }, 'FACET_REQUEST_INVALID', { Field: 'Clauses', Index: 0 });
						expectFacetError(() => { normalize(base({ FilterString: 5 })); }, 'FACET_REQUEST_INVALID', { Field: 'FilterString' });
						Expect(normalize(base({ FilterString: '' })).FilterString).to.equal(null);
						Expect(normalize(base({ FilterString: 'FBV~A~LK~%25x%25' })).FilterString).to.equal('FBV~A~LK~%25x%25');
						expectFacetError(() => { normalize(base({ TimeoutMS: 0 })); }, 'FACET_REQUEST_INVALID', { Field: 'TimeoutMS' });
						expectFacetError(() => { normalize(base({ TimeoutMS: '100' })); }, 'FACET_REQUEST_INVALID', { Field: 'TimeoutMS' });
						Expect(normalize(base({ TimeoutMS: 999999 })).TimeoutMS).to.equal(10000);
						expectFacetError(() => { normalize(base({ Freshness: 'Fast' })); }, 'FACET_REQUEST_INVALID', { Field: 'Freshness' });
					});

				test('L1 limits: depth, string bytes, array length, clause count, body size',
					() =>
					{
						const base = (pExtra) => { return Object.assign({ Facets: [ { Facet: 'BookStoreSale.A' } ] }, pExtra); };
						// Depth: body(1) > Clauses(2) > clause(3) > Values(4) > … ; 8 is fine, 9 is not.
						let fNest = (pDepth) =>
						{
							let tmpValue = 'x';
							for (let i = 0; i < pDepth; i++)
							{
								tmpValue = [ tmpValue ];
							}
							return tmpValue;
						};
						Expect(normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: fNest(5) } ] })).Clauses.length).to.equal(1);
						expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: fNest(6) } ] })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxJSONDepth', Max: 8 });
						// String bytes are UTF-8 bytes: 512 two-byte characters = 1024 bytes is fine, one more is not.
						Expect(normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: [ 'é'.repeat(512) ] } ] })).Clauses.length).to.equal(1);
						let tmpError = expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: [ 'a' + 'é'.repeat(512) ] } ] })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxValueBytes', Max: 1024 });
						Expect(tmpError.Detail.Path).to.equal('Clauses[0].Values[0]');
						expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'X', ['k'.repeat(1025)]: 1 } ] })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxValueBytes' });
						// Filter strings are exempt from the per-string limit (the validator limits their values).
						Expect(normalize(base({ FilterString: 'FBV~A~EQ~1~'.repeat(400) })).FilterString.length).to.equal(4400);
						Expect(normalize(base({ Clauses: [ { Type: 'RawFilter', Filter: 'FBV~A~EQ~1~'.repeat(400) }, { Type: 'RawFilter', Value: 'FBV~A~EQ~2~'.repeat(400) } ] })).Clauses.length).to.equal(2);
						expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'Match', Value: 'v'.repeat(1025) } ] })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxValueBytes' });
						// Arrays and clause counts.
						let tmpThousandAndOne = [];
						for (let i = 0; i < 1001; i++)
						{
							tmpThousandAndOne.push(i);
						}
						Expect(normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: tmpThousandAndOne.slice(0, 1000) } ] })).Clauses.length).to.equal(1);
						expectFacetError(() => { normalize(base({ Clauses: [ { Type: 'DistinctSelectedValueList', Values: tmpThousandAndOne } ] })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxInList', Max: 1000 });
						let tmpClauses = [];
						for (let i = 0; i < 101; i++)
						{
							tmpClauses.push({ Type: 'DistinctSelectedValueList', FilterByColumn: 'A', Values: [ i ] });
						}
						Expect(normalize(base({ Clauses: tmpClauses.slice(0, 100) })).Clauses.length).to.equal(100);
						expectFacetError(() => { normalize(base({ Clauses: tmpClauses })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxClauses', Max: 100 });
						// Body size (approximate JSON bytes).
						expectFacetError(() => { normalize(base({ FilterString: 'x'.repeat(300000) })); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxBodyBytes', Max: 262144 });
						expectFacetError(() => { normalize(base({ FilterString: 'x'.repeat(2000) }), { Limits: { MaxBodyBytes: 1000 } }); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxBodyBytes', Max: 1000 });
						// checkLimits is exported on its own.
						libFacetRequest.checkLimits({ A: [ 1, 2, 3 ] }, { MaxInList: 3 });
						expectFacetError(() => { libFacetRequest.checkLimits({ A: [ 1, 2, 3, 4 ] }, { MaxInList: 3 }); }, 'FACET_REQUEST_INVALID', { Limit: 'MaxInList', Path: 'A' });
					});

				test('the legacy RecordSetSearchFacetPayload is refused by default and converted with AcceptLegacy',
					() =>
					{
						let tmpLegacy = { ReturnRecords: false, Fields: [ 'PaymentMethod' ], Ranges: [ { Field: 'TotalAmount', Start: 0, End: 100, Gap: 25 }, { Field: 'SaleDate', Gap: '+1MONTH' }, { Field: 'Odd', Start: 0, End: 1, Gap: 0.3 } ] };
						Expect(libFacetRequest.isLegacyPayload(tmpLegacy)).to.equal(true);
						Expect(libFacetRequest.isLegacyPayload({ FilterString: 'FBV~A~EQ~1', Facets: { Fields: [ 'A' ] } })).to.equal(true);
						Expect(libFacetRequest.isLegacyPayload({ Facets: [ { Facet: 'A.B' } ] })).to.equal(false);
						Expect(libFacetRequest.isLegacyPayload({ Fields: [ 'A' ], Facets: [] })).to.equal(false);
						Expect(libFacetRequest.isLegacyPayload('x')).to.equal(false);
						expectFacetError(() => { normalize(tmpLegacy); }, 'FACET_REQUEST_INVALID', { Reason: 'LegacyPayload' });

						let tmpRequest = normalize(tmpLegacy, Object.assign({ AcceptLegacy: true }, OPTIONS));
						Expect(tmpRequest.Facets.map((pFacet) => { return [ pFacet.Key, pFacet.FacetIDs[0], pFacet.Fold, pFacet.Interval, pFacet.Mode ]; })).to.deep.equal(
							[
								[ 'PaymentMethod', 'BookStoreSale.PaymentMethod', 'Terms', null, null ],
								[ 'Range:TotalAmount', 'BookStoreSale.TotalAmount', 'NumericHistogram', null, 'Edges' ],
								[ 'Range:SaleDate', 'BookStoreSale.SaleDate', 'DateHistogram', 'month', null ],
								[ 'Range:Odd', 'BookStoreSale.Odd', 'NumericHistogram', null, 'Edges' ]
							]);
						Expect(tmpRequest.Facets[1].Edges).to.deep.equal([ 0, 25, 50, 75, 100 ]);
						Expect(tmpRequest.Facets[3].Edges).to.deep.equal([ 0, 0.3, 0.6, 0.9, 1 ]);
						Expect(tmpRequest.Warnings[0].Code).to.equal('FACET_LEGACY_PAYLOAD');

						let tmpNested = libFacetRequest.legacyToRequest('Book', { FilterString: 'FBV~Language~EQ~en', Clauses: [ { Type: 'X' } ], Facets: { Fields: [ 'Genre' ] } });
						Expect(tmpNested).to.deep.equal({ Facets: [ { Key: 'Genre', Facet: 'Book.Genre', Fold: 'Terms' } ], Total: true, Clauses: [ { Type: 'X' } ], FilterString: 'FBV~Language~EQ~en' });
						expectFacetError(() => { libFacetRequest.legacyToRequest('Book', { Fields: [ 'a b' ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'LegacyField' });
						expectFacetError(() => { libFacetRequest.legacyToRequest('Book', { Ranges: [ { Field: 'Year', Start: 10, End: 5, Gap: 1 } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'LegacyRange' });
						expectFacetError(() => { libFacetRequest.legacyToRequest('Book', { Ranges: [ { Field: 'Year', Start: 0, End: 5, Gap: 'fortnight' } ] }); }, 'FACET_REQUEST_INVALID', { Reason: 'LegacyRange' });
					});

				test('normalizeFacetSpec works on its own (client-side validation)',
					() =>
					{
						let tmpWarnings = [];
						let tmpSpec = libFacetRequest.normalizeFacetSpec({ Facet: 'Book.Language', Top: 9999 }, 3, {}, tmpWarnings);
						Expect(tmpSpec.Top).to.equal(500);
						Expect(tmpWarnings).to.have.length(1);
						expectFacetError(() => { libFacetRequest.normalizeFacetSpec({ Facet: 'Book.Language', Interval: 'eon' }, 3); }, 'FACET_REQUEST_INVALID', { Index: 3, Field: 'Interval' });
					});
			}
		);

		// ============================================================ Buckets: dates
		suite
		(
			'Buckets: dates',
			() =>
			{
				test('canonicalDateTime accepts the documented forms only',
					() =>
					{
						let tmpGood =
							{
								'2026-03-02': '2026-03-02 00:00:00',
								'2026-03-02 10:05': '2026-03-02 10:05:00',
								'2026-03-02 10:05:09': '2026-03-02 10:05:09',
								'2026-03-02T10:05:09': '2026-03-02 10:05:09',
								'2026-03-02T10:05:09.999': '2026-03-02 10:05:09',
								'2026-03-02T10:05:09.1234567Z': '2026-03-02 10:05:09',
								'2026-03-02T10:05:09Z': '2026-03-02 10:05:09',
								'2026-03-02T10:05:09+00:00': '2026-03-02 10:05:09',
								'2026-03-02 10:05:09-00:00': '2026-03-02 10:05:09',
								'2024-02-29 23:59:59': '2024-02-29 23:59:59',
								'2000-02-29': '2000-02-29 00:00:00',
								'0001-01-01': '0001-01-01 00:00:00',
								'9999-12-31 23:59:59': '9999-12-31 23:59:59'
							};
						Object.keys(tmpGood).forEach((pInput) => { Expect(libFacetBuckets.canonicalDateTime(pInput), pInput).to.equal(tmpGood[pInput]); });
						[
							'', null, undefined, 20260302, true, {}, [ '2026-03-02' ], '2026-3-2', '2026-03-02 1:05', '2026-03-02 10', '2026-03-02T', '2026-03-02Z',
							'2026-13-01', '2026-00-10', '2026-02-29', '1900-02-29', '2026-04-31', '2026-03-00', '2026-03-02 24:00:00', '2026-03-02 10:60:00',
							'2026-03-02 10:05:60', '2026-03-02T10:05:09+05:00', '2026-03-02 10:05:09.', ' 2026-03-02', '2026-03-02 10:05:09 ', 'now', 'not a date'
						].forEach((pInput) => { Expect(libFacetBuckets.canonicalDateTime(pInput), String(pInput)).to.equal(null); });
						Expect(libFacetBuckets.canonicalDateTime(new Date(Date.UTC(2026, 2, 2, 10, 5, 9)))).to.equal('2026-03-02 10:05:09');
						Expect(libFacetBuckets.canonicalDateTime(new Date(NaN))).to.equal(null);
					});

				test('dateKey for every interval (ISO Monday weeks, quarters, years)',
					() =>
					{
						let tmpCases =
							[
								[ '2026-03-04 15:16:17', 'day', '2026-03-04 00:00:00' ],
								[ '2026-03-04 15:16:17', 'week', '2026-03-02 00:00:00' ],
								[ '2026-03-02 00:00:00', 'week', '2026-03-02 00:00:00' ],
								[ '2026-03-08 23:59:59', 'week', '2026-03-02 00:00:00' ],
								[ '2026-01-01', 'week', '2025-12-29 00:00:00' ],
								[ '2021-01-03', 'week', '2020-12-28 00:00:00' ],
								[ '2024-03-01', 'week', '2024-02-26 00:00:00' ],
								[ '1970-01-01', 'week', '1969-12-29 00:00:00' ],
								[ '2026-03-04', 'month', '2026-03-01 00:00:00' ],
								[ '2026-01-31', 'quarter', '2026-01-01 00:00:00' ],
								[ '2026-05-15', 'quarter', '2026-04-01 00:00:00' ],
								[ '2026-09-30 23:59:59', 'quarter', '2026-07-01 00:00:00' ],
								[ '2026-12-31', 'quarter', '2026-10-01 00:00:00' ],
								[ '2026-12-31 23:59:59', 'year', '2026-01-01 00:00:00' ]
							];
						tmpCases.forEach((pCase) => { Expect(libFacetBuckets.dateKey(pCase[0], pCase[1]), pCase.join(' ')).to.equal(pCase[2]); });
						Expect(libFacetBuckets.dateKey('', 'month')).to.equal(null);
						Expect(libFacetBuckets.dateKey(null, 'month')).to.equal(null);
						Expect(libFacetBuckets.dateKey('2026-02-30', 'month')).to.equal(null);
						expectFacetError(() => { libFacetBuckets.dateKey('2026-01-01', 'hour'); }, 'FACET_INTERNAL');
					});

				test('nextDateKey rolls days, weeks, months, quarters and years',
					() =>
					{
						Expect(libFacetBuckets.nextDateKey('2024-02-28 00:00:00', 'day')).to.equal('2024-02-29 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2026-12-31', 'day')).to.equal('2027-01-01 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2025-12-29 00:00:00', 'week')).to.equal('2026-01-05 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2026-12-01 00:00:00', 'month')).to.equal('2027-01-01 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2026-10-01 00:00:00', 'quarter')).to.equal('2027-01-01 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2026-04-01 00:00:00', 'quarter')).to.equal('2026-07-01 00:00:00');
						Expect(libFacetBuckets.nextDateKey('2026-01-01 00:00:00', 'year')).to.equal('2027-01-01 00:00:00');
						// Any date inside the bucket works (it is keyed first).
						Expect(libFacetBuckets.nextDateKey('2026-03-17 08:00:00', 'month')).to.equal('2026-04-01 00:00:00');
						Expect(libFacetBuckets.nextDateKey('garbage', 'month')).to.equal(null);
						// Out-of-range bucket boundaries format like SQLite strftime('%Y') (C '%04d') and stay usable as keys.
						Expect(libFacetBuckets.dateKey('0000-01-01', 'week')).to.equal('-001-12-27 00:00:00');
						Expect(libFacetBuckets.canonicalDateTime('-001-12-27 00:00:00')).to.equal(null);
						Expect(libFacetBuckets.nextDateKey('-001-12-27 00:00:00', 'week')).to.equal('0000-01-03 00:00:00');
						Expect(libFacetBuckets.nextDateKey('9999-12-01 00:00:00', 'month')).to.equal('10000-01-01 00:00:00');
						Expect(libFacetBuckets.dateLabel('-001-12-27 00:00:00', 'week')).to.equal('Week of -001-12-27');
						Expect(libFacetBuckets.fillDateKeys('0000-01-01', '0000-01-10', 'week', 10)).to.deep.equal([ '-001-12-27 00:00:00', '0000-01-03 00:00:00', '0000-01-10 00:00:00' ]);
						Expect(libFacetBuckets.fillDateKeys('9999-11-15', '9999-12-31', 'month', 10)).to.deep.equal([ '9999-11-01 00:00:00', '9999-12-01 00:00:00' ]);
						Expect(libFacetBuckets.normalizeDateKey('-001-12-29 00:00:00', 'week')).to.equal('-001-12-27 00:00:00');
						Expect(libFacetBuckets.normalizeDateKey('2026-03-04 10:00:00', 'month')).to.equal('2026-03-01 00:00:00');
						Expect(libFacetBuckets.normalizeDateKey('', 'month')).to.equal(null);
						Expect([ '10000-01-01 00:00:00', '9999-12-01 00:00:00', 'x', '-001-12-27 00:00:00', '2026-01-01' ].sort(libFacetBuckets.compareDateKeys)).to.deep.equal(
							[ '-001-12-27 00:00:00', '2026-01-01', '9999-12-01 00:00:00', '10000-01-01 00:00:00', 'x' ]);
					});

				test('fillDateKeys is inclusive, ordered, and refuses too many buckets with Suggest',
					() =>
					{
						Expect(libFacetBuckets.fillDateKeys('2025-11-30 23:00:00', '2026-02-01', 'month', 400)).to.deep.equal(
							[ '2025-11-01 00:00:00', '2025-12-01 00:00:00', '2026-01-01 00:00:00', '2026-02-01 00:00:00' ]);
						Expect(libFacetBuckets.fillDateKeys('2026-03-04', '2026-03-04 23:00:00', 'day', 400)).to.deep.equal([ '2026-03-04 00:00:00' ]);
						Expect(libFacetBuckets.fillDateKeys('2026-03-05', '2026-03-04', 'day', 400)).to.deep.equal([]);
						Expect(libFacetBuckets.fillDateKeys(null, '2026-03-04', 'day', 400)).to.deep.equal([]);
						Expect(libFacetBuckets.fillDateKeys('2024-01-01', '2024-12-31', 'day')).to.have.length(366);
						Expect(libFacetBuckets.fillDateKeys('2025-01-01', '2025-12-31', 'week', 400)).to.have.length(53);
						Expect(libFacetBuckets.fillDateKeys('2024-01-01', '2025-12-31', 'quarter', 400)).to.have.length(8);
						Expect(libFacetBuckets.fillDateKeys('1600-06-01', '2026-06-01', 'year', 427)).to.have.length(427);
						Expect(libFacetBuckets.fillDateKeys('2026-01-01', '2026-01-10', 'day', 10)).to.have.length(10);
						expectFacetError(() => { libFacetBuckets.fillDateKeys('2026-01-01', '2026-01-11', 'day', 10); }, 'FACET_INTERVAL_TOO_FINE',
							{ Interval: 'day', MaxDateBuckets: 10 });
						let tmpError = caught(() => { libFacetBuckets.fillDateKeys('2020-01-01', '2026-01-01', 'day', 400); });
						Expect(tmpError.Detail.Suggest).to.deep.equal({ Interval: 'week' });
						Expect(caught(() => { libFacetBuckets.fillDateKeys('1000-01-01', '2026-01-01', 'year', 400); }).Detail.Suggest).to.deep.equal({ Interval: null });
					});

				test('every filled key is followed by nextDateKey (contiguous half-open buckets)',
					() =>
					{
						libFacetBuckets.INTERVAL_ORDER.forEach(
							(pInterval) =>
							{
								let tmpKeys = libFacetBuckets.fillDateKeys('1999-12-15', '2003-02-11', pInterval, 2000);
								for (let i = 0; i < tmpKeys.length - 1; i++)
								{
									Expect(libFacetBuckets.nextDateKey(tmpKeys[i], pInterval), pInterval).to.equal(tmpKeys[i + 1]);
									Expect(tmpKeys[i] < tmpKeys[i + 1]).to.equal(true);
									Expect(libFacetBuckets.dateKey(tmpKeys[i], pInterval)).to.equal(tmpKeys[i]);
								}
							});
					});

				test('dateLabel and coarserInterval',
					() =>
					{
						Expect(libFacetBuckets.dateLabel('2026-03-02 00:00:00', 'day')).to.equal('2026-03-02');
						Expect(libFacetBuckets.dateLabel('2026-03-02 00:00:00', 'week')).to.equal('Week of 2026-03-02');
						Expect(libFacetBuckets.dateLabel('2026-03-01 00:00:00', 'month')).to.equal('Mar 2026');
						Expect(libFacetBuckets.dateLabel('2026-12-01 00:00:00', 'month')).to.equal('Dec 2026');
						Expect(libFacetBuckets.dateLabel('2026-01-01 00:00:00', 'quarter')).to.equal('Q1 2026');
						Expect(libFacetBuckets.dateLabel('2026-10-01 00:00:00', 'quarter')).to.equal('Q4 2026');
						Expect(libFacetBuckets.dateLabel('2026-01-01 00:00:00', 'year')).to.equal('2026');
						Expect(libFacetBuckets.dateLabel('nope', 'year')).to.equal('nope');
						Expect([ 'day', 'week', 'month', 'quarter', 'year', 'hour' ].map(libFacetBuckets.coarserInterval)).to.deep.equal([ 'week', 'month', 'quarter', 'year', null, null ]);
					});

				(libNodeSQLite ? test : test.skip)('dateKey equals the SQLite shell expressions (03 §3.4) on canonical values',
					() =>
					{
						let tmpDB = new libNodeSQLite.DatabaseSync(':memory:');
						let tmpStatement = tmpDB.prepare(
							`SELECT strftime('%Y-%m-%d 00:00:00', :v) AS day,
								strftime('%Y-%m-%d 00:00:00', :v, '-6 days', 'weekday 1') AS week,
								strftime('%Y-%m-01 00:00:00', :v) AS month,
								printf('%s-%02d-01 00:00:00', strftime('%Y', :v), ((CAST(strftime('%m', :v) AS integer) - 1) / 3) * 3 + 1) AS quarter,
								strftime('%Y-01-01 00:00:00', :v) AS year,
								strftime('%Y-%m-%d %H:%M:%S', :v) AS canonical`);
						let fRandom = prng(20261008);
						let tmpStart = Date.UTC(1995, 0, 1);
						let tmpSpan = Date.UTC(2035, 0, 1) - tmpStart;
						let tmpValues = [ '2024-02-29 12:00:00', '2025-12-29', '2026-01-04 23:59:59', '2000-01-01', '1999-12-31 23:59:59', '2026-03-02T10:00:00', '2026-03-02 10:00', '0000-01-01', '0001-01-01', '9999-12-31 23:59:59' ];
						for (let i = 0; i < 3000; i++)
						{
							let tmpDate = new Date(tmpStart + Math.floor(fRandom() * tmpSpan));
							tmpValues.push(tmpDate.toISOString().slice(0, 19).replace('T', ' '));
						}
						tmpValues.forEach(
							(pValue) =>
							{
								let tmpRow = tmpStatement.get({ v: pValue });
								Expect(libFacetBuckets.canonicalDateTime(pValue), pValue).to.equal(tmpRow.canonical);
								libFacetBuckets.INTERVAL_ORDER.forEach(
									(pInterval) =>
									{
										Expect(libFacetBuckets.dateKey(pValue, pInterval), `${pValue} ${pInterval}`).to.equal(tmpRow[pInterval]);
									});
							});
						// Missing values are NULL on both sides.
						[ '', 'garbage', '2026-13-01' ].forEach(
							(pValue) =>
							{
								let tmpRow = tmpStatement.get({ v: pValue });
								Expect(tmpRow.month, pValue).to.equal(null);
								Expect(libFacetBuckets.dateKey(pValue, 'month'), pValue).to.equal(null);
							});
						tmpDB.close();
					});
			}
		);

		// ============================================================ Buckets: numbers
		suite
		(
			'Buckets: numbers',
			() =>
			{
				test('units rounds float noise (half away from zero) and formatUnits is exact',
					() =>
					{
						Expect(libFacetBuckets.units(8.4, 1)).to.equal(84);
						Expect(libFacetBuckets.units(0.1 + 0.2, 2)).to.equal(30);
						Expect(libFacetBuckets.units(1234.56, 2)).to.equal(123456);
						Expect(libFacetBuckets.units(-0.07, 2)).to.equal(-7);
						Expect(libFacetBuckets.units(-2.5, 0)).to.equal(-3);
						Expect(libFacetBuckets.units(2.5, 0)).to.equal(3);
						Expect(Object.is(libFacetBuckets.units(-0.0001, 2), 0)).to.equal(true);
						Expect(libFacetBuckets.units('12.30', 2)).to.equal(1230);
						Expect(libFacetBuckets.units(12n, 0)).to.equal(12);
						[ null, undefined, '', '  ', 'abc', NaN, Infinity, true ].forEach((pValue) => { Expect(libFacetBuckets.units(pValue, 2), String(pValue)).to.equal(null); });
						Expect(libFacetBuckets.formatUnits(123456, 2)).to.equal('1234.56');
						Expect(libFacetBuckets.formatUnits(-5, 2)).to.equal('-0.05');
						Expect(libFacetBuckets.formatUnits(5, 3)).to.equal('0.005');
						Expect(libFacetBuckets.formatUnits(0, 2)).to.equal('0.00');
						Expect(libFacetBuckets.formatUnits(-0, 2)).to.equal('0.00');
						Expect(libFacetBuckets.formatUnits(42, 0)).to.equal('42');
						Expect(libFacetBuckets.formatUnits(9007199254740993, 2)).to.equal('90071992547409.92');
						// Beyond 2^53 the exact value of the double is printed (never an exponent).
						Expect(libFacetBuckets.formatUnits(12345678901234567890, 2)).to.equal('123456789012345671.68');
						Expect(libFacetBuckets.formatUnits(null, 2)).to.equal(null);
					});

				test('numericGeometry: integer column with a negative outlier gets integer widths',
					() =>
					{
						let tmpGeometry = libFacetBuckets.numericGeometry(-37, 2025, 20, 0, 500);
						Expect(tmpGeometry).to.deep.equal(
							{
								Mode: 'Nice', Lo: -37, Hi: 2025, Scale: 0, Factor: 1, LoUnits: -200, WidthUnits: 200, Width: 200, N: 12,
								Edges: [ -200, 0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200 ]
							});
						Expect(libFacetBuckets.numericIndex(-37, tmpGeometry)).to.equal(0);
						Expect(libFacetBuckets.numericIndex(0, tmpGeometry)).to.equal(1);
						Expect(libFacetBuckets.numericIndex(2025, tmpGeometry)).to.equal(11);
						Expect(libFacetBuckets.numericIndex(null, tmpGeometry)).to.equal(null);
					});

				test('numericGeometry: decimals bucket in integer units (no 8.4 / 0.2 float edge errors)',
					() =>
					{
						let tmpGeometry = libFacetBuckets.numericGeometry(0.3, 8.4, 40, 2, 500);
						Expect(tmpGeometry.WidthUnits).to.equal(50);
						Expect(tmpGeometry.Width).to.equal(0.5);
						Expect(tmpGeometry.LoUnits).to.equal(0);
						Expect(tmpGeometry.N).to.equal(17);
						Expect(tmpGeometry.Edges[17]).to.equal(8.5);
						let tmpFine = libFacetBuckets.numericGeometry(0.2, 8.4, 50, 1, 500);
						Expect(tmpFine.WidthUnits).to.equal(2);
						Expect(tmpFine.Width).to.equal(0.2);
						Expect(tmpFine.LoUnits).to.equal(2);
						Expect(tmpFine.N).to.equal(41);
						Expect(libFacetBuckets.numericIndex(8.4, tmpFine)).to.equal(40);
						Expect(libFacetBuckets.numericIndex(8.2, tmpFine)).to.equal(40);
						Expect(libFacetBuckets.numericIndex(8.0, tmpFine)).to.equal(39);
						Expect(tmpFine.Edges[39]).to.equal(8);
						// Every edge carries at most the column scale (no 0.30000000000000004).
						Expect(tmpFine.Edges.every((pEdge) => { return /^-?\d+(\.\d)?$/.test(String(pEdge)); })).to.equal(true);
						// Float division puts 0.3 in bucket 2 of [0, 0.1, 0.2, …] (0.3 / 0.1 = 2.9999999999999996); integer units put it in bucket 3.
						let tmpTenths = libFacetBuckets.numericGeometry(0, 0.95, 10, 2, 500);
						Expect(tmpTenths).to.include({ WidthUnits: 10, Width: 0.1, LoUnits: 0, N: 10 });
						Expect(Math.floor((0.3 - 0) / 0.1)).to.equal(2);
						Expect(libFacetBuckets.numericIndex(0.3, tmpTenths)).to.equal(3);
						Expect(libFacetBuckets.numericBucketBounds(tmpTenths, 3)).to.deep.equal({ Start: 0.3, End: 0.4, EndExclusive: true });
						Expect(libFacetBuckets.numericIndex(0.7, tmpTenths)).to.equal(7);
					});

				test('numericGeometry edge cases: one value, no values, MaxBuckets, bad input',
					() =>
					{
						Expect(libFacetBuckets.numericGeometry(5, 5, 20, 0, 500)).to.include({ LoUnits: 5, WidthUnits: 1, N: 1 });
						Expect(libFacetBuckets.numericGeometry(5, 5, 20, 0, 500).Edges).to.deep.equal([ 5, 6 ]);
						Expect(libFacetBuckets.numericGeometry(null, null, 20, 2, 500)).to.deep.equal(
							{ Mode: 'Nice', Lo: null, Hi: null, Scale: 2, Factor: 100, LoUnits: null, WidthUnits: null, Width: null, N: 0, Edges: [] });
						Expect(libFacetBuckets.numericIndex(5, libFacetBuckets.numericGeometry(null, null, 20, 2, 500))).to.equal(null);
						let tmpCapped = libFacetBuckets.numericGeometry(0, 1000, 500, 0, 7);
						Expect(tmpCapped.N).to.be.at.most(7);
						Expect(tmpCapped.WidthUnits).to.equal(200);
						Expect(libFacetBuckets.numericGeometry(5, 25, 2, 0, 500)).to.include({ WidthUnits: 10, LoUnits: 0, N: 3 });
						Expect(libFacetBuckets.numericGeometry(5, 25, null, 0).N).to.equal(20);
						// A span across an aligned edge never fits one bucket: MaxBuckets below 2 acts as 2.
						Expect(libFacetBuckets.numericGeometry(-3, 4, 20, 0, 1)).to.include({ N: 2, WidthUnits: 5, LoUnits: -5 });
						Expect(libFacetBuckets.numericGeometry(1, 4, 20, 0, 1)).to.include({ N: 2, WidthUnits: 2, LoUnits: 0 });
						expectFacetError(() => { libFacetBuckets.numericGeometry(10, 1, 20, 0, 500); }, 'FACET_INTERNAL');
					});

				test('numericGeometry invariants hold for random inputs',
					() =>
					{
						let fRandom = prng(42);
						for (let i = 0; i < 400; i++)
						{
							let tmpScale = Math.floor(fRandom() * 4);
							let tmpFactor = Math.pow(10, tmpScale);
							let tmpMagnitude = Math.pow(10, Math.floor(fRandom() * 7));
							let tmpA = Math.round((fRandom() - 0.3) * tmpMagnitude * tmpFactor) / tmpFactor;
							let tmpB = Math.round((fRandom() - 0.3) * tmpMagnitude * tmpFactor) / tmpFactor;
							let tmpLo = Math.min(tmpA, tmpB);
							let tmpHi = Math.max(tmpA, tmpB);
							let tmpBuckets = 1 + Math.floor(fRandom() * 60);
							let tmpMax = 2 + Math.floor(fRandom() * 80);
							let tmpGeometry = libFacetBuckets.numericGeometry(tmpLo, tmpHi, tmpBuckets, tmpScale, tmpMax);
							let tmpLabel = JSON.stringify([ tmpLo, tmpHi, tmpBuckets, tmpScale, tmpMax ]);
							Expect(tmpGeometry.N, tmpLabel).to.be.within(1, tmpMax);
							Expect(tmpGeometry.Edges.length, tmpLabel).to.equal(tmpGeometry.N + 1);
							Expect(tmpGeometry.LoUnits, tmpLabel).to.be.at.most(libFacetBuckets.units(tmpLo, tmpScale));
							Expect(tmpGeometry.LoUnits % tmpGeometry.WidthUnits, tmpLabel).to.satisfy((pRemainder) => { return pRemainder === 0; });
							Expect(String(tmpGeometry.WidthUnits), tmpLabel).to.match(/^[125]0*$/);
							Expect(tmpGeometry.Edges[0], tmpLabel).to.be.at.most(tmpLo);
							Expect(tmpGeometry.Edges[tmpGeometry.N], tmpLabel).to.be.at.least(tmpHi);
							for (let j = 0; j < 25; j++)
							{
								let tmpValue = Math.round((tmpLo + (fRandom() * (tmpHi - tmpLo))) * tmpFactor) / tmpFactor;
								tmpValue = Math.min(Math.max(tmpValue, tmpLo), tmpHi);
								let tmpIndex = libFacetBuckets.numericIndex(tmpValue, tmpGeometry);
								let tmpBounds = libFacetBuckets.numericBucketBounds(tmpGeometry, tmpIndex);
								Expect(tmpIndex, `${tmpLabel} ${tmpValue}`).to.be.within(0, tmpGeometry.N - 1);
								Expect(tmpBounds.Start <= tmpValue, `${tmpLabel} ${tmpValue}`).to.equal(true);
								Expect(tmpBounds.EndExclusive ? (tmpValue < tmpBounds.End) : (tmpValue <= tmpBounds.End), `${tmpLabel} ${tmpValue}`).to.equal(true);
							}
						}
					});

				(libNodeSQLite ? test : test.skip)('numericIndex equals the SQLite integer-unit expression',
					() =>
					{
						let tmpDB = new libNodeSQLite.DatabaseSync(':memory:');
						let tmpStatement = tmpDB.prepare(
							'SELECT min(CAST((CAST(ROUND(:v * :fFactor) AS INTEGER) - :fLoUnits) / :fWidthUnits AS INTEGER), :fLastIndex) AS idx');
						let fRandom = prng(7);
						let tmpGeometries = [ libFacetBuckets.numericGeometry(0.2, 8.4, 50, 1, 500), libFacetBuckets.numericGeometry(-12.37, 950.5, 24, 2, 500), libFacetBuckets.numericGeometry(-37, 2025, 20, 0, 500) ];
						tmpGeometries.forEach(
							(pGeometry) =>
							{
								let tmpFactor = pGeometry.Factor;
								let tmpLoUnits = libFacetBuckets.units(pGeometry.Lo, pGeometry.Scale);
								let tmpHiUnits = libFacetBuckets.units(pGeometry.Hi, pGeometry.Scale);
								let tmpValues = [ pGeometry.Lo, pGeometry.Hi ].concat(pGeometry.Edges.filter((pEdge) => { return (pEdge >= pGeometry.Lo) && (pEdge <= pGeometry.Hi); }));
								for (let i = 0; i < 500; i++)
								{
									tmpValues.push((tmpLoUnits + Math.floor(fRandom() * (tmpHiUnits - tmpLoUnits + 1))) / tmpFactor);
								}
								tmpValues.forEach(
									(pValue) =>
									{
										let tmpRow = tmpStatement.get({ v: pValue, fFactor: tmpFactor, fLoUnits: pGeometry.LoUnits, fWidthUnits: pGeometry.WidthUnits, fLastIndex: pGeometry.N - 1 });
										Expect(libFacetBuckets.numericIndex(pValue, pGeometry), `${pValue}`).to.equal(tmpRow.idx);
									});
							});
						tmpDB.close();
					});

				test('edgesGeometry: closed and open-ended, values outside are Other (null)',
					() =>
					{
						let tmpClosed = libFacetBuckets.edgesGeometry([ 1800, 1900, 2000, 2030 ], false, 0);
						Expect(tmpClosed).to.include({ Mode: 'Edges', Lo: 1800, Hi: 2030, N: 3, OpenEnded: false });
						Expect([ 1799, 1800, 1899, 1900, 2029, 2030, 2500, -37, null, '' ].map((pValue) => { return libFacetBuckets.numericIndex(pValue, tmpClosed); })).to.deep.equal(
							[ null, 0, 0, 1, 2, null, null, null, null, null ]);
						let tmpOpen = libFacetBuckets.edgesGeometry([ 0, 10, 50 ], true, 2);
						Expect(tmpOpen).to.include({ N: 3, Hi: null, OpenEnded: true });
						Expect([ -0.01, 0, 9.99, 10, 49.99, 50, 1e9 ].map((pValue) => { return libFacetBuckets.numericIndex(pValue, tmpOpen); })).to.deep.equal([ null, 0, 0, 1, 1, 2, 2 ]);
						Expect(libFacetBuckets.numericIndex('25', tmpOpen)).to.equal(1);
						// Binary search agrees with a linear scan on many edges.
						let tmpEdges = [];
						for (let i = 0; i <= 200; i++)
						{
							tmpEdges.push(i * 3);
						}
						let tmpMany = libFacetBuckets.edgesGeometry(tmpEdges, false, 0);
						for (let tmpValue = -1; tmpValue <= 601; tmpValue++)
						{
							let tmpExpected = null;
							for (let i = 0; i < tmpEdges.length - 1; i++)
							{
								if ((tmpValue >= tmpEdges[i]) && (tmpValue < tmpEdges[i + 1]))
								{
									tmpExpected = i;
								}
							}
							Expect(libFacetBuckets.numericIndex(tmpValue, tmpMany), String(tmpValue)).to.equal(tmpExpected);
						}
						expectFacetError(() => { libFacetBuckets.edgesGeometry([ 1 ], false, 0); }, 'FACET_REQUEST_INVALID');
						expectFacetError(() => { libFacetBuckets.edgesGeometry([ 1, 1 ], false, 0); }, 'FACET_REQUEST_INVALID');
						expectFacetError(() => { libFacetBuckets.edgesGeometry([ 1, NaN ], false, 0); }, 'FACET_REQUEST_INVALID');
					});

				test('numericBucketBounds and numericLabel',
					() =>
					{
						let tmpInteger = libFacetBuckets.numericGeometry(0, 95, 10, 0, 500);
						Expect(tmpInteger.Edges).to.deep.equal([ 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 ]);
						Expect(libFacetBuckets.numericBucketBounds(tmpInteger, 0)).to.deep.equal({ Start: 0, End: 10, EndExclusive: true });
						Expect(libFacetBuckets.numericBucketBounds(tmpInteger, 9)).to.deep.equal({ Start: 90, End: 100, EndExclusive: false });
						Expect(libFacetBuckets.numericBucketBounds(tmpInteger, 10)).to.equal(null);
						Expect(libFacetBuckets.numericBucketBounds(tmpInteger, -1)).to.equal(null);
						Expect(libFacetBuckets.numericLabel(tmpInteger, 0, true)).to.equal(`0${DASH}9`);
						Expect(libFacetBuckets.numericLabel(tmpInteger, 9, true)).to.equal(`90${DASH}100`);
						Expect(libFacetBuckets.numericLabel(tmpInteger, 0, false)).to.equal(`0${DASH}<10`);
						Expect(libFacetBuckets.numericLabel(libFacetBuckets.numericGeometry(1, 5, 20, 0, 500), 0, true)).to.equal('1');
						let tmpOpen = libFacetBuckets.edgesGeometry([ 0, 0.5, 2.25 ], true, 2);
						Expect(libFacetBuckets.numericBucketBounds(tmpOpen, 2)).to.deep.equal({ Start: 2.25, EndExclusive: true });
						Expect(libFacetBuckets.numericLabel(tmpOpen, 0, false)).to.equal(`0${DASH}<0.5`);
						Expect(libFacetBuckets.numericLabel(tmpOpen, 2, false)).to.equal('2.25+');
						Expect(libFacetBuckets.numericLabel(tmpOpen, 7, false)).to.equal('7');
					});

				test('rangeKey uses first-match CASE semantics; rangeLabel',
					() =>
					{
						let tmpRanges = [ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'mid', From: 2, To: 5 }, { Key: 'high', From: 5, To: null } ];
						Expect([ -10, 0, 2, 2.9, 3, 4.99, 5, 99, null, '', 'x', '4' ].map((pValue) => { return libFacetBuckets.rangeKey(pValue, tmpRanges); })).to.deep.equal(
							[ 'low', 'low', 'low', 'low', 'mid', 'mid', 'high', 'high', null, null, null, 'mid' ]);
						Expect(libFacetBuckets.rangeKey(10, [ { Key: 'a', From: 0, To: 5 } ])).to.equal(null);
						Expect(libFacetBuckets.rangeLabel(tmpRanges[0], true)).to.equal('Low');
						Expect(libFacetBuckets.rangeLabel(tmpRanges[1], true)).to.equal(`2${DASH}4`);
						Expect(libFacetBuckets.rangeLabel(tmpRanges[1], false)).to.equal(`2${DASH}<5`);
						Expect(libFacetBuckets.rangeLabel(tmpRanges[2], true)).to.equal('5+');
						Expect(libFacetBuckets.rangeLabel({ Key: 'x', From: null, To: 3 }, true)).to.equal('≤2');
						Expect(libFacetBuckets.rangeLabel({ Key: 'x', From: null, To: 3.5 }, false)).to.equal('<3.5');
						Expect(libFacetBuckets.rangeLabel({ Key: 'x' }, false)).to.equal('All');
					});

				test('normalizeKey and compareKeys',
					() =>
					{
						Expect(libFacetBuckets.normalizeKey('12', 'Numeric')).to.equal(12);
						Expect(libFacetBuckets.normalizeKey(12.5, 'Decimal')).to.equal(12.5);
						Expect(libFacetBuckets.normalizeKey(true, 'Boolean')).to.equal(1);
						Expect(libFacetBuckets.normalizeKey(false, 'Boolean')).to.equal(0);
						Expect(libFacetBuckets.normalizeKey(7n, 'ForeignKey')).to.equal(7);
						Expect(libFacetBuckets.normalizeKey('', 'Numeric')).to.equal('');
						Expect(libFacetBuckets.normalizeKey('n/a', 'Numeric')).to.equal('n/a');
						Expect(libFacetBuckets.normalizeKey(12, 'String')).to.equal('12');
						Expect(libFacetBuckets.normalizeKey('', 'String')).to.equal('');
						Expect(libFacetBuckets.normalizeKey(null, 'String')).to.equal(null);
						Expect(libFacetBuckets.normalizeKey(undefined, 'Numeric')).to.equal(null);
						Expect(libFacetEnvelope.normalizeKey).to.equal(libFacetBuckets.normalizeKey);
						Expect([ 'b', null, 10, 'B', 2, 'a', '' ].sort(libFacetBuckets.compareKeys)).to.deep.equal([ 2, 10, '', 'B', 'a', 'b', null ]);
						Expect([ '10', 'Z', 'a', 'Ä', '\u00e9' ].sort(libFacetBuckets.compareKeys)).to.deep.equal([ '10', 'Z', 'a', 'Ä', '\u00e9' ]);
						Expect(libFacetBuckets.compareKeys(10, '10')).to.equal(-1);
						Expect(libFacetBuckets.compareKeys('x', 'x')).to.equal(0);
						Expect(libFacetBuckets.compareKeys(null, undefined)).to.equal(0);
						Expect(libFacetBuckets.compareKeys(null, 'a')).to.equal(1);
						// A total order on mixed keys (no cycles): 9 < 10 < '5' and 9 < '5'.
						let tmpMixed = [ 10, '5', 9, 'NaN', NaN, '9a' ];
						let tmpSorted = tmpMixed.slice().sort(libFacetBuckets.compareKeys);
						for (let i = 0; i < tmpSorted.length; i++)
						{
							for (let j = i + 1; j < tmpSorted.length; j++)
							{
								Expect(libFacetBuckets.compareKeys(tmpSorted[i], tmpSorted[j]), `${tmpSorted[i]} ${tmpSorted[j]}`).to.be.at.most(0);
							}
						}
					});
			}
		);

		// ============================================================ Clauses
		suite
		(
			'Clauses',
			() =>
			{
				test('canonicalJSON, clauseSignature and clauseHash are deterministic',
					() =>
					{
						Expect(libFacetClauses.canonicalJSON({ b: 1, a: [ { d: 2, c: undefined }, null ], e: 'x' })).to.equal('{"a":[{"d":2},null],"b":1,"e":"x"}');
						let tmpClause = { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], FilterKey: 'PaymentMethod', ClauseKey: 'DistinctSelectedValueList' };
						Expect(libFacetClauses.clauseSignature(tmpClause)).to.equal('DistinctSelectedValueList|PaymentMethod|PaymentMethod');
						Expect(libFacetClauses.clauseSignature({ Type: 'Match', FilterByColumns: [ 'A', 'B' ] })).to.equal('Match||A,B');
						Expect(libFacetClauses.clauseSignature(null)).to.equal('');
						let tmpHash = libFacetClauses.clauseHash(tmpClause);
						Expect(tmpHash).to.match(/^PaymentMethod-DistinctSelectedValueList-[0-9a-f]{12}$/);
						Expect(libFacetClauses.clauseHash(Object.assign({}, tmpClause, { Hash: 'ignored', GUIDGroup: 'g' }))).to.equal(tmpHash);
						Expect(libFacetClauses.clauseHash(Object.assign({}, tmpClause, { Values: [ 'Cash' ] }))).to.not.equal(tmpHash);
						Expect(libFacetClauses.clauseHash({ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: 'a', End: 'b' } })).to.not.equal(
							libFacetClauses.clauseHash({ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: 'a', End: 'b' }, EndExclusive: true }));
						Expect(libFacetClauses.clauseHash({ Type: 'X', FilterByColumn: 'A', Values: { End: 2, Start: 1 } })).to.equal(libFacetClauses.clauseHash({ Values: { Start: 1, End: 2 }, FilterByColumn: 'A', Type: 'X' }));
						Expect(libFacetClauses.shortHash('abc')).to.have.length(16);
						Expect(libFacetClauses.shortHash('abc')).to.not.equal(libFacetClauses.shortHash('abd'));
					});

				test('ownership: explicit Exclude → FilterKey → Fields ⊆ OwnedFields (D-05)',
					() =>
					{
						let tmpSpec = { Key: 'ByPay', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PayKey', Exclude: 'Self' };
						let tmpByFields = conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit' ] });
						let tmpByKey = conjunct('c2', { Field: 'Other', Op: 'EQ', Value: 1 }, { Origin: { Kind: 'Clause', Hash: 'h2', FilterKey: 'PayKey' } });
						let tmpMixed = conjunct('c3', { Or: [ { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' }, { Field: 'Title', Op: 'LK', Value: '%x%' } ] });
						let tmpUnrelated = conjunct('c4', { Field: 'Title', Op: 'LK', Value: '%x%' }, { Origin: { Kind: 'Clause', Hash: 'h4', FilterKey: null } });
						Expect(libFacetClauses.ownership(tmpSpec, tmpByFields)).to.equal('Fields');
						Expect(libFacetClauses.ownership(tmpSpec, tmpByKey)).to.equal('FilterKey');
						Expect(libFacetClauses.ownership(tmpSpec, tmpMixed)).to.equal(null);
						Expect(libFacetClauses.isMixed(tmpSpec, tmpMixed)).to.equal(true);
						Expect(libFacetClauses.isMixed(tmpSpec, tmpByFields)).to.equal(false);
						Expect(libFacetClauses.isMixed(tmpSpec, tmpUnrelated)).to.equal(false);
						Expect(libFacetClauses.ownership(Object.assign({}, tmpSpec, { Exclude: [ 'h4' ] }), tmpUnrelated)).to.equal('Explicit');
						Expect(libFacetClauses.ownership(Object.assign({}, tmpSpec, { Exclude: [ 'c4' ] }), tmpUnrelated)).to.equal('Explicit');
						Expect(libFacetClauses.ownership(Object.assign({}, tmpSpec, { Exclude: [ 'c2' ] }), tmpByKey)).to.equal('Explicit');
						Expect(libFacetClauses.ownership(tmpSpec, conjunct('c5', { Field: 'X', Op: 'EQ', Value: 1 }, { Fields: [] }))).to.equal(null);
						Expect(libFacetClauses.ownership(null, tmpByFields)).to.equal(null);
					});

				test('exclusionFor: Exact, Partial (mixed or owned NeverExclude), NotApplicable, explicit',
					() =>
					{
						let tmpConjuncts =
							[
								conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit' ] }, { Origin: { Kind: 'Clause', Hash: 'h1', FilterKey: 'PaymentMethod' } }),
								conjunct('c2', { Field: 'SaleDate', Op: 'GE', Value: '2026-01-01 00:00:00' }),
								conjunct('c3', { Or: [ { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' }, { Field: 'Title', Op: 'LK', Value: '%x%' } ] }),
								conjunct('c4', { Field: 'PaymentMethod', Op: 'NE', Value: 'Gift' }, { NeverExclude: true, Origin: { Kind: 'RawFilter', Hash: 'raw', FilterKey: null } })
							];
						let tmpSelf = libFacetClauses.exclusionFor({ OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: 'Self' }, tmpConjuncts);
						Expect(tmpSelf).to.deep.equal({ Mode: 'Partial', Owned: [ 'c1', 'c4' ], Excluded: [ 'c1' ], ExcludedHashes: [ 'h1' ], KeptMixed: [ 'c3', 'c4' ], Kept: [ 'c2', 'c3', 'c4' ] });
						let tmpDate = libFacetClauses.exclusionFor({ OwnedFields: [ 'SaleDate' ], FilterKey: 'SaleDate', Exclude: null }, tmpConjuncts);
						Expect(tmpDate).to.deep.equal({ Mode: 'Exact', Owned: [ 'c2' ], Excluded: [ 'c2' ], ExcludedHashes: [ null ], KeptMixed: [], Kept: [ 'c1', 'c3', 'c4' ] });
						let tmpNone = libFacetClauses.exclusionFor({ OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: 'None' }, tmpConjuncts);
						Expect(tmpNone).to.deep.equal({ Mode: 'NotApplicable', Owned: [ 'c1', 'c4' ], Excluded: [], ExcludedHashes: [], KeptMixed: [], Kept: [ 'c1', 'c2', 'c3', 'c4' ] });
						let tmpExplicit = libFacetClauses.exclusionFor({ OwnedFields: [ 'Amount' ], FilterKey: 'Amount', Exclude: [ 'c3' ] }, tmpConjuncts);
						Expect(tmpExplicit).to.deep.equal({ Mode: 'Exact', Owned: [ 'c3' ], Excluded: [ 'c3' ], ExcludedHashes: [ null ], KeptMixed: [], Kept: [ 'c1', 'c2', 'c4' ] });
						Expect(libFacetClauses.exclusionFor({ OwnedFields: [ 'A' ] }, [])).to.deep.equal({ Mode: 'Exact', Owned: [], Excluded: [], ExcludedHashes: [], KeptMixed: [], Kept: [] });
					});

				test('bucketClause builds the standard pict clause per fold (02 §5)',
					() =>
					{
						let tmpTerms = { Fold: 'Terms', Field: 'PaymentMethod', FilterKey: 'PaymentMethod' };
						Expect(libFacetClauses.bucketClause(tmpTerms, { Key: 'Credit' })).to.deep.equal(
							{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], FilterKey: 'PaymentMethod', ClauseKey: 'DistinctSelectedValueList' });
						Expect(libFacetClauses.bucketClause({ Kind: 'Terms', Field: 'IDBook' }, { Key: 7 }).FilterKey).to.equal('IDBook');
						Expect(libFacetClauses.bucketClause(tmpTerms, { Key: null })).to.equal(null);
						Expect(libFacetClauses.bucketClause({ Fold: 'DateHistogram', Field: 'SaleDate', FilterKey: 'SaleDate' }, { Key: '2026-03-01 00:00:00', Start: '2026-03-01 00:00:00', End: '2026-04-01 00:00:00', EndExclusive: true })).to.deep.equal(
							{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2026-03-01 00:00:00', End: '2026-04-01 00:00:00' }, EndExclusive: true, FilterKey: 'SaleDate', ClauseKey: 'DateRange' });
						let tmpNumeric = { Fold: 'NumericHistogram', Field: 'TotalAmount', FilterKey: 'TotalAmount' };
						Expect(libFacetClauses.bucketClause(tmpNumeric, { Key: 0, Start: 0, End: 10, EndExclusive: true })).to.deep.equal(
							{ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 0, End: 10 }, EndExclusive: true, FilterKey: 'TotalAmount', ClauseKey: 'NumericRange' });
						Expect(libFacetClauses.bucketClause(tmpNumeric, { Key: 9, Start: 90, End: 100, EndExclusive: false }).EndExclusive).to.equal(false);
						Expect(libFacetClauses.bucketClause(tmpNumeric, { Key: 3, Start: 50, EndExclusive: true }).Values).to.deep.equal({ Start: 50 });
						Expect(libFacetClauses.bucketClause({ Fold: 'Ranges', Field: 'Rating' }, { Key: 'low', End: 3, EndExclusive: true }).Values).to.deep.equal({ End: 3 });
						Expect(libFacetClauses.bucketClause({ Fold: 'Ranges', Field: 'Rating' }, { Key: 'all' })).to.equal(null);
						[ 'Stats', 'DistinctCount', 'Missing', 'Pivot' ].forEach((pFold) => { Expect(libFacetClauses.bucketClause({ Fold: pFold, Field: 'X' }, { Key: 1 }), pFold).to.equal(null); });
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms' }, { Key: 1 })).to.equal(null);
						Expect(libFacetClauses.bucketClause(tmpTerms, null)).to.equal(null);
					});

				test('selectedFrom: Terms keys from IN / EQ / Or, ANDed across conjuncts, RawFilter ignored',
					() =>
					{
						let tmpAgg = agg({});
						Expect(libFacetClauses.selectedFrom(tmpAgg, [])).to.deep.equal({ Keys: [], Range: null, Ranges: [], Constrained: false });
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Debit', 'Credit', null ] }) ]).Keys).to.deep.equal([ 'Credit', 'Debit' ]);
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Or: [ { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' }, { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit' ] } ] }) ]).Keys).to.deep.equal([ 'Cash', 'Credit' ]);
						Expect(libFacetClauses.selectedFrom(tmpAgg,
							[
								conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash', 'Credit' ] }),
								conjunct('c2', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit', 'Debit' ] })
							]).Keys).to.deep.equal([ 'Credit' ]);
						// An Or that reaches another field, an LK, a RawFilter: not a selection.
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Or: [ { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' }, { Field: 'Title', Op: 'EQ', Value: 'x' } ] }) ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Field: 'PaymentMethod', Op: 'LK', Value: '%a%' }) ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash' ] }, { NeverExclude: true }) ]).Constrained).to.equal(false);
						// And with another field narrows to this field's part; NULL selects no key.
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { And: [ { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' }, { Field: 'Title', Op: 'EQ', Value: 'x' } ] }) ]).Keys).to.deep.equal([ 'Cash' ]);
						Expect(libFacetClauses.selectedFrom(tmpAgg, [ conjunct('c1', { Field: 'PaymentMethod', Op: 'NULL' }) ])).to.include({ Constrained: true });
						// Keys normalize by DataType (FilterString values arrive as strings).
						let tmpRating = agg({ Field: 'Rating', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric', IsInteger: true, Scale: 0 } ] });
						Expect(libFacetClauses.selectedFrom(tmpRating, [ conjunct('c1', { Field: 'Rating', Op: 'IN', Value: [ '5', 4, '4' ] }) ]).Keys).to.deep.equal([ 4, 5 ]);
						Expect(libFacetClauses.selectedFrom(agg({ Kind: 'Stats' }), [ conjunct('c1', { Field: 'PaymentMethod', Op: 'EQ', Value: 'x' }) ]).Constrained).to.equal(false);
					});

				test('selectedFrom / bucketSelected for range folds (dates, decimals, integers)',
					() =>
					{
						let tmpDateAgg = agg({ Kind: 'DateHistogram', Field: 'SaleDate', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'month' } ] });
						let tmpSelected = libFacetClauses.selectedFrom(tmpDateAgg,
							[ conjunct('c1', { And: [ { Field: 'SaleDate', Op: 'GE', Value: '2026-03-01' }, { Field: 'SaleDate', Op: 'LT', Value: '2026-05-01T00:00:00Z' } ] }) ]);
						Expect(tmpSelected.Range).to.deep.equal({ Lo: '2026-03-01 00:00:00', LoInclusive: true, Hi: '2026-05-01 00:00:00', HiInclusive: false });
						const month = (pKey) => { return { Key: pKey, Start: pKey, End: libFacetBuckets.nextDateKey(pKey, 'month'), EndExclusive: true }; };
						Expect([ '2026-02-01 00:00:00', '2026-03-01 00:00:00', '2026-04-01 00:00:00', '2026-05-01 00:00:00' ].map((pKey) => { return libFacetClauses.bucketSelected(tmpDateAgg, tmpSelected, month(pKey)); })).to.deep.equal(
							[ false, true, true, false ]);
						// A bound that cuts a bucket does not select it.
						let tmpCut = libFacetClauses.selectedFrom(tmpDateAgg, [ conjunct('c1', { Field: 'SaleDate', Op: 'GT', Value: '2026-03-01 00:00:00' }) ]);
						Expect(libFacetClauses.bucketSelected(tmpDateAgg, tmpCut, month('2026-03-01 00:00:00'))).to.equal(false);
						Expect(libFacetClauses.bucketSelected(tmpDateAgg, tmpCut, month('2026-04-01 00:00:00'))).to.equal(true);
						// Unparseable bounds are not a selection.
						Expect(libFacetClauses.selectedFrom(tmpDateAgg, [ conjunct('c1', { Field: 'SaleDate', Op: 'GE', Value: 'soon' }) ]).Constrained).to.equal(false);

						// Integer columns: LE 19 is LT 20, GT 9 is GE 10; the closed last bucket [90, 100] is [90, 101).
						let tmpIntAgg = agg({ Kind: 'NumericHistogram', Field: 'Year', Dimensions: [ { Kind: 'NumericBucket', Field: 'Year', Mode: 'Nice', IsInteger: true, Scale: 0 } ] });
						let tmpIntSelected = libFacetClauses.selectedFrom(tmpIntAgg, [ conjunct('c1', { And: [ { Field: 'Year', Op: 'GT', Value: 9 }, { Field: 'Year', Op: 'LE', Value: '19' } ] }) ]);
						Expect(tmpIntSelected.Range).to.deep.equal({ Lo: 10, LoInclusive: true, Hi: 20, HiInclusive: false });
						Expect(libFacetClauses.bucketSelected(tmpIntAgg, tmpIntSelected, { Key: 1, Start: 10, End: 20, EndExclusive: true })).to.equal(true);
						let tmpLast = libFacetClauses.selectedFrom(tmpIntAgg, [ conjunct('c1', { And: [ { Field: 'Year', Op: 'GE', Value: 90 }, { Field: 'Year', Op: 'LE', Value: 100 } ] }) ]);
						Expect(libFacetClauses.bucketSelected(tmpIntAgg, tmpLast, { Key: 9, Start: 90, End: 100, EndExclusive: false })).to.equal(true);

						// Decimals: a closed bucket needs an inclusive (or larger) upper bound.
						let tmpDecAgg = agg({ Kind: 'NumericHistogram', Field: 'Amount', Dimensions: [ { Kind: 'NumericBucket', Field: 'Amount', Mode: 'Nice', IsInteger: false, Scale: 2 } ] });
						let tmpDecExclusive = libFacetClauses.selectedFrom(tmpDecAgg, [ conjunct('c1', { And: [ { Field: 'Amount', Op: 'GE', Value: 8 }, { Field: 'Amount', Op: 'LT', Value: 8.5 } ] }) ]);
						Expect(libFacetClauses.bucketSelected(tmpDecAgg, tmpDecExclusive, { Key: 16, Start: 8, End: 8.5, EndExclusive: true })).to.equal(true);
						Expect(libFacetClauses.bucketSelected(tmpDecAgg, tmpDecExclusive, { Key: 16, Start: 8, End: 8.5, EndExclusive: false })).to.equal(false);

						// Two selected spans (an Or) select buckets inside either; ANDed conjuncts intersect.
						let tmpUnion = libFacetClauses.selectedFrom(tmpDecAgg,
							[ conjunct('c1', { Or: [ { And: [ { Field: 'Amount', Op: 'GE', Value: 0 }, { Field: 'Amount', Op: 'LT', Value: 10 } ] }, { And: [ { Field: 'Amount', Op: 'GE', Value: 20 }, { Field: 'Amount', Op: 'LT', Value: 30 } ] } ] }) ]);
						Expect(tmpUnion.Range).to.equal(null);
						Expect(tmpUnion.Ranges).to.have.length(2);
						Expect([ [ 0, 10 ], [ 10, 20 ], [ 20, 30 ] ].map((pSpan) => { return libFacetClauses.bucketSelected(tmpDecAgg, tmpUnion, { Start: pSpan[0], End: pSpan[1], EndExclusive: true }); })).to.deep.equal([ true, false, true ]);
						let tmpIntersect = libFacetClauses.selectedFrom(tmpDecAgg,
							[ conjunct('c1', { Field: 'Amount', Op: 'GE', Value: 5 }), conjunct('c2', { Field: 'Amount', Op: 'LT', Value: 15 }), conjunct('c3', { Field: 'Amount', Op: 'GE', Value: 0 }) ]);
						Expect(tmpIntersect.Range).to.deep.equal({ Lo: 5, LoInclusive: true, Hi: 15, HiInclusive: false });
						let tmpEmpty = libFacetClauses.selectedFrom(tmpDecAgg, [ conjunct('c1', { Field: 'Amount', Op: 'GE', Value: 50 }), conjunct('c2', { Field: 'Amount', Op: 'LT', Value: 15 }) ]);
						Expect(tmpEmpty).to.include({ Constrained: true, Range: null });
						Expect(tmpEmpty.Ranges).to.deep.equal([]);
						// Open buckets: [50, ∞) is inside GE 50 but not inside a bounded selection.
						Expect(libFacetClauses.bucketSelected(tmpDecAgg, libFacetClauses.selectedFrom(tmpDecAgg, [ conjunct('c1', { Field: 'Amount', Op: 'GE', Value: 50 }) ]), { Start: 50, EndExclusive: true })).to.equal(true);
						Expect(libFacetClauses.bucketSelected(tmpDecAgg, tmpIntersect, { Start: 50, EndExclusive: true })).to.equal(false);
						Expect(libFacetClauses.bucketSelected(tmpDecAgg, { Keys: [], Ranges: [], Constrained: false }, { Start: 0, End: 1 })).to.equal(false);
					});

				test('a bucket clause compiled back into a conjunct selects exactly that bucket',
					() =>
					{
						let tmpDateAgg = agg({ Kind: 'DateHistogram', Field: 'SaleDate', FilterKey: 'SaleDate', Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'quarter' } ] });
						let tmpKeys = libFacetBuckets.fillDateKeys('2025-01-01', '2026-12-31', 'quarter', 400);
						let tmpBuckets = tmpKeys.map((pKey) => { return { Key: pKey, Start: pKey, End: libFacetBuckets.nextDateKey(pKey, 'quarter'), EndExclusive: true }; });
						tmpBuckets.forEach(
							(pBucket, pIndex) =>
							{
								let tmpSelected = libFacetClauses.selectedFrom(tmpDateAgg, [ compileClause('c1', libFacetClauses.bucketClause(tmpDateAgg, pBucket)) ]);
								Expect(tmpBuckets.map((pOther) => { return libFacetClauses.bucketSelected(tmpDateAgg, tmpSelected, pOther); }).indexOf(true)).to.equal(pIndex);
								Expect(tmpBuckets.filter((pOther) => { return libFacetClauses.bucketSelected(tmpDateAgg, tmpSelected, pOther); })).to.have.length(1);
							});
						let tmpNumAgg = agg({ Kind: 'NumericHistogram', Field: 'Amount', FilterKey: 'Amount', Dimensions: [ { Kind: 'NumericBucket', Field: 'Amount', IsInteger: false, Scale: 2 } ] });
						let tmpGeometry = libFacetBuckets.numericGeometry(0.31, 8.4, 20, 2, 500);
						let tmpNumBuckets = [];
						for (let i = 0; i < tmpGeometry.N; i++)
						{
							tmpNumBuckets.push(Object.assign({ Key: i }, libFacetBuckets.numericBucketBounds(tmpGeometry, i)));
						}
						tmpNumBuckets.forEach(
							(pBucket, pIndex) =>
							{
								let tmpSelected = libFacetClauses.selectedFrom(tmpNumAgg, [ compileClause('c1', libFacetClauses.bucketClause(tmpNumAgg, pBucket)) ]);
								Expect(tmpNumBuckets.map((pOther) => { return libFacetClauses.bucketSelected(tmpNumAgg, tmpSelected, pOther); }).indexOf(true), String(pIndex)).to.equal(pIndex);
							});
						let tmpTermsAgg = agg({});
						let tmpSelected = libFacetClauses.selectedFrom(tmpTermsAgg, [ compileClause('c1', libFacetClauses.bucketClause(tmpTermsAgg, { Key: 'Credit' })) ]);
						Expect(tmpSelected.Keys).to.deep.equal([ 'Credit' ]);
					});
			}
		);

		// ============================================================ Envelope
		suite
		(
			'Envelope: Terms',
			() =>
			{
				const GROUPS = [ { Key: 'Credit', Count: 50 }, { Key: 'Cash', Count: 30 }, { Key: 'Debit', Count: 30 }, { Key: 'Gift', Count: 5 }, { Key: 'Check', Count: 1 } ];
				const RAW = { Key: 'K', Kind: 'Terms', VariantId: 'v1', Total: 120, MissingCount: 4, Groups: GROUPS, DistinctKeys: 5, Bounds: null, Geometry: null, Stats: null, DistinctCount: null, Cells: null };

				test('buckets in canonical order with labels, clauses and selections; arithmetic adds up',
					() =>
					{
						let tmpResult = libFacetEnvelope.buildFacetResult(agg({ Disjunctive: { Mode: 'Exact', Excluded: [ 'c1' ], ExcludedHashes: [ 'h1' ], KeptMixed: [], Owned: [ 'c1' ] } }), RAW, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; })).to.deep.equal([ [ 'Credit', 50 ], [ 'Cash', 30 ], [ 'Debit', 30 ], [ 'Gift', 5 ], [ 'Check', 1 ] ]);
						Expect(tmpResult.Buckets[0]).to.deep.equal(
							{
								Key: 'Credit', Label: 'Credit', Count: 50, Selected: false,
								Clause: { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], FilterKey: 'PaymentMethod', ClauseKey: 'DistinctSelectedValueList' },
								Selection: { Facet: 'BookStoreSale.PaymentMethod', Key: 'Credit' }
							});
						Expect(tmpResult).to.include(
							{
								Key: 'K', Facet: 'BookStoreSale.PaymentMethod', Field: 'PaymentMethod', Fold: 'Terms', DisplayName: 'Payment Method', DataType: 'String',
								Selectable: true, ClauseType: 'DistinctSelectedValueList', FilterKey: 'PaymentMethod', Engine: 'Live', Exact: true, AsOf: POST.AsOf,
								LagMS: 0, Stale: false, Cached: false, Disjunctive: 'Exact', CountMode: 'Rows',
								Total: 120, SumOfCounts: 116, MissingCount: 4, OtherCount: 0, MultiValued: false, Truncated: false, TruncatedReason: null, DistinctCount: 5
							});
						Expect(tmpResult.Excluded).to.deep.equal([ 'h1' ]);
						Expect(tmpResult.Stats).to.equal(null);
						Expect(tmpResult.Chart).to.equal(null);
						Expect(tmpResult).to.not.have.property('Interval');
					});

				test('Top truncates by the canonical order and reports it; Order only reorders the kept set',
					() =>
					{
						let tmpResult = libFacetEnvelope.buildFacetResult(agg({ Top: 2 }), RAW, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 'Credit', 'Cash' ]);
						Expect(tmpResult).to.include({ Truncated: true, TruncatedReason: 'Top', SumOfCounts: 80, MissingCount: 4, OtherCount: 36, DistinctCount: 5 });
						Expect(libFacetEnvelope.buildFacetResult(agg({ Top: 3, Order: 'KeyAsc' }), RAW, POST).Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 'Cash', 'Credit', 'Debit' ]);
						Expect(libFacetEnvelope.buildFacetResult(agg({ Top: 3, Order: 'KeyDesc' }), RAW, POST).Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 'Debit', 'Credit', 'Cash' ]);
						// DistinctKeys alone can flag truncation (an engine that returned exactly Top groups).
						let tmpExactTop = Object.assign({}, RAW, { Groups: GROUPS.slice(0, 2), DistinctKeys: 5 });
						Expect(libFacetEnvelope.buildFacetResult(agg({ Top: 2 }), tmpExactTop, POST).Truncated).to.equal(true);
						// Top null → Limits.DefaultTop.
						Expect(libFacetEnvelope.buildFacetResult(agg({ Top: null }), RAW, Object.assign({}, POST, { Limits: { DefaultTop: 1 } })).Buckets).to.have.length(1);
					});

				test('an engine returning Top + 1 groups and one returning all groups produce equal results',
					() =>
					{
						let tmpShuffled = Object.assign({}, RAW, { Groups: [ GROUPS[3], GROUPS[0], GROUPS[4], GROUPS[2], GROUPS[1] ] });
						let tmpTopPlusOne = Object.assign({}, RAW, { Groups: GROUPS.slice(0, 3) });
						let tmpA = libFacetEnvelope.buildFacetResult(agg({ Top: 2 }), tmpShuffled, POST);
						let tmpB = libFacetEnvelope.buildFacetResult(agg({ Top: 2 }), tmpTopPlusOne, Object.assign({}, POST, { Engine: 'Reference', AsOf: 'x' }));
						Expect(libFacetEnvelope.normalizeForComparison({ Facets: { K: tmpA } })).to.deep.equal(libFacetEnvelope.normalizeForComparison({ Facets: { K: tmpB } }));
					});

				test('keys are normalized by DataType and duplicates merged',
					() =>
					{
						let tmpRating = agg({ Field: 'Rating', FacetID: 'Review.Rating', Dimensions: [ { Kind: 'Column', Field: 'Rating', DataType: 'Numeric', IsInteger: true, Scale: 0 } ] });
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpRating, { Total: 10, MissingCount: 1, Groups: [ { Key: 5, Count: 4 }, { Key: '5', Count: 2 }, { Key: '3', Count: 3 } ], DistinctKeys: 3 }, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count, pBucket.Label ]; })).to.deep.equal([ [ 5, 6, '5' ], [ 3, 3, '3' ] ]);
						Expect(tmpResult).to.include({ DistinctCount: 2, SumOfCounts: 9, OtherCount: 0, DataType: 'Numeric' });
						// Null-key groups are missing rows (only when the engine sent no MissingCount).
						let tmpNullGroup = libFacetEnvelope.buildFacetResult(agg({}), { Total: 5, Groups: [ { Key: null, Count: 2 }, { Key: 'a', Count: 3 } ] }, POST);
						Expect(tmpNullGroup).to.include({ MissingCount: 2, SumOfCounts: 3, OtherCount: 0, DistinctCount: 1 });
						// Driver counts as bigint / strings.
						Expect(libFacetEnvelope.buildFacetResult(agg({}), { Total: '7', MissingCount: 0n, Groups: [ { Key: 'a', Count: 7n } ] }, POST)).to.include({ Total: 7, SumOfCounts: 7 });
					});

				test('Selected flags, selected-zero buckets and selected keys beyond Top',
					() =>
					{
						let tmpOwned = [ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash', 'Check', 'Bitcoin' ] }) ];
						let tmpResult = libFacetEnvelope.buildFacetResult(agg({ Top: 2 }), RAW, postWith(tmpOwned));
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count, pBucket.Selected ]; })).to.deep.equal(
							[ [ 'Credit', 50, false ], [ 'Cash', 30, true ], [ 'Bitcoin', 0, true ], [ 'Check', 1, true ] ]);
						Expect(tmpResult.Buckets[2].Clause.Values).to.deep.equal([ 'Bitcoin' ]);
						Expect(tmpResult.Buckets[2].Selection).to.deep.equal({ Facet: 'BookStoreSale.PaymentMethod', Key: 'Bitcoin' });
						Expect(tmpResult).to.include({ SumOfCounts: 81, OtherCount: 35, MissingCount: 4, Truncated: true });
						Expect(tmpResult.SumOfCounts + tmpResult.MissingCount + tmpResult.OtherCount).to.equal(tmpResult.Total);
						// A RawFilter (NeverExclude) is not a selection.
						let tmpRaw = libFacetEnvelope.buildFacetResult(agg({}), RAW, postWith([ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash' ] }, { NeverExclude: true }) ]));
						Expect(tmpRaw.Buckets.some((pBucket) => { return pBucket.Selected; })).to.equal(false);
					});

				test('Missing: false folds missing rows into OtherCount; Chart projection; not-selectable facets carry no clause',
					() =>
					{
						let tmpResult = libFacetEnvelope.buildFacetResult(agg({ Missing: false, Chart: true }), RAW, POST);
						Expect(tmpResult).to.include({ MissingCount: 0, OtherCount: 4, SumOfCounts: 116 });
						Expect(tmpResult.Chart).to.deep.equal({ Labels: [ 'Credit', 'Cash', 'Debit', 'Gift', 'Check' ], Datasets: [ { label: 'Payment Method', data: [ 50, 30, 30, 5, 1 ] } ] });
						let tmpPlain = libFacetEnvelope.buildFacetResult(agg({ Selectable: false }), RAW, POST);
						Expect(tmpPlain.Buckets[0].Clause).to.equal(null);
						Expect(tmpPlain.Buckets[0]).to.not.have.property('Selection');
					});

				test('Excluded shows each excluded clause Hash, else the conjunct Id',
					() =>
					{
						let tmpOwned = [ conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Cash' ] }, { Origin: { Kind: 'Clause', Hash: 'PaymentMethod-DSVL-1', FilterKey: 'PaymentMethod' } }), conjunct('c3', { Field: 'PaymentMethod', Op: 'NE', Value: 'x' }) ];
						let tmpResult = libFacetEnvelope.buildFacetResult(agg({ Disjunctive: { Mode: 'Partial', Excluded: [ 'c1', 'c3' ], ExcludedHashes: [], KeptMixed: [ 'c4' ], Owned: [ 'c1', 'c3' ] } }), RAW, postWith(tmpOwned));
						Expect(tmpResult.Excluded).to.deep.equal([ 'PaymentMethod-DSVL-1', 'c3' ]);
						Expect(tmpResult.KeptMixed).to.deep.equal([ 'c4' ]);
						Expect(tmpResult.Disjunctive).to.equal('Partial');
						let tmpParallel = libFacetEnvelope.buildFacetResult(agg({ Disjunctive: { Mode: 'Exact', Excluded: [ 'c1', 'c2' ], ExcludedHashes: [ 'h1', null ], KeptMixed: [], Owned: [ 'c1', 'c2' ] } }), RAW, POST);
						Expect(tmpParallel.Excluded).to.deep.equal([ 'h1', 'c2' ]);
					});
			}
		);

		suite
		(
			'Envelope: histograms and ranges',
			() =>
			{
				const DATE_AGG = agg(
					{
						Key: 'ByMonth', FacetID: 'BookStoreSale.SaleDate', FacetIDs: [ 'BookStoreSale.SaleDate' ], Kind: 'DateHistogram', Field: 'SaleDate',
						Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'month' } ], ClauseType: 'DateRange', FilterKey: 'SaleDate', DisplayName: 'Sale Date', Order: null
					});

				test('DateHistogram fills gaps between Bounds with half-open buckets',
					() =>
					{
						let tmpRaw = { Total: 20, MissingCount: 3, Groups: [ { Key: '2026-03-01 00:00:00', Count: 9 }, { Key: '2025-12-01 00:00:00', Count: 7 }, { Key: '2026-01-01', Count: 1 } ], Bounds: { Lo: '2025-12-31 23:10:00', Hi: '2026-03-05T08:00:00Z' } };
						let tmpResult = libFacetEnvelope.buildFacetResult(DATE_AGG, tmpRaw, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Label, pBucket.Count, pBucket.End ]; })).to.deep.equal(
							[
								[ '2025-12-01 00:00:00', 'Dec 2025', 7, '2026-01-01 00:00:00' ],
								[ '2026-01-01 00:00:00', 'Jan 2026', 1, '2026-02-01 00:00:00' ],
								[ '2026-02-01 00:00:00', 'Feb 2026', 0, '2026-03-01 00:00:00' ],
								[ '2026-03-01 00:00:00', 'Mar 2026', 9, '2026-04-01 00:00:00' ]
							]);
						Expect(tmpResult.Buckets[2]).to.deep.equal(
							{
								Key: '2026-02-01 00:00:00', Label: 'Feb 2026', Count: 0, Selected: false, Start: '2026-02-01 00:00:00', End: '2026-03-01 00:00:00', EndExclusive: true,
								Clause: { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2026-02-01 00:00:00', End: '2026-03-01 00:00:00' }, EndExclusive: true, FilterKey: 'SaleDate', ClauseKey: 'DateRange' },
								Selection: { Facet: 'BookStoreSale.SaleDate', Key: '2026-02-01 00:00:00' }
							});
						Expect(tmpResult).to.include({ Interval: 'month', TimeZone: 'UTC', DataType: 'DateTime', Total: 20, SumOfCounts: 17, MissingCount: 3, OtherCount: 0, Truncated: false });
						Expect(tmpResult.Bounds).to.deep.equal({ Lo: '2025-12-31 23:10:00', Hi: '2026-03-05 08:00:00' });
					});

				test('DateHistogram: no gap fill when EmptyBuckets is false, KeyDesc, selection, empty data',
					() =>
					{
						let tmpRaw = { Total: 16, MissingCount: 0, Groups: [ { Key: '2026-03-01 00:00:00', Count: 9 }, { Key: '2025-12-01 00:00:00', Count: 7 } ], Bounds: { Lo: '2025-12-02 00:00:00', Hi: '2026-03-05 00:00:00' } };
						Expect(libFacetEnvelope.buildFacetResult(Object.assign({}, DATE_AGG, { EmptyBuckets: false }), tmpRaw, POST).Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ '2025-12-01 00:00:00', '2026-03-01 00:00:00' ]);
						Expect(libFacetEnvelope.buildFacetResult(Object.assign({}, DATE_AGG, { Order: 'KeyDesc' }), tmpRaw, POST).Buckets[0].Key).to.equal('2026-03-01 00:00:00');
						let tmpOwned = [ conjunct('c1', { And: [ { Field: 'SaleDate', Op: 'GE', Value: '2026-01-01 00:00:00' }, { Field: 'SaleDate', Op: 'LT', Value: '2026-03-01 00:00:00' } ] }) ];
						Expect(libFacetEnvelope.buildFacetResult(DATE_AGG, tmpRaw, postWith(tmpOwned)).Buckets.map((pBucket) => { return pBucket.Selected; })).to.deep.equal([ false, true, true, false ]);
						let tmpEmpty = libFacetEnvelope.buildFacetResult(DATE_AGG, { Total: 2, MissingCount: 2, Groups: [], Bounds: null }, POST);
						Expect(tmpEmpty).to.include({ Total: 2, MissingCount: 2, SumOfCounts: 0, OtherCount: 0, Bounds: null });
						Expect(tmpEmpty.Buckets).to.deep.equal([]);
						// Groups without Bounds still fill between their own keys.
						Expect(libFacetEnvelope.buildFacetResult(DATE_AGG, { Total: 16, Groups: tmpRaw.Groups }, POST).Buckets).to.have.length(4);
					});

				test('DateHistogram: too many buckets is FACET_INTERVAL_TOO_FINE with a coarser Suggest',
					() =>
					{
						let tmpDayAgg = Object.assign({}, DATE_AGG, { Dimensions: [ { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'day' } ] });
						let tmpRaw = { Total: 2, Groups: [ { Key: '2024-01-01 00:00:00', Count: 1 }, { Key: '2026-01-01 00:00:00', Count: 1 } ], Bounds: { Lo: '2024-01-01 00:00:00', Hi: '2026-01-01 00:00:00' } };
						let tmpError = expectFacetError(() => { libFacetEnvelope.buildFacetResult(tmpDayAgg, tmpRaw, POST); }, 'FACET_INTERVAL_TOO_FINE');
						Expect(tmpError.Detail.Suggest).to.deep.equal({ Interval: 'week' });
						let tmpSparse = { Total: 3, Groups: [ { Key: '2026-01-01', Count: 1 }, { Key: '2026-01-02', Count: 1 }, { Key: '2026-01-03', Count: 1 } ] };
						expectFacetError(() => { libFacetEnvelope.buildFacetResult(Object.assign({}, tmpDayAgg, { EmptyBuckets: false }), tmpSparse, Object.assign({}, POST, { Limits: { MaxDateBuckets: 2 } })); }, 'FACET_INTERVAL_TOO_FINE');
						Expect(libFacetEnvelope.buildFacetResult(tmpDayAgg, tmpRaw, Object.assign({}, POST, { Limits: { MaxDateBuckets: 800 } })).Buckets).to.have.length(732);
					});

				test('NumericHistogram: zero-filled indexes, closed last bucket, geometry projection',
					() =>
					{
						let tmpAgg = agg(
							{
								Key: 'Amount', FacetID: 'BookStoreSale.TotalAmount', Kind: 'NumericHistogram', Field: 'TotalAmount', ClauseType: 'NumericRange', FilterKey: 'TotalAmount',
								Dimensions: [ { Kind: 'NumericBucket', Field: 'TotalAmount', Mode: 'Nice', Buckets: 4, Edges: null, OpenEnded: false, IsInteger: false, Scale: 2 } ], Order: null
							});
						let tmpGeometry = libFacetBuckets.numericGeometry(1.5, 37.25, 4, 2, 500);
						Expect(tmpGeometry.Edges).to.deep.equal([ 0, 10, 20, 30, 40 ]);
						let tmpRaw = { Total: 12, MissingCount: 2, Bounds: { Lo: 1.5, Hi: 37.25 }, Geometry: tmpGeometry, Groups: [ { Key: 0, Count: 4 }, { Key: '3', Count: 5 }, { Key: 9, Count: 99 } ] };
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count, pBucket.Label, pBucket.EndExclusive ]; })).to.deep.equal(
							[ [ 0, 4, `0${DASH}<10`, true ], [ 1, 0, `10${DASH}<20`, true ], [ 2, 0, `20${DASH}<30`, true ], [ 3, 5, `30${DASH}40`, false ] ]);
						Expect(tmpResult.Buckets[3].Clause).to.deep.equal({ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 30, End: 40 }, EndExclusive: false, FilterKey: 'TotalAmount', ClauseKey: 'NumericRange' });
						Expect(tmpResult.Geometry).to.deep.equal({ Mode: 'Nice', Lo: 1.5, Hi: 37.25, Width: 10, N: 4, Scale: 2, Edges: [ 0, 10, 20, 30, 40 ] });
						Expect(tmpResult).to.include({ DataType: 'Decimal', Total: 12, SumOfCounts: 9, MissingCount: 2, OtherCount: 1 });
						Expect(tmpResult.Bounds).to.deep.equal({ Lo: 1.5, Hi: 37.25 });
						// Without a raw Geometry the same geometry is computed from Bounds and the Dim.
						let tmpComputed = libFacetEnvelope.buildFacetResult(tmpAgg, Object.assign({}, tmpRaw, { Geometry: null }), POST);
						Expect(tmpComputed.Geometry).to.deep.equal(tmpResult.Geometry);
						Expect(libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 2, MissingCount: 2, Bounds: null, Groups: [] }, POST)).to.include({ SumOfCounts: 0, OtherCount: 0 });
					});

				test('NumericHistogram Edges mode: rows outside the edges are OtherCount; open bucket clause has only Start',
					() =>
					{
						let tmpAgg = agg(
							{
								Key: 'Years', FacetID: 'Book.PublicationYear', Kind: 'NumericHistogram', Field: 'PublicationYear', ClauseType: 'NumericRange', FilterKey: 'PublicationYear',
								Dimensions: [ { Kind: 'NumericBucket', Field: 'PublicationYear', Mode: 'Edges', Buckets: null, Edges: [ 1800, 1900, 2000 ], OpenEnded: true, IsInteger: true, Scale: 0 } ]
							});
						let tmpRaw = { Total: 30, MissingCount: 5, Bounds: { Lo: -37, Hi: 2025 }, Groups: [ { Key: 0, Count: 3 }, { Key: 1, Count: 10 }, { Key: 2, Count: 11 } ] };
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, POST);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Label, pBucket.Count ]; })).to.deep.equal([ [ `1800${DASH}1899`, 3 ], [ `1900${DASH}1999`, 10 ], [ '2000+', 11 ] ]);
						Expect(tmpResult.Buckets[2]).to.not.have.property('End');
						Expect(tmpResult.Buckets[2].Clause.Values).to.deep.equal({ Start: 2000 });
						Expect(tmpResult).to.include({ SumOfCounts: 24, MissingCount: 5, OtherCount: 1, DataType: 'Numeric' });
						Expect(tmpResult.Geometry).to.deep.equal({ Mode: 'Edges', Lo: 1800, Hi: null, Width: null, N: 3, Scale: 0, Edges: [ 1800, 1900, 2000 ], OpenEnded: true });
					});

				test('Ranges: one bucket per declared range, in order, zero-filled',
					() =>
					{
						let tmpRanges = [ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'mid', From: 3, To: 5, Label: null }, { Key: 'top', From: 5, To: null, Label: null } ];
						let tmpAgg = agg(
							{
								Key: 'Bands', FacetID: 'Review.Rating', Kind: 'Ranges', Field: 'Rating', ClauseType: 'NumericRange', FilterKey: 'Rating',
								Dimensions: [ { Kind: 'Range', Field: 'Rating', Ranges: tmpRanges, IsInteger: true, Scale: 0 } ]
							});
						let tmpOwned = [ conjunct('c1', { Field: 'Rating', Op: 'GE', Value: 3 }) ];
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 10, MissingCount: 1, Groups: [ { Key: 'top', Count: 6 }, { Key: 'low', Count: 3 } ] }, postWith(tmpOwned));
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Label, pBucket.Count, pBucket.Selected ]; })).to.deep.equal(
							[ [ 'low', 'Low', 3, false ], [ 'mid', `3${DASH}4`, 0, true ], [ 'top', '5+', 6, true ] ]);
						Expect(tmpResult.Buckets[0]).to.not.have.property('Start');
						Expect(tmpResult.Buckets[0].Clause.Values).to.deep.equal({ End: 3 });
						Expect(tmpResult.Buckets[1].Clause.Values).to.deep.equal({ Start: 3, End: 5 });
						Expect(tmpResult).to.include({ SumOfCounts: 9, MissingCount: 1, OtherCount: 0 });
					});
			}
		);

		suite
		(
			'Envelope: Stats, DistinctCount, Missing, Pivot',
			() =>
			{
				test('Stats on a Decimal: exact strings at the column scale, Avg as a number',
					() =>
					{
						let tmpAgg = agg({ Key: 'Amounts', Kind: 'Stats', Dimensions: [], Field: 'TotalAmount', FieldInfo: { DataType: 'Decimal', IsInteger: false, Scale: 2 }, Selectable: false, ClauseType: null, Disjunctive: { Mode: 'NotApplicable', Excluded: [], ExcludedHashes: [], KeptMixed: [], Owned: [] } });
						let tmpRaw = { Total: 5, MissingCount: 1, Stats: { Rows: 5, NonNull: 4, Min: 0.1, Max: 8.4, SumUnits: 1001, Factor: 100 } };
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, POST);
						Expect(tmpResult.Stats).to.deep.equal({ Rows: 5, NonNull: 4, Min: '0.10', Max: '8.40', Sum: '10.01', Avg: 2.5025 });
						Expect(tmpResult).to.include({ Total: 5, MissingCount: 1, SumOfCounts: 0, OtherCount: 0, DataType: 'Decimal', Selectable: false });
						Expect(tmpResult.Buckets).to.deep.equal([]);
						let tmpNone = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 2, Stats: { Rows: 2, NonNull: 0, Min: null, Max: null, SumUnits: 0, Factor: 100 } }, POST);
						Expect(tmpNone.Stats).to.deep.equal({ Rows: 2, NonNull: 0, Min: null, Max: null, Sum: null, Avg: null });
						Expect(tmpNone.MissingCount).to.equal(2);
						let tmpNegative = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 2, Stats: { Rows: 2, NonNull: 2, Min: '-3.50', Max: '1.25', SumUnits: -225, Factor: 100 } }, POST);
						Expect(tmpNegative.Stats).to.deep.equal({ Rows: 2, NonNull: 2, Min: '-3.50', Max: '1.25', Sum: '-2.25', Avg: -1.125 });
					});

				test('Stats on integers and DateTimes',
					() =>
					{
						let tmpInteger = agg({ Kind: 'Stats', Dimensions: [], Field: 'Rating', FieldInfo: { DataType: 'Numeric', IsInteger: true, Scale: 0 }, Selectable: false });
						Expect(libFacetEnvelope.buildFacetResult(tmpInteger, { Total: 4, Stats: { Rows: 4, NonNull: 3, Min: 1, Max: '5', SumUnits: 10, Factor: 1 } }, POST).Stats).to.deep.equal(
							{ Rows: 4, NonNull: 3, Min: 1, Max: 5, Sum: 10, Avg: 3.3333 });
						let tmpDate = agg({ Kind: 'Stats', Dimensions: [], Field: 'SaleDate', FieldInfo: { DataType: 'DateTime', IsInteger: false, Scale: 0 }, Selectable: false });
						Expect(libFacetEnvelope.buildFacetResult(tmpDate, { Total: 4, Stats: { Rows: 4, NonNull: 3, Min: '2025-07-01T00:00:00Z', Max: '2026-06-30 23:10:00', SumUnits: null, Factor: 1 } }, POST).Stats).to.deep.equal(
							{ Rows: 4, NonNull: 3, Min: '2025-07-01 00:00:00', Max: '2026-06-30 23:10:00', Sum: null, Avg: null });
					});

				test('DistinctCount and Missing',
					() =>
					{
						let tmpDistinct = libFacetEnvelope.buildFacetResult(agg({ Kind: 'DistinctCount', Dimensions: [], FieldInfo: { DataType: 'String' }, Selectable: false }), { Total: 40, MissingCount: 3, DistinctCount: 7 }, POST);
						Expect(tmpDistinct).to.include({ Fold: 'DistinctCount', Total: 40, MissingCount: 3, DistinctCount: 7, SumOfCounts: 0, OtherCount: 0 });
						let tmpMissing = libFacetEnvelope.buildFacetResult(agg({ Kind: 'Missing', Dimensions: [], FieldInfo: { DataType: 'String' }, Selectable: false, Missing: false }), { Total: 40, MissingCount: 3 }, POST);
						Expect(tmpMissing).to.include({ Fold: 'Missing', Total: 40, MissingCount: 3, SumOfCounts: 0, OtherCount: 0 });
						Expect(libFacetEnvelope.buildFacetResult(agg({ Key: '#Total', Kind: 'Count', Dimensions: [], Field: null, Selectable: false }), { Total: 99 }, POST)).to.include({ Total: 99, Fold: 'Count', DataType: null });
						expectFacetError(() => { libFacetEnvelope.buildFacetResult(agg({ Kind: 'Nope' }), { Total: 1 }, POST); }, 'FACET_INTERNAL');
						expectFacetError(() => { libFacetEnvelope.buildFacetResult(agg({}), null, POST); }, 'FACET_INTERNAL');
					});

				test('Pivot: marginals, Top per axis, null keys into MissingCount, Chart',
					() =>
					{
						let tmpRanges = [ { Key: 'low', From: null, To: 3, Label: 'Low' }, { Key: 'high', From: 3, To: null, Label: 'High' } ];
						let tmpAgg = agg(
							{
								Key: 'PayByMonth', FacetID: 'BookStoreSale.PaymentMethod|BookStoreSale.SaleDate', FacetIDs: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ],
								Kind: 'Pivot', Field: null, Selectable: false, ClauseType: null, FilterKey: null, Top: 2, Chart: true, DisplayName: 'Pay by month',
								Dimensions: [ { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'month' } ]
							});
						let tmpRaw =
							{
								Total: 40,
								Cells:
								[
									{ Keys: [ 'Credit', '2026-02-01 00:00:00' ], Count: 10 },
									{ Keys: [ 'Credit', '2026-01-01 00:00:00' ], Count: 5 },
									{ Keys: [ 'Cash', '2026-01-01' ], Count: 6 },
									{ Keys: [ 'Gift', '2026-03-01 00:00:00' ], Count: 2 },
									{ Keys: [ 'Credit', null ], Count: 4 },
									{ Keys: [ null, '2026-01-01 00:00:00' ], Count: 3 },
									{ Keys: [ 'Cash', '2026-03-01 00:00:00' ], Count: 7 },
									{ Keys: [ 'Credit', '2026-01-01 00:00:00' ], Count: 3 }
								]
							};
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, tmpRaw, POST);
						// 02 §4.3: the pivot fields sit at the FacetResult top level.
						Expect({ Dimensions: tmpResult.Dimensions, RowKeys: tmpResult.RowKeys, ColumnKeys: tmpResult.ColumnKeys, Cells: tmpResult.Cells, Marginals: tmpResult.Marginals }).to.deep.equal(
							{
								Dimensions:
								[
									{ Facet: 'BookStoreSale.PaymentMethod', Field: 'PaymentMethod', Fold: 'Terms', Interval: null },
									{ Facet: 'BookStoreSale.SaleDate', Field: 'SaleDate', Fold: 'DateHistogram', Interval: 'month' }
								],
								RowKeys: [ 'Credit', 'Cash' ],
								ColumnKeys: [ '2026-01-01 00:00:00', '2026-02-01 00:00:00' ],
								Cells:
								[
									{ K1: 'Credit', K2: '2026-01-01 00:00:00', Count: 8 },
									{ K1: 'Credit', K2: '2026-02-01 00:00:00', Count: 10 },
									{ K1: 'Cash', K2: '2026-01-01 00:00:00', Count: 6 }
								],
								Marginals:
								{
									Rows: [ { Key: 'Credit', Count: 18 }, { Key: 'Cash', Count: 13 } ],
									Columns: [ { Key: '2026-01-01 00:00:00', Count: 14 }, { Key: '2026-02-01 00:00:00', Count: 10 } ],
									Total: 24
								}
							});
						Expect(tmpResult).to.not.have.property('Pivot');
						Expect(tmpResult).to.include({ Fold: 'Pivot', Total: 40, MissingCount: 7, SumOfCounts: 24, OtherCount: 9, Truncated: true, TruncatedReason: 'Top' });
						Expect(tmpResult.Facet).to.deep.equal([ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ]);
						Expect(tmpResult.Buckets).to.deep.equal([]);
						Expect(tmpResult.Chart).to.deep.equal({ Labels: [ 'Credit', 'Cash' ], Datasets: [ { label: 'Jan 2026', data: [ 8, 6 ] }, { label: 'Feb 2026', data: [ 10, 0 ] } ] });
						// Range axes keep declared order and labels.
						let tmpRangeAgg = Object.assign({}, tmpAgg, { Top: 10, Dimensions: [ { Kind: 'Range', Field: 'Rating', Ranges: tmpRanges, IsInteger: true }, { Kind: 'Column', Field: 'PaymentMethod', DataType: 'String' } ] });
						let tmpRangeResult = libFacetEnvelope.buildFacetResult(tmpRangeAgg, { Total: 9, Cells: [ { Keys: [ 'high', 'Cash' ], Count: 5 }, { Keys: [ 'low', 'Cash' ], Count: 1 }, { Keys: [ 'low', 'Gift' ], Count: 3 } ] }, POST);
						Expect(tmpRangeResult.RowKeys).to.deep.equal([ 'low', 'high' ]);
						Expect(tmpRangeResult.ColumnKeys).to.deep.equal([ 'Cash', 'Gift' ]);
						Expect(tmpRangeResult.Chart.Labels).to.deep.equal([ 'Low', 'High' ]);
						Expect(tmpRangeResult).to.include({ Truncated: false, SumOfCounts: 9, OtherCount: 0, MissingCount: 0 });
						// A Range-axis value in no declared range is Other (as in the Ranges fold), a NULL is Missing.
						let tmpNoRange = libFacetEnvelope.buildFacetResult(tmpRangeAgg,
							{ Total: 14, Cells: [ { Keys: [ 'high', 'Cash' ], Count: 5 }, { Keys: [ libFacetBuckets.NO_RANGE_KEY, 'Cash' ], Count: 4 }, { Keys: [ null, 'Gift' ], Count: 2 }, { Keys: [ libFacetBuckets.NO_RANGE_KEY, null ], Count: 3 } ] }, POST);
						Expect(tmpNoRange).to.include({ SumOfCounts: 5, MissingCount: 5, OtherCount: 4 });
						Expect(tmpNoRange.RowKeys).to.deep.equal([ 'high' ]);
						Expect(tmpNoRange.Marginals).to.deep.equal({ Rows: [ { Key: 'high', Count: 5 } ], Columns: [ { Key: 'Cash', Count: 5 } ], Total: 5 });
						expectFacetError(() => { libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Dimensions: [ tmpAgg.Dimensions[0] ] }), tmpRaw, POST); }, 'FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'Envelope: assembly and comparison',
			() =>
			{
				test('buildEnvelope assembles the M1 envelope; Total only when computed',
					() =>
					{
						let tmpFilterAST = { Applied: [ { Hash: 'h1' }, { String: true } ], Warnings: [ { Code: 'FACET_SORT_IGNORED', Detail: 'x' } ], IncludesDeleted: false };
						let tmpEnvelope = libFacetEnvelope.buildEnvelope(
							{
								Entity: 'BookStoreSale', Version: 'fv1:abc', ModelVersion: 'm:123', Engine: 'Live', Exact: true, AsOf: POST.AsOf, ElapsedMS: 12,
								Total: 1834, FilterAST: tmpFilterAST, Facets: { A: { Key: 'A' } }, Errors: { B: { Code: 'FACET_TIMEOUT', Status: 504, Message: 'm' } }, Warnings: [ { Code: 'FACET_TOP_CLAMPED' } ]
							});
						Expect(tmpEnvelope).to.deep.equal(
							{
								ContractVersion: 1, Entity: 'BookStoreSale', Version: 'fv1:abc', ModelVersion: 'm:123', Engine: 'Live', Exact: true, AsOf: POST.AsOf,
								LagMS: 0, Stale: false, Cached: false, ElapsedMS: 12, Total: 1834, TotalCountMode: 'Rows', IncludesDeleted: false,
								Filter: { Applied: [ { Hash: 'h1' }, { String: true } ], Warnings: [ { Code: 'FACET_SORT_IGNORED', Detail: 'x' } ] },
								Facets: { A: { Key: 'A' } }, Errors: { B: { Code: 'FACET_TIMEOUT', Status: 504, Message: 'm' } }, Warnings: [ { Code: 'FACET_TOP_CLAMPED' } ]
							});
						let tmpNoTotal = libFacetEnvelope.buildEnvelope({ Entity: 'Book', FilterAST: { IncludesDeleted: true } });
						Expect(tmpNoTotal).to.not.have.property('Total');
						Expect(tmpNoTotal).to.not.have.property('TotalCountMode');
						Expect(tmpNoTotal).to.include({ IncludesDeleted: true, ContractVersion: libFacetRequest.CONTRACT_VERSION });
						Expect(tmpNoTotal.Filter).to.deep.equal({ Applied: [], Warnings: [] });
						Expect(tmpNoTotal.Facets).to.deep.equal({});
						Expect(tmpNoTotal.Errors).to.deep.equal({});
						Expect(libFacetEnvelope.buildEnvelope({ IncludesDeleted: false, FilterAST: { IncludesDeleted: true } }).IncludesDeleted).to.equal(false);
					});

				test('requestFailure: only when every facet and the requested Total failed',
					() =>
					{
						let tmpTimeout = { Code: 'FACET_TIMEOUT', Status: 504, Message: 'm' };
						Expect(libFacetEnvelope.requestFailure({ Facets: { A: {} }, Errors: { B: tmpTimeout } }, true)).to.equal(null);
						Expect(libFacetEnvelope.requestFailure({ Facets: {}, Errors: {}, Total: 3 }, true)).to.equal(null);
						Expect(libFacetEnvelope.requestFailure({ Facets: {}, Errors: { B: tmpTimeout }, Total: 3 }, true)).to.equal(null);
						Expect(libFacetEnvelope.requestFailure({ Facets: {}, Errors: { B: tmpTimeout }, Total: 3 }, false)).to.equal(tmpTimeout);
						Expect(libFacetEnvelope.requestFailure({ Facets: {}, Errors: { B: tmpTimeout, '#Total': { Code: 'FACET_INTERNAL', Status: 500 } } }, true)).to.equal(tmpTimeout);
						Expect(libFacetEnvelope.requestFailure(null, true)).to.equal(null);
					});

				test('normalizeForComparison strips volatile fields only, without mutating',
					() =>
					{
						let tmpFacet = libFacetEnvelope.buildFacetResult(agg({}), { Total: 3, MissingCount: 0, Groups: [ { Key: 'a', Count: 3 } ] }, POST);
						let tmpEnvelope = libFacetEnvelope.buildEnvelope({ Entity: 'X', Version: 'fv1:1', Engine: 'Live', AsOf: 'now', ElapsedMS: 5, Total: 3, Facets: { K: tmpFacet } });
						let tmpNormalized = libFacetEnvelope.normalizeForComparison(tmpEnvelope);
						libFacetEnvelope.VOLATILE_FIELDS.forEach(
							(pField) =>
							{
								Expect(tmpNormalized, pField).to.not.have.property(pField);
								Expect(tmpNormalized.Facets.K, pField).to.not.have.property(pField);
							});
						Expect(tmpNormalized.Facets.K.Buckets).to.deep.equal(tmpFacet.Buckets);
						Expect(tmpNormalized.Total).to.equal(3);
						Expect(tmpEnvelope.Version).to.equal('fv1:1');
						Expect(tmpFacet.Engine).to.equal('Live');
						let tmpOther = libFacetEnvelope.buildEnvelope({ Entity: 'X', Version: 'ref:v0', Engine: 'Reference', AsOf: 'later', ElapsedMS: 99, Total: 3, Facets: { K: libFacetEnvelope.buildFacetResult(agg({}), { Total: 3, MissingCount: 0, Groups: [ { Key: 'a', Count: 3 } ] }, Object.assign({}, POST, { Engine: 'Reference', AsOf: 'later' })) } });
						Expect(libFacetEnvelope.normalizeForComparison(tmpOther)).to.deep.equal(tmpNormalized);
						Expect(libFacetEnvelope.normalizeForComparison(null)).to.equal(null);
					});

				test('emptyFacetResult carries every M1 field',
					() =>
					{
						let tmpEmpty = libFacetEnvelope.emptyFacetResult(agg({}));
						[ 'Key', 'Facet', 'Field', 'Fold', 'DisplayName', 'DataType', 'Selectable', 'ClauseType', 'FilterKey', 'Engine', 'Exact', 'AsOf', 'LagMS', 'Stale', 'Cached',
							'Disjunctive', 'Excluded', 'KeptMixed', 'CountMode', 'Total', 'SumOfCounts', 'MissingCount', 'OtherCount', 'MultiValued', 'Truncated', 'TruncatedReason',
							'DistinctCount', 'Bounds', 'Buckets', 'Stats', 'Geometry', 'Chart' ].forEach(
							(pField) =>
							{
								Expect(tmpEmpty, pField).to.have.property(pField);
							});
						// The pivot fields (Dimensions, RowKeys, ColumnKeys, Cells, Marginals) appear only on Pivot results.
						Expect(tmpEmpty).to.not.have.property('Cells');
					});
			}
		);
	}
);
