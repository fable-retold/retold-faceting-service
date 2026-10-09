/**
 * Facet-Live-Bookstore (wiring): the faceting service end to end over HTTP on a plain
 * retold-data-service (Embedded) with the seeded Bookstore on in-memory SQLite.
 *
 *   - Describe (both route forms), its per-principal filtering and the unknown-entity 404;
 *   - the request pipeline's error mapping (whole-request vs per-facet, internal-contracts §2 / §13);
 *   - response headers, Version / weak ETag stability and If-None-Match → 304;
 *   - FK labels from scoped reads, selected-zero and selected-below-Top Terms buckets;
 *   - Variant sharing (facets with the same effective filter share one Scoped Relation);
 *   - restify discipline (handlers return undefined and call fNext exactly once).
 *
 * Port 19110 (internal-contracts §14.4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');

const PORT = 19110;

suite
(
	'Facet-Live-Bookstore',
	() =>
	{
		let _Harness = null;

		suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' }, fDone); });
		suiteTeardown((fDone) => { _Harness.stop(fDone); });

		/**
		 * POST a query and hand back the response (assertions run outside the fetch promise).
		 */
		let fQuery = (pEntity, pBody, pOptions, fCallback) =>
		{
			_Harness.facetQuery(pEntity, pBody, pOptions || {},
				(pError, pResponse) =>
				{
					Expect(pError).to.not.exist;
					return fCallback(pResponse);
				});
		};

		/**
		 * The whole-request error of a response.
		 */
		let fExpectError = (pResponse, pStatus, pCode) =>
		{
			Expect(pResponse.Status, JSON.stringify(pResponse.Body)).to.equal(pStatus);
			Expect(pResponse.Body.Error.Code).to.equal(pCode);
			Expect(pResponse.Body.Error.Status).to.equal(pStatus);
			Expect(pResponse.Headers['x-retold-facet-contract']).to.equal('1');
		};

		// ---------------------------------------------------------------- Describe
		suite
		(
			'Describe',
			() =>
			{
				test('GET /1.0/Facet/Describe lists every facetable entity with the manifest header fields',
					(fDone) =>
					{
						_Harness.request('GET', '/1.0/Facet/Describe', null, {},
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								let tmpDescribe = pResponse.Body;
								Expect(tmpDescribe).to.include({ ContractVersion: 1, Role: 'Embedded', ScopeAssurance: 'Unscoped' });
								Expect(tmpDescribe.ModelVersion).to.match(/^m:[0-9a-f]{12}$/);
								Expect(tmpDescribe.TimeZones).to.deep.equal([ 'UTC' ]);
								Expect(tmpDescribe.Limits).to.include({ MaxFacets: 20, MaxTop: 500, MaxDateBuckets: 400 });
								Expect(tmpDescribe.Engines.Live).to.deep.equal({ Available: true, Dialect: 'SQLite' });
								[ 'Book', 'Review', 'BookStoreSale', 'BookStoreEmployee', 'User', 'BookStoreCatalogJoin' ].forEach(
									(pEntity) => { Expect(tmpDescribe.Entities, pEntity).to.have.property(pEntity); });
								Expect(pResponse.Headers['x-retold-facet-contract']).to.equal('1');
								Expect(pResponse.Headers['cache-control']).to.equal('private, no-cache');
								// Sensitive columns never appear anywhere in Describe.
								Expect(JSON.stringify(tmpDescribe)).to.not.include('Password');
								Expect(JSON.stringify(tmpDescribe)).to.not.include('LabelLookup');
								return fDone();
							});
					});

				test('GET /1.0/Facet/Book/Describe and /1.0/Facet/Describe/Book return the same entity manifest',
					(fDone) =>
					{
						_Harness.request('GET', '/1.0/Facet/Book/Describe', null, {},
							(pError, pFirst) =>
							{
								Expect(pError).to.not.exist;
								Expect(pFirst.Status).to.equal(200);
								_Harness.request('GET', '/1.0/Facet/Describe/Book', null, {},
									(pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.not.exist;
										Expect(pSecond.Body).to.deep.equal(pFirst.Body);
										let tmpBook = pFirst.Body.Entities.Book;
										Expect(pFirst.Body.Entity).to.equal('Book');
										Expect(Object.keys(pFirst.Body.Entities)).to.deep.equal([ 'Book' ]);
										let tmpYear = tmpBook.Facets.find((pFacet) => { return pFacet.Facet === 'Book.PublicationYear'; });
										Expect(tmpYear).to.include({ DefaultFold: 'NumericHistogram', ClauseType: 'NumericRange', Selectable: true });
										Expect(tmpBook.Facets.find((pFacet) => { return pFacet.Facet === 'Book.Language'; })).to.include({ DefaultFold: 'Terms', ClauseType: 'DistinctSelectedValueList' });
										Expect(tmpBook.Facets.find((pFacet) => { return pFacet.Facet === 'Book.Title'; })).to.equal(undefined);
										return fDone();
									});
							});
					});

				test('FK facets advertise labels and their target',
					(fDone) =>
					{
						_Harness.request('GET', '/1.0/Facet/BookStoreSale/Describe', null, {},
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								let tmpStore = pResponse.Body.Entities.BookStoreSale.Facets.find((pFacet) => { return pFacet.Facet === 'BookStoreSale.IDBookStore'; });
								Expect(tmpStore).to.include({ Target: 'BookStore', Labels: true, DisplayName: 'Book Store' });
								return fDone();
							});
					});

				test('an unknown or never-facetable entity is 404 FACET_UNKNOWN_ENTITY on Describe and Query alike',
					(fDone) =>
					{
						_Harness.request('GET', '/1.0/Facet/Nope/Describe', null, {},
							(pError, pDescribe) =>
							{
								Expect(pError).to.not.exist;
								fExpectError(pDescribe, 404, 'FACET_UNKNOWN_ENTITY');
								fQuery('Nope', { Facets: [ { Facet: 'Nope.X' } ] }, {},
									(pQuery) =>
									{
										fExpectError(pQuery, 404, 'FACET_UNKNOWN_ENTITY');
										fQuery('Account', { Facets: [ { Facet: 'Account.Name' } ] }, {},
											(pAccount) =>
											{
												fExpectError(pAccount, 404, 'FACET_UNKNOWN_ENTITY');
												return fDone();
											});
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- envelope, headers, ETag
		suite
		(
			'Envelope, headers and Version',
			() =>
			{
				const BODY =
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'eng' ], Hash: 'lang-eng' } ],
						Facets: [ { Key: 'Year', Facet: 'Book.PublicationYear' }, { Key: 'Lang', Facet: 'Book.Language' } ]
					};

				test('a Live envelope carries every M1 field and the standard headers; Total equals the list Count',
					(fDone) =>
					{
						fQuery('Book', BODY, {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpEnvelope = pResponse.Body;
								Expect(tmpEnvelope).to.include({ ContractVersion: 1, Entity: 'Book', Engine: 'Live', Exact: true, LagMS: 0, Stale: false, Cached: false, TotalCountMode: 'Rows', IncludesDeleted: false });
								Expect(tmpEnvelope.Version).to.match(/^fv1:[0-9a-f]{16}$/);
								Expect(tmpEnvelope.ModelVersion).to.match(/^m:[0-9a-f]{12}$/);
								Expect(Date.parse(tmpEnvelope.AsOf)).to.be.a('number');
								Expect(tmpEnvelope.Filter.Applied).to.deep.equal([ { Hash: 'lang-eng' } ]);
								Expect(tmpEnvelope.Errors).to.deep.equal({});
								Expect(pResponse.Headers.etag).to.equal(`W/"${tmpEnvelope.Version}"`);
								Expect(pResponse.Headers['cache-control']).to.equal('private, no-cache');
								Expect(pResponse.Headers.vary).to.equal('Cookie, Authorization');
								Expect(pResponse.Headers['x-retold-facet-contract']).to.equal('1');
								Expect(pResponse.Headers).to.not.have.property('x-retold-facet-scope-repaired');
								let tmpLang = tmpEnvelope.Facets.Lang;
								Expect(tmpLang).to.include({ Fold: 'Terms', Disjunctive: 'Exact', Selectable: true, ClauseType: 'DistinctSelectedValueList', FilterKey: 'Language' });
								Expect(tmpLang.Excluded).to.deep.equal([ 'lang-eng' ]);
								Expect(tmpLang.Buckets.find((pBucket) => { return pBucket.Key === 'eng'; }).Selected).to.equal(true);
								Expect(tmpEnvelope.Facets.Year.Disjunctive).to.equal('Exact');
								Expect(tmpEnvelope.Facets.Year.Total).to.equal(tmpEnvelope.Total);
								_Harness.listCount('Book', 'FBV~Language~EQ~eng', {},
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.not.exist;
										Expect(tmpEnvelope.Total).to.equal(pCount);
										return fDone();
									});
							});
					});

				test('Version is stable for the same request, changes with the filter, and If-None-Match answers 304',
					(fDone) =>
					{
						fQuery('Book', BODY, {},
							(pFirst) =>
							{
								fQuery('Book', BODY, {},
									(pSecond) =>
									{
										Expect(pSecond.Body.Version).to.equal(pFirst.Body.Version);
										let tmpOther = JSON.parse(JSON.stringify(BODY));
										tmpOther.Clauses[0].Values = [ 'fre' ];
										fQuery('Book', tmpOther, {},
											(pThird) =>
											{
												Expect(pThird.Body.Version).to.not.equal(pFirst.Body.Version);
												fQuery('Book', BODY, { Headers: { 'If-None-Match': `W/"${pFirst.Body.Version}"` } },
													(pNotModified) =>
													{
														Expect(pNotModified.Status).to.equal(304);
														Expect(pNotModified.Body === null || pNotModified.Body === '').to.equal(true);
														Expect(pNotModified.Headers.etag).to.equal(`W/"${pFirst.Body.Version}"`);
														fQuery('Book', BODY, { Headers: { 'If-None-Match': '"fv1:0000000000000000", "nope"' } },
															(pModified) =>
															{
																Expect(pModified.Status).to.equal(200);
																fQuery('Book', BODY, { Headers: { 'If-None-Match': `"other", "${pFirst.Body.Version}"` } },
																	(pStrongList) =>
																	{
																		Expect(pStrongList.Status).to.equal(304);
																		return fDone();
																	});
															});
													});
											});
									});
							});
					});

				test('the forced Reference engine is not reachable from a client body',
					(fDone) =>
					{
						fQuery('Book', Object.assign({ ForceEngine: 'Reference' }, BODY), {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.be.oneOf([ 200, 400 ]);
								if (pResponse.Status === 200)
								{
									Expect(pResponse.Body.Engine).to.equal('Live');
								}
								return fDone();
							});
					});
			}
		);

		// ---------------------------------------------------------------- errors
		suite
		(
			'Error mapping',
			() =>
			{
				test('request shape errors are whole-request 400s',
					(fDone) =>
					{
						fQuery('Book', { Facets: [] }, {},
							(pEmpty) =>
							{
								fExpectError(pEmpty, 400, 'FACET_REQUEST_INVALID');
								let tmpMany = { Facets: [] };
								for (let i = 0; i < 21; i++)
								{
									tmpMany.Facets.push({ Key: `F${i}`, Facet: 'Book.Language' });
								}
								fQuery('Book', tmpMany, {},
									(pMany) =>
									{
										fExpectError(pMany, 400, 'FACET_TOO_MANY_FACETS');
										fQuery('Book', [ 1, 2 ], {},
											(pArray) =>
											{
												fExpectError(pArray, 400, 'FACET_REQUEST_INVALID');
												fQuery('Book', { Facets: [ { Key: 'X', Facet: 'Book.Language', Fold: 'Nope' } ] }, {},
													(pFold) =>
													{
														fExpectError(pFold, 400, 'FACET_UNKNOWN_FOLD');
														return fDone();
													});
											});
									});
							});
					});

				test('a body that is not JSON, or over Limits.MaxBodyBytes, is answered in the facet error shape',
					(fDone) =>
					{
						_Harness.request('POST', '/1.0/Facet/Book/Query', '{ "Facets": [ ', {},
							(pError, pBroken) =>
							{
								Expect(pError).to.not.exist;
								fExpectError(pBroken, 400, 'FACET_REQUEST_INVALID');
								Expect(pBroken.Body.Error.Detail).to.deep.equal({ Reason: 'BodyNotJSON' });
								let tmpHuge = { Facets: [ { Facet: 'Book.Language' } ], Clauses: [ { Type: 'RawFilter', Value: `FBV~Language~EQ~${'x'.repeat(300000)}` } ] };
								_Harness.request('POST', '/1.0/Facet/Book/Query', tmpHuge, {},
									(pHugeError, pHuge) =>
									{
										Expect(pHugeError).to.not.exist;
										fExpectError(pHuge, 400, 'FACET_REQUEST_INVALID');
										Expect(pHuge.Body.Error.Detail).to.include({ Reason: 'BodyTooLarge', Limit: 'MaxBodyBytes' });
										return fDone();
									});
							});
					});

				test('filter errors are whole-request 400s (unknown and Sensitive fields, disallowed instructions)',
					(fDone) =>
					{
						fQuery('Book', { FilterString: 'FBV~Nope~EQ~1', Facets: [ { Facet: 'Book.Language' } ] }, {},
							(pUnknown) =>
							{
								fExpectError(pUnknown, 400, 'FACET_UNKNOWN_FIELD');
								fQuery('User', { FilterString: 'FBV~Password~EQ~x', Facets: [ { Facet: 'User.Config' } ] }, {},
									(pSensitive) =>
									{
										fExpectError(pSensitive, 400, 'FACET_UNKNOWN_FIELD');
										fQuery('Book', { FilterString: 'FBJ~IDBook~Review~IDBook', Facets: [ { Facet: 'Book.Language' } ] }, {},
											(pJoin) =>
											{
												fExpectError(pJoin, 400, 'FACET_FILTER_INVALID');
												fQuery('Book', { Clauses: [ { Type: 'InternalJoinSelectedValueList', Values: [ 1 ] } ], Facets: [ { Facet: 'Book.Language' } ] }, {},
													(pClause) =>
													{
														fExpectError(pClause, 400, 'FACET_FILTER_INVALID');
														return fDone();
													});
											});
									});
							});
					});

				test('later-milestone inputs are refused, never silently ignored',
					(fDone) =>
					{
						// M2: Scopes are accepted (shape-checked by the normalizer); a scope no definitions file
						// declares is 400 FACET_UNKNOWN_SCOPE, a malformed entry 400 FACET_REQUEST_INVALID.
						fQuery('Book', { Scopes: [ { Scope: 'Book.Mine' } ], Facets: [ { Facet: 'Book.Language' } ] }, {},
							(pScopes) =>
							{
								fExpectError(pScopes, 400, 'FACET_UNKNOWN_SCOPE');
								fQuery('Book', { Scopes: [ 'Book.Mine' ], Facets: [ { Facet: 'Book.Language' } ] }, {},
									(pMalformed) =>
									{
										fExpectError(pMalformed, 400, 'FACET_REQUEST_INVALID');
										fQuery('Book', { Facets: [ { Facet: 'Book.Language', Definition: { Field: 'Language' } } ] }, {},
											(pDefinition) =>
											{
												fExpectError(pDefinition, 403, 'FACET_ADHOC_FORBIDDEN');
												fQuery('Book', { Facets: [ { Facet: 'Book.CreateDate', TimeZone: 'America/Los_Angeles' } ] }, {},
													(pZone) =>
													{
														fExpectError(pZone, 422, 'FACET_TIMEZONE_UNSUPPORTED');
														return fDone();
													});
											});
									});
							});
					});

				test('per-facet errors keep the rest of the envelope (200), in request order',
					(fDone) =>
					{
						let tmpBody =
							{
								Facets:
									[
										{ Key: 'Good', Facet: 'Book.Language' },
										{ Key: 'Unknown', Facet: 'Book.Nope' },
										{ Key: 'WrongFold', Facet: 'Book.Language', Fold: 'DateHistogram' },
										{ Key: 'Path', Facet: 'Review.IDBook>Book.Language' },
										{ Key: 'Declared', Facet: 'Book.ByAuthor/Top' },
										{ Key: 'OtherEntity', Facet: 'Review.Rating' },
										{ Key: 'NoRanges', Facet: 'Book.PublicationYear', Fold: 'Ranges' },
										{ Key: 'NumericAxis', Facet: [ 'Book.Language', 'Book.PublicationYear' ], Fold: 'Pivot' },
										{ Key: 'Sensitive', Facet: 'Book.GUIDBook' }
									]
							};
						fQuery('Book', tmpBody, {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpEnvelope = pResponse.Body;
								Expect(Object.keys(tmpEnvelope.Facets)).to.deep.equal([ 'Good', 'NumericAxis' ]);
								Expect(Object.keys(tmpEnvelope.Errors)).to.deep.equal([ 'Unknown', 'WrongFold', 'Path', 'Declared', 'OtherEntity', 'NoRanges', 'Sensitive' ]);
								Expect(tmpEnvelope.Errors.Unknown).to.include({ Code: 'FACET_UNKNOWN_FACET', Status: 400 });
								Expect(tmpEnvelope.Errors.WrongFold).to.include({ Code: 'FACET_UNKNOWN_FOLD', Status: 400 });
								// M2 (internal-contracts §20.8): path FacetIDs resolve through the registry; this one is
								// homed on another entity (Review), so it is unknown on the Book route.
								Expect(tmpEnvelope.Errors.Path).to.include({ Code: 'FACET_UNKNOWN_FACET', Status: 400 });
								Expect(tmpEnvelope.Errors.Declared.Code).to.equal('FACET_UNKNOWN_FACET');
								Expect(tmpEnvelope.Errors.OtherEntity.Code).to.equal('FACET_UNKNOWN_FACET');
								Expect(tmpEnvelope.Errors.NoRanges.Code).to.equal('FACET_REQUEST_INVALID');
								Expect(tmpEnvelope.Errors.Sensitive.Code).to.equal('FACET_UNKNOWN_FACET');
								// An integer pivot axis without Ranges falls back to Terms (internal-contracts §5.2, wiring addition).
								Expect(tmpEnvelope.Facets.NumericAxis.Dimensions[1]).to.include({ Field: 'PublicationYear', Fold: 'Terms' });
								Expect(tmpEnvelope.Total).to.equal(_Harness.seed.LiveCounts.Book);
								return fDone();
							});
					});

				test('a decimal pivot axis without Ranges is refused per facet (422 NumericPivotAxis)',
					(fDone) =>
					{
						fQuery('BookStoreSale', { Facets: [ { Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.TotalAmount' ], Fold: 'Pivot' } ] }, {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Body.Errors.Cross).to.include({ Code: 'FACET_FOLD_UNSUPPORTED', Status: 422 });
								Expect(pResponse.Body.Errors.Cross.Detail.Feature).to.equal('NumericPivotAxis');
								return fDone();
							});
					});

				test('when every facet and the Total fail, the request fails with the first error',
					(fDone) =>
					{
						fQuery('Book', { Total: false, Facets: [ { Key: 'A', Facet: 'Book.Nope' }, { Key: 'B', Facet: 'Book.Language', Fold: 'Stats' } ] }, {},
							(pResponse) =>
							{
								fExpectError(pResponse, 400, 'FACET_UNKNOWN_FACET');
								Expect(pResponse.Body.Error.Detail).to.deep.equal({ Facet: 'Book.Nope' });
								Expect(pResponse.Headers).to.not.have.property('etag');
								return fDone();
							});
					});
			}
		);

		// ---------------------------------------------------------------- labels and selections
		suite
		(
			'Labels and selected buckets',
			() =>
			{
				test('FK Terms buckets are labelled from the target (scoped, soft-delete aware); Labels: false keeps the keys',
					(fDone) =>
					{
						let tmpStores = {};
						_Harness.db.prepare('SELECT IDBookStore AS K, Name AS N, Deleted AS D FROM BookStore').all().forEach((pRow) => { tmpStores[String(pRow.K)] = pRow; });
						let tmpBody = { Facets: [ { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 500, Chart: true }, { Key: 'Raw', Facet: 'BookStoreSale.IDBookStore', Top: 5, Labels: false } ] };
						fQuery('BookStoreSale', tmpBody, {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpStore = pResponse.Body.Facets.Store;
								let tmpResolved = 0;
								let tmpUnresolved = 0;
								tmpStore.Buckets.forEach(
									(pBucket) =>
									{
										let tmpRow = tmpStores[String(pBucket.Key)];
										if (tmpRow && (tmpRow.D === 0))
										{
											tmpResolved++;
											Expect(pBucket).to.include({ Label: tmpRow.N, LabelResolved: true });
										}
										else
										{
											// A soft-deleted or missing store is not visible to the list: unlabelled, never an error.
											tmpUnresolved++;
											Expect(pBucket).to.include({ Label: String(pBucket.Key), LabelResolved: false });
										}
									});
								Expect(tmpResolved).to.be.above(0);
								Expect(tmpUnresolved).to.be.above(0);
								Expect(tmpStore.Chart.Labels).to.deep.equal(tmpStore.Buckets.map((pBucket) => { return pBucket.Label; }));
								pResponse.Body.Facets.Raw.Buckets.forEach(
									(pBucket) =>
									{
										Expect(pBucket.Label).to.equal(String(pBucket.Key));
										Expect(pBucket).to.not.have.property('LabelResolved');
									});
								return fDone();
							});
					});

				test('a selected key with no rows comes back as a Count 0, Selected bucket (and round-trips)',
					(fDone) =>
					{
						let tmpBody =
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Barter' ] } ],
								Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Top: 2 } ]
							};
						fQuery('BookStoreSale', tmpBody, {},
							(pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpBarter = pResponse.Body.Facets.Pay.Buckets.find((pBucket) => { return pBucket.Key === 'Barter'; });
								Expect(tmpBarter).to.include({ Count: 0, Selected: true });
								let tmpFacet = pResponse.Body.Facets.Pay;
								Expect(tmpFacet.SumOfCounts + tmpFacet.MissingCount + tmpFacet.OtherCount).to.equal(tmpFacet.Total);
								_Harness.assertSelectionRoundTrip('BookStoreSale', tmpBody, pResponse.Body, { ZeroSample: 5 },
									(pRoundTripError, pReport) =>
									{
										Expect(pRoundTripError, pRoundTripError ? pRoundTripError.message : '').to.not.exist;
										Expect(pReport.Checked).to.be.above(2);
										return fDone();
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- planning and execution
		suite
		(
			'Planning and execution',
			() =>
			{
				test('facets with the same effective filter share one Variant and one Scoped Relation',
					(fDone) =>
					{
						let tmpBody =
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ] } ],
								Facets:
									[
										{ Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Labels: false },
										{ Key: 'PayMissing', Facet: 'BookStoreSale.PaymentMethod', Fold: 'Missing', Exclude: 'Self' },
										{ Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Labels: false },
										{ Key: 'Amount', Facet: 'BookStoreSale.TotalAmount' },
										{ Key: 'AmountStats', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' },
										{ Key: 'SaleStats', Facet: 'BookStoreSale.SaleDate', Fold: 'Stats', Exclude: 'Self' }
									]
							};
						// Per-Variant statements (the M2 cube is checked right after).
						_Harness.faceting.queryInternal('BookStoreSale', tmpBody, libHarness.syntheticRequest('BookStoreSale', {}, tmpBody), { PlanForm: { Cube: 'Never' } },
							(pError, pEnvelope, pMeta) =>
							{
								setImmediate(() =>
								{
									Expect(pError).to.not.exist;
									Expect(pEnvelope.Engine).to.equal('Live');
									// v0 (Store, Amount, the two Stats, #Total) and v1 (Pay, PayMissing: Credit excluded).
									Expect(pMeta.Variants).to.equal(2);
									Expect(pMeta.Relations).to.equal(2);
									Expect(pMeta.BehaviorRuns).to.equal(2);
									// One statement per Agg, two for the Nice histogram (bounds, then buckets).
									Expect(pMeta.Statements).to.equal(8);
									Expect(pMeta.Cubes).to.equal(0);
									Expect(pEnvelope.Facets.Pay.Total).to.equal(pEnvelope.Facets.PayMissing.Total);
									Expect(pEnvelope.Facets.Store.Total).to.equal(pEnvelope.Total);
									// The default plan form: Pay, Store and the Total (single-valued, cube-eligible) are
									// answered by ONE grouped statement over the shared base relation with the Credit
									// clause as a flag (internal-contracts §25); the envelope is identical (O5).
									_Harness.faceting.queryInternal('BookStoreSale', tmpBody, libHarness.syntheticRequest('BookStoreSale', {}, tmpBody), {},
										(pCubeError, pCubeEnvelope, pCubeMeta) =>
										{
											setImmediate(() =>
											{
												Expect(pCubeError).to.not.exist;
												Expect(pCubeMeta.Cubes).to.equal(1);
												Expect(pCubeMeta.CubeFallbacks).to.deep.equal([]);
												// the cube (Pay, Store, PayMissing, both Stats, the Total) 1 + the Nice histogram 2
												Expect(pCubeMeta.Statements).to.equal(3);
												Expect(pCubeEnvelope.Facets.AmountStats.Stats).to.deep.equal(pEnvelope.Facets.AmountStats.Stats);
												Expect(pCubeEnvelope.Facets.SaleStats.Stats.Min).to.be.a('string');
												Expect(_Harness.normalize(pCubeEnvelope)).to.deep.equal(_Harness.normalize(pEnvelope));
												return fDone();
											});
										});
								});
							});
					});

				test('the Reference engine answers in-process with the same session (O1 entry point)',
					(fDone) =>
					{
						let tmpBody = { FilterString: 'FBV~Rating~GE~4', Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] };
						_Harness.compare('Review', tmpBody, {},
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResult.Reference.Engine).to.equal('Reference');
								Expect(pResult.Reference.Facets.Rating.Engine).to.equal('Reference');
								Expect(pResult.Reference.Version).to.not.equal(pResult.Live.Body.Version);
								Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
								return fDone();
							});
					});

				test('restify handlers return undefined and call fNext exactly once',
					(fDone) =>
					{
						let tmpRoutes = _Harness.fable.RetoldFacetingRoutes;
						let tmpCalls = { Next: 0, Status: null };
						let tmpResponse =
							{
								header: () => {},
								send: (pStatus) => { tmpCalls.Status = pStatus; }
							};
						let fNext = () =>
						{
							tmpCalls.Next++;
							if (tmpCalls.Next === 1)
							{
								setImmediate(() =>
								{
									Expect(tmpCalls.Next).to.equal(1);
									Expect(tmpCalls.Status).to.equal(404);
									return fDone();
								});
							}
						};
						let tmpReturned = tmpRoutes.handleQuery({ params: { Entity: 'Nope' }, headers: {}, body: { Facets: [ { Facet: 'Nope.X' } ] } }, tmpResponse, fNext);
						Expect(tmpReturned).to.equal(undefined);
						let tmpDescribeReturned = tmpRoutes.handleDescribe({ params: {}, headers: {} }, { header: () => {}, send: () => {} }, () => {});
						Expect(tmpDescribeReturned).to.equal(undefined);
					});

				test('the request deadline (TimeoutMS) fails facets with 504 FACET_TIMEOUT; all failed → the request is 504',
					(fDone) =>
					{
						// A slow scope behavior on Customer (no other test here reads Customer).
						_Harness.installBehavior('Customer', 'Reads-QueryConfiguration',
							function (pRequest, pRequestState, fCallback)
							{
								setTimeout(() => { return fCallback(); }, 25);
							});
						let tmpBody = { TimeoutMS: 5, Facets: [ { Key: 'State', Facet: 'Customer.State' }, { Key: 'Active', Facet: 'Customer.Active' } ] };
						fQuery('Customer', tmpBody, {},
							(pResponse) =>
							{
								// The Live engine checks the deadline before every statement; the behavior alone outlasts it.
								fExpectError(pResponse, 504, 'FACET_TIMEOUT');
								// With time to spare the same request answers.
								fQuery('Customer', { TimeoutMS: 5000, Facets: tmpBody.Facets }, {},
									(pAnswered) =>
									{
										Expect(pAnswered.Status).to.equal(200);
										Expect(pAnswered.Body.Errors).to.deep.equal({});
										return fDone();
									});
							});
					});

				test('status() reports the attached Live engine and the model version',
					() =>
					{
						let tmpStatus = _Harness.faceting.status();
						Expect(tmpStatus).to.include({ Role: 'Embedded', Attached: true });
						Expect(tmpStatus.ModelVersion).to.match(/^m:[0-9a-f]{12}$/);
						Expect(tmpStatus.Engines.Live.Available).to.equal(true);
					});
			}
		);

		// ---------------------------------------------------------------- model reload (runs last: it changes the model)
		suite
		(
			'Model reload (D-31)',
			() =>
			{
				test('a host model load rebuilds the catalog: the new entity is described and faceted, the old ones still answer',
					(fDone) =>
					{
						let tmpModelVersion = _Harness.faceting.status().ModelVersion;
						_Harness.db.exec('CREATE TABLE Gadget (IDGadget INTEGER PRIMARY KEY AUTOINCREMENT, Deleted INTEGER NOT NULL DEFAULT 0, Color TEXT)');
						let tmpInsert = _Harness.db.prepare('INSERT INTO Gadget (Deleted, Color) VALUES (?, ?)');
						[ [ 0, 'red' ], [ 0, 'red' ], [ 0, 'blue' ], [ 1, 'blue' ], [ 0, null ] ].forEach((pRow) => { tmpInsert.run(pRow[0], pRow[1]); });
						let tmpGadget =
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
							};
						_Harness.rds.loadModel('Gadget', { Tables: { Gadget: tmpGadget } }, 'SQLite',
							(pLoadError) =>
							{
								Expect(pLoadError).to.not.exist;
								Expect(_Harness.faceting.status().ModelVersion).to.not.equal(tmpModelVersion);
								_Harness.request('GET', '/1.0/Facet/Gadget/Describe', null, {},
									(pDescribeError, pDescribe) =>
									{
										Expect(pDescribeError).to.not.exist;
										Expect(pDescribe.Status).to.equal(200);
										Expect(pDescribe.Body.Entities.Gadget.Categorical).to.deep.equal([ 'Color' ]);
										_Harness.compare('Gadget', { Facets: [ { Key: 'Color', Facet: 'Gadget.Color' } ] }, {},
											(pCompareError, pResult) =>
											{
												Expect(pCompareError).to.not.exist;
												Expect(pResult.Live.Status).to.equal(200);
												Expect(pResult.Live.Body.Total).to.equal(4);
												Expect(pResult.Live.Body.Facets.Color.MissingCount).to.equal(1);
												Expect(pResult.Live.Body.Facets.Color.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; })).to.deep.equal([ [ 'red', 2 ], [ 'blue', 1 ] ]);
												Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
												fQuery('Book', { Facets: [ { Key: 'Lang', Facet: 'Book.Language' } ] }, {},
													(pBook) =>
													{
														Expect(pBook.Status).to.equal(200);
														Expect(pBook.Body.Total).to.equal(_Harness.seed.LiveCounts.Book);
														return fDone();
													});
											});
									});
							});
					});
			}
		);
	}
);
