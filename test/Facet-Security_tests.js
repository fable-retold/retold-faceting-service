/**
 * Facet-Security: regressions for the M1 review findings at the HTTP and pipeline boundary.
 *
 *   - Version / ETag covers the computed representation: a write between two requests (or a
 *     different clause Hash) is a new ETag, never a stale 304;
 *   - the Query body reader is JSON-only: multipart (no temp file), urlencoded and text/plain are
 *     400 before anything runs; oversized bodies are 400;
 *   - client keys: 'hasOwnProperty' / '__proto__' / control characters as facet or range Keys are
 *     400, never a 500;
 *   - scope values are normalized: a session tenant of '0', ' 0 ' or false is unset (401);
 *   - on a scope-policy host the 401 decision never depends on the entity (unknown, hidden and real
 *     entities answer the same to an anonymous caller), with no Detail; Catalog.AllowAnonymous is
 *     the only way an anonymous caller facets anything;
 *   - behavior errors map the same on Live and the Reference ('401' string, a FacetError, a crash);
 *   - Describe omits what the host authorizer refuses (entities and FK Targets);
 *   - FK label reads carry an explicit soft delete (a behavior naming Deleted cannot resurrect a
 *     deleted parent's label);
 *   - Pivot cell cap (CubeMaxGroups) and the Terms row cap (MaxTermsGroups);
 *   - after a model reload the Live engine reads through the list's (route-bound) DAL.
 *
 * Port 19112 (internal-contracts §14.4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFS = require('fs');
const libOS = require('os');

const libHarness = require('./support/Facet-Test-Harness.js');
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = 19112;

/**
 * Leave a promise chain / the service's stack before asserting.
 *
 * @param {Function} fCallback
 * @return {Function}
 */
const later = (fCallback) =>
{
	return (...pArguments) => { setImmediate(() => { fCallback(...pArguments); }); };
};

/**
 * A raw fetch to the harness (custom Content-Type and body).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pPath
 * @param {Record<string, any>} pInit
 * @param {(pResponse: { Status: number, Body: any, Headers: Record<string, string> }) => void} fCallback
 */
const rawFetch = (pHarness, pPath, pInit, fCallback) =>
{
	fetch(`${pHarness.baseURL}${pPath}`, pInit)
		.then((pResponse) =>
		{
			return pResponse.text().then((pText) =>
			{
				let tmpBody = pText;
				try
				{
					tmpBody = JSON.parse(pText);
				}
				catch (pError)
				{
					// not JSON
				}
				let tmpHeaders = {};
				pResponse.headers.forEach((pValue, pKey) => { tmpHeaders[pKey] = pValue; });
				return { Status: pResponse.status, Body: tmpBody, Headers: tmpHeaders };
			});
		})
		.then(later(fCallback), (pError) => { setImmediate(() => { throw pError; }); });
};

/**
 * An in-process query with an arbitrary UserSession (the session marshaler reads it).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>|null} pUserSession
 * @param {{ ForceEngine?: string }} pInternal
 * @param {Function} fCallback
 */
const queryAs = (pHarness, pEntity, pBody, pUserSession, pInternal, fCallback) =>
{
	let tmpRequest = { params: { Entity: pEntity }, headers: {}, query: {}, body: pBody };
	if (pUserSession)
	{
		tmpRequest.UserSession = pUserSession;
	}
	pHarness.faceting.queryInternal(pEntity, pBody, tmpRequest, pInternal || {}, later(fCallback));
};

/**
 * Every live upload_* file in the OS temp dir (formidable's naming).
 *
 * @return {Array<string>}
 */
const uploadFiles = () =>
{
	try
	{
		return libFS.readdirSync(libOS.tmpdir()).filter((pName) => { return pName.indexOf('upload_') === 0; });
	}
	catch (pError)
	{
		return [];
	}
};

const PAY_BODY = { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };

suite
(
	'Facet-Security',
	() =>
	{
		// ---------------------------------------------------------------- plain Bookstore
		suite
		(
			'Bookstore (no scope policy)',
			() =>
			{
				let _Harness = null;
				// Review's behavior mode (null = pass-through) for the behavior-error parity tests.
				let _ReviewBehaviorMode = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' },
						(pError) =>
						{
							if (!pError)
							{
								_Harness.installBehavior('Review', 'Reads-QueryConfiguration',
									function (pRequest, pRequestState, fCallback)
									{
										switch (_ReviewBehaviorMode)
										{
											case 'String401':
												return fCallback({ StatusCode: '401', message: 'nope' });
											case 'FacetForbidden':
												return fCallback(libFacetErrors.create('FACET_FORBIDDEN'));
											case 'Crash':
												return fCallback(new Error('database password is hunter2'));
											default:
												return fCallback();
										}
									});
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('the harness serves on an ephemeral port read back after listen',
					() =>
					{
						Expect(_Harness.port).to.be.a('number');
						Expect(_Harness.baseURL).to.equal(`http://127.0.0.1:${_Harness.port}`);
					});

				test('ETag: an unchanged answer revalidates (304); a write between two requests is a new ETag and a 200',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', PAY_BODY, {},
							(pError, pFirst) =>
							{
								Expect(pFirst.Status).to.equal(200);
								let tmpETag = pFirst.Headers.etag;
								Expect(tmpETag).to.match(/^W\/"fv1:[0-9a-f]{16}"$/);
								_Harness.facetQuery('BookStoreSale', PAY_BODY, { Headers: { 'if-none-match': tmpETag } },
									(pSameError, pSame) =>
									{
										Expect(pSame.Status).to.equal(304);
										let tmpIDs = _Harness.db.prepare('SELECT IDBookStoreSale AS ID, PaymentMethod AS P FROM BookStoreSale WHERE Deleted = 0 ORDER BY IDBookStoreSale LIMIT 50').all();
										let tmpUpdate = _Harness.db.prepare('UPDATE BookStoreSale SET PaymentMethod = ? WHERE IDBookStoreSale = ?');
										tmpIDs.forEach((pRow) => { tmpUpdate.run('Zzz', pRow.ID); });
										_Harness.facetQuery('BookStoreSale', PAY_BODY, { Headers: { 'if-none-match': tmpETag } },
											(pAfterError, pAfter) =>
											{
												// Restore before asserting, so a failure leaves the fixture intact.
												tmpIDs.forEach((pRow) => { tmpUpdate.run(pRow.P, pRow.ID); });
												Expect(pAfter.Status).to.equal(200);
												Expect(pAfter.Headers.etag).to.not.equal(tmpETag);
												Expect(pAfter.Body.Facets.Pay.Buckets.find((pBucket) => { return pBucket.Key === 'Zzz'; }).Count).to.equal(50);
												return fDone();
											});
									});
							});
					});

				test('ETag: two requests that differ only in a clause Hash (Excluded, Filter.Applied) never share an ETag',
					(fDone) =>
					{
						let fBody = (pHash) =>
						{
							return { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Cash' ], Hash: pHash } ], Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };
						};
						_Harness.facetQuery('BookStoreSale', fBody('one'), {},
							(pError, pOne) =>
							{
								_Harness.facetQuery('BookStoreSale', fBody('two'), { Headers: { 'if-none-match': pOne.Headers.etag } },
									(pTwoError, pTwo) =>
									{
										Expect(pTwo.Status).to.equal(200);
										Expect(pTwo.Body.Facets.Pay.Excluded).to.deep.equal([ 'two' ]);
										Expect(pTwo.Headers.etag).to.not.equal(pOne.Headers.etag);
										return fDone();
									});
							});
					});

				test('the body reader is JSON-only: multipart (and no temp file), urlencoded and text/plain are 400 before anything runs',
					(fDone) =>
					{
						let tmpBefore = uploadFiles();
						let tmpForm = new FormData();
						tmpForm.append('upload', new Blob([ Buffer.alloc(600 * 1024, 65) ]), 'big.bin');
						rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', body: tmpForm },
							(pMultipart) =>
							{
								Expect(pMultipart.Status).to.equal(400);
								Expect(pMultipart.Body.Error).to.include({ Code: 'FACET_REQUEST_INVALID' });
								Expect(pMultipart.Body.Error.Detail).to.deep.equal({ Reason: 'UnsupportedContentType' });
								// Nothing was written to disk (restify's combined bodyParser would have
								// stored the file in the temp dir before the principal was resolved).
								let tmpNew = uploadFiles().filter((pName) => { return tmpBefore.indexOf(pName) < 0; });
								Expect(tmpNew).to.deep.equal([]);
								rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', body: new URLSearchParams({ Facets: 'x' }) },
									(pForm) =>
									{
										Expect(pForm.Status).to.equal(400);
										Expect(pForm.Body.Error.Detail.Reason).to.equal('UnsupportedContentType');
										rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(PAY_BODY) },
											(pText) =>
											{
												Expect(pText.Status).to.equal(400);
												rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', headers: { 'content-type': 'application/vnd.retold+json; charset=utf-8' }, body: JSON.stringify(PAY_BODY) },
													(pStructured) =>
													{
														Expect(pStructured.Status).to.equal(200);
														rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"Facets":[],"Pad":"${'x'.repeat(300 * 1024)}"}` },
															(pLarge) =>
															{
																Expect(pLarge.Status).to.equal(400);
																Expect(pLarge.Body.Error.Detail).to.include({ Reason: 'BodyTooLarge', Limit: 'MaxBodyBytes' });
																rawFetch(_Harness, '/1.0/Facet/BookStoreSale/Query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"Facets": [' },
																	(pBroken) =>
																	{
																		Expect(pBroken.Status).to.equal(400);
																		Expect(pBroken.Body.Error.Detail.Reason).to.equal('BodyNotJSON');
																		return fDone();
																	});
															});
													});
											});
									});
							});
					});

				test('client keys that would shadow Object.prototype or forge log lines are 400, never 500',
					(fDone) =>
					{
						let tmpBodies =
							[
								{ Facets: [ { Key: 'hasOwnProperty', Facet: 'Review.Rating' }, { Key: 'Other', Facet: 'Review.IDBook' } ] },
								{ Facets: [ { Key: '__proto__', Facet: 'Review.Rating' } ] },
								{ Facets: [ { Key: 'constructor', Facet: 'Review.Rating' } ] },
								{ Facets: [ { Key: 'Line\r\nForged: 1', Facet: 'Review.Rating' } ] },
								{ Facets: [ { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: [ { Key: 'hasOwnProperty', To: 3 }, { Key: 'b', From: 3 } ] } ] },
								{ Facets: [ { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: [ { Key: '__proto__', To: 3 } ] } ] },
								{ Facets: [ { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: [ { Key: '#NoRange', To: 3 } ] } ] }
							];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpBodies.length)
							{
								return fDone();
							}
							_Harness.facetQuery('Review', tmpBodies[pIndex], {},
								(pError, pResponse) =>
								{
									Expect(pResponse.Status, JSON.stringify(tmpBodies[pIndex])).to.equal(400);
									Expect(pResponse.Body.Error.Code).to.equal('FACET_REQUEST_INVALID');
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});

				test('a behavior error maps the same on Live and the Reference: \'401\' string, a FacetError, a crash (never echoed)',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] };
						let tmpCases = [ [ 'String401', 401, 'FACET_UNAUTHENTICATED' ], [ 'FacetForbidden', 403, 'FACET_FORBIDDEN' ], [ 'Crash', 500, 'FACET_INTERNAL' ] ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								_ReviewBehaviorMode = null;
								return fDone();
							}
							_ReviewBehaviorMode = tmpCases[pIndex][0];
							_Harness.facetQuery('Review', tmpBody, {},
								(pError, pLive) =>
								{
									Expect(pLive.Status, tmpCases[pIndex][0]).to.equal(tmpCases[pIndex][1]);
									Expect(pLive.Body.Error.Code).to.equal(tmpCases[pIndex][2]);
									Expect(JSON.stringify(pLive.Body)).to.not.include('hunter2');
									_Harness.reference('Review', tmpBody, {},
										later((pReferenceError) =>
										{
											Expect(pReferenceError.Code, `${tmpCases[pIndex][0]} reference`).to.equal(tmpCases[pIndex][2]);
											Expect(pReferenceError.Status).to.equal(tmpCases[pIndex][1]);
											return fNext(pIndex + 1);
										}));
								});
						};
						fNext(0);
					});

				test('Describe omits entities and FK Targets the host authorizer refuses',
					(fDone) =>
					{
						let tmpHost = _Harness.faceting.Host;
						tmpHost.getAuthorizer = () => { return { canRead: (pEntity) => { return pEntity !== 'User'; } }; };
						_Harness.request('GET', '/1.0/Facet/Describe', null, {},
							(pError, pAll) =>
							{
								_Harness.request('GET', '/1.0/Facet/Review/Describe', null, {},
									(pReviewError, pReview) =>
									{
										_Harness.request('GET', '/1.0/Facet/User/Describe', null, {},
											(pUserError, pUser) =>
											{
												delete tmpHost.getAuthorizer;
												Expect(pAll.Status).to.equal(200);
												Expect(pAll.Body.Entities).to.not.have.property('User');
												Expect(pAll.Body.Entities).to.have.property('Review');
												let tmpIDUser = pReview.Body.Entities.Review.Facets.find((pFacet) => { return pFacet.Field === 'IDUser'; });
												Expect(tmpIDUser).to.not.have.property('Target');
												let tmpIDBook = pReview.Body.Entities.Review.Facets.find((pFacet) => { return pFacet.Field === 'IDBook'; });
												Expect(tmpIDBook.Target).to.equal('Book');
												Expect(pUser.Status).to.equal(404);
												return fDone();
											});
									});
							});
					});

				test('a numeric column holding \'\' and \' \' text: Missing on every fold, on both engines (O1 + O2)',
					(fDone) =>
					{
						let tmpBody =
							{
								Facets:
									[
										{ Key: 'Hist', Facet: 'BookStoreInventory.BookCount' },
										{ Key: 'Terms', Facet: 'BookStoreInventory.BookCount', Fold: 'Terms', Top: 60 },
										{ Key: 'Missing', Facet: 'BookStoreInventory.BookCount', Fold: 'Missing' },
										{ Key: 'Distinct', Facet: 'BookStoreInventory.BookCount', Fold: 'DistinctCount' },
										{ Key: 'Stats', Facet: 'BookStoreInventory.BookCount', Fold: 'Stats' }
									]
							};
						_Harness.compare('BookStoreInventory', tmpBody, {},
							(pError, pResult) =>
							{
								Expect(pResult.Live.Status).to.equal(200);
								Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
								let tmpNulls = _Harness.db.prepare('SELECT count(*) AS N FROM BookStoreInventory WHERE Deleted = 0 AND BookCount IS NULL').get().N;
								let tmpFacets = pResult.Live.Body.Facets;
								// NULLs plus the two text rows
								Expect(tmpFacets.Missing.MissingCount).to.equal(tmpNulls + 2);
								Expect(tmpFacets.Terms.MissingCount).to.equal(tmpFacets.Missing.MissingCount);
								Expect(tmpFacets.Hist.MissingCount).to.equal(tmpFacets.Missing.MissingCount);
								Expect(tmpFacets.Distinct.MissingCount).to.equal(tmpFacets.Missing.MissingCount);
								Expect(tmpFacets.Stats.Stats.Rows - tmpFacets.Stats.Stats.NonNull).to.equal(tmpFacets.Missing.MissingCount);
								Expect(tmpFacets.Terms.Buckets.every((pBucket) => { return typeof(pBucket.Key) === 'number'; })).to.equal(true);
								_Harness.assertSelectionRoundTrip('BookStoreInventory', tmpBody, pResult.Live.Body, { MaxBuckets: 10 },
									(pRoundTripError, pReport) =>
									{
										Expect(pRoundTripError, pRoundTripError ? pRoundTripError.message : '').to.not.exist;
										Expect(pReport.Mismatches).to.deep.equal([]);
										return fDone();
									});
							});
					});

				test('a Terms key holding \'~\' keeps its bucket and Selection but has no Clause (UnsafeKey)',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Genre', Facet: 'Book.Genre', Top: 50 } ] };
						_Harness.facetQuery('Book', tmpBody, {},
							(pError, pResponse) =>
							{
								let tmpBucket = pResponse.Body.Facets.Genre.Buckets.find((pEntry) => { return pEntry.Key === _Harness.seed.Traps.UnsafeGenre; });
								Expect(tmpBucket).to.include({ Count: 3, Clause: null });
								Expect(tmpBucket.Selection).to.deep.equal({ Facet: 'Book.Genre', Key: _Harness.seed.Traps.UnsafeGenre });
								_Harness.assertSelectionRoundTrip('Book', tmpBody, pResponse.Body, { MaxBuckets: 5 },
									(pRoundTripError, pReport) =>
									{
										Expect(pRoundTripError, pRoundTripError ? pRoundTripError.message : '').to.not.exist;
										return fDone();
									});
							});
					});

				test('Terms never pulls a high-cardinality column whole: KeyAsc ranks by count, ties are capped at MaxTermsGroups',
					(fDone) =>
					{
						let tmpEngine = _Harness.fable.RetoldFacetingEngineLive;
						let tmpLimits = _Harness.faceting.options.Limits;
						let tmpSavedMax = tmpLimits.MaxTermsGroups;
						let tmpSavedCube = tmpLimits.CubeMaxGroups;
						let fFoldRows = tmpEngine.foldRows;
						let tmpRowCounts = [];
						tmpLimits.MaxTermsGroups = 7;
						// M2: the two Terms facets are cube members (one GROUP BY, internal-contracts §25); the
						// cube statement returns at most CubeMaxGroups + 1 grain rows, and over that it falls
						// back to the per-Variant Terms statements, which are capped at MaxTermsGroups.
						tmpLimits.CubeMaxGroups = 7;
						tmpEngine.foldRows = function (pContext, pAgg, pRows)
						{
							if (pAgg.Kind === 'Terms')
							{
								tmpRowCounts.push(pRows.length);
							}
							return fFoldRows.call(this, pContext, pAgg, pRows);
						};
						// ISBN is unique per book: every key ties at count 1, so rank-only selection would return them all.
						let tmpBody = { Facets: [ { Key: 'ISBN', Facet: 'Book.ISBN', Fold: 'Terms', Order: 'KeyAsc', Top: 5 }, { Key: 'ISBNByCount', Facet: 'Book.ISBN', Fold: 'Terms', Top: 3 } ] };
						_Harness.compare('Book', tmpBody, {},
							(pError, pResult) =>
							{
								tmpEngine.foldRows = fFoldRows;
								tmpLimits.MaxTermsGroups = tmpSavedMax;
								tmpLimits.CubeMaxGroups = tmpSavedCube;
								Expect(pError).to.not.exist;
								Expect(pResult.Live.Status, JSON.stringify(pResult.Live.Body).slice(0, 400)).to.equal(200);
								Expect(tmpRowCounts.length).to.be.above(0);
								tmpRowCounts.forEach((pCount) => { Expect(pCount).to.be.at.most(7); });
								// SQLite's BINARY order is the canonical key order: the capped answer is still exact.
								Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
								Expect(pResult.Live.Body.Facets.ISBN.Truncated).to.equal(true);
								Expect(pResult.Live.Body.Facets.ISBN.Buckets.length).to.equal(5);
								return fDone();
							});
					});
			}
		);

		// ---------------------------------------------------------------- Pivot cell cap
		suite
		(
			'Pivot cell cap (CubeMaxGroups)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Faceting: { Limits: { CubeMaxGroups: 5 } } }, fDone); });
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('a pivot with more cells than CubeMaxGroups is a per-facet 422 on Live and on the Reference; the rest answers',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ], Fold: 'Pivot', Interval: 'year' }, { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };
						_Harness.compare('BookStoreSale', tmpBody, {},
							(pError, pResult) =>
							{
								Expect(pResult.Live.Status).to.equal(200);
								Expect(pResult.Live.Body.Errors.Cross).to.include({ Code: 'FACET_TOO_LARGE', Status: 422 });
								Expect(pResult.Live.Body.Errors.Cross.Detail).to.include({ Limit: 'CubeMaxGroups', Max: 5 });
								Expect(pResult.Live.Body.Facets).to.have.property('Pay');
								Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
								return fDone();
							});
					});
			}
		);

		// ---------------------------------------------------------------- scope policy hosts
		let tTenantEntities = Object.keys(libBookstoreSeed.model('Bookstore-Tenant').Tables).filter((pEntity) => { return pEntity !== 'Author'; });

		suite
		(
			'Scope policy: unset values and anonymous callers (with Catalog.AllowAnonymous)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start(
						{
							Port: PORT,
							Fixture: 'Bookstore-Tenant',
							TenancyEntities: tTenantEntities,
							Faceting:
								{
									Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [ 'Author' ] }, Guard: 'Strict' },
									Catalog: { GlobalEntities: [ 'Author' ], AllowAnonymous: [ 'Author' ], NeverFacet: [ 'Customer' ] }
								}
						}, fDone);
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('a session tenant of \'0\', \' 0 \', \'00\' or false is unset: 401 (never a match on tenant-0 rows)',
					(fDone) =>
					{
						let tmpValues = [ '0', ' 0 ', '00', false, '' ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpValues.length)
							{
								return fDone();
							}
							queryAs(_Harness, 'BookStoreSale', PAY_BODY, { LoggedIn: true, UserID: 3, IDTenant: tmpValues[pIndex] }, {},
								(pError) =>
								{
									Expect(pError, JSON.stringify(tmpValues[pIndex])).to.exist;
									Expect(pError.Code).to.equal('FACET_UNAUTHENTICATED');
									Expect(libFacetErrors.toResponse(pError).Body.Error).to.not.have.property('Detail');
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});

				test('a session tenant of \' 2\' (string, padded) is tenant 2 on Live and the Reference',
					(fDone) =>
					{
						queryAs(_Harness, 'BookStoreSale', PAY_BODY, { LoggedIn: true, UserID: 3, IDTenant: ' 2' }, {},
							(pError, pLive) =>
							{
								Expect(pError).to.not.exist;
								Expect(pLive.Total).to.equal(_Harness.seed.TenantLiveCounts[2].BookStoreSale);
								queryAs(_Harness, 'BookStoreSale', PAY_BODY, { LoggedIn: true, UserID: 3, IDTenant: ' 2' }, { ForceEngine: 'Reference' },
									(pReferenceError, pReference) =>
									{
										Expect(pReferenceError).to.not.exist;
										Expect(libFacetEnvelope.normalizeForComparison(pLive)).to.deep.equal(libFacetEnvelope.normalizeForComparison(pReference));
										return fDone();
									});
							});
					});

				test('anonymous: unknown, hidden (NeverFacet) and scoped entities all answer the same 401 with no Detail',
					(fDone) =>
					{
						let tmpEntities = [ 'Book', 'NoSuchEntity', 'Customer' ];
						let tmpBodies = [];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpEntities.length)
							{
								Expect(tmpBodies[1]).to.deep.equal(tmpBodies[0]);
								Expect(tmpBodies[2]).to.deep.equal(tmpBodies[0]);
								return fDone();
							}
							_Harness.facetQuery(tmpEntities[pIndex], { Facets: [ { Key: 'X', Facet: `${tmpEntities[pIndex]}.Name` } ] }, {},
								(pError, pResponse) =>
								{
									Expect(pResponse.Status, tmpEntities[pIndex]).to.equal(401);
									Expect(pResponse.Body.Error).to.not.have.property('Detail');
									Expect(JSON.stringify(pResponse.Body)).to.not.include('IDTenant');
									tmpBodies.push(pResponse.Body);
									_Harness.request('GET', `/1.0/Facet/${tmpEntities[pIndex]}/Describe`, null, {},
										(pDescribeError, pDescribe) =>
										{
											Expect(pDescribe.Status, `${tmpEntities[pIndex]} Describe`).to.equal(401);
											return fNext(pIndex + 1);
										});
								});
						};
						fNext(0);
					});

				test('a signed-in tenant sees 404 for unknown and hidden entities alike',
					(fDone) =>
					{
						_Harness.facetQuery('NoSuchEntity', { Facets: [ { Key: 'X', Facet: 'NoSuchEntity.Name' } ] }, { Tenant: 1 },
							(pError, pUnknown) =>
							{
								_Harness.facetQuery('Customer', { Facets: [ { Key: 'X', Facet: 'Customer.Name' } ] }, { Tenant: 1 },
									(pHiddenError, pHidden) =>
									{
										Expect(pUnknown.Status).to.equal(404);
										Expect(pHidden.Status).to.equal(404);
										Expect(pHidden.Body).to.deep.equal(pUnknown.Body);
										return fDone();
									});
							});
					});

				test('Catalog.AllowAnonymous: an anonymous caller facets and describes exactly the allowlisted global entity',
					(fDone) =>
					{
						_Harness.facetQuery('Author', { Facets: [ { Key: 'Name', Facet: 'Author.Name', Top: 3 } ] }, {},
							(pError, pAuthor) =>
							{
								Expect(pAuthor.Status, JSON.stringify(pAuthor.Body).slice(0, 300)).to.equal(200);
								Expect(pAuthor.Body.Total).to.equal(_Harness.seed.LiveCounts.Author);
								_Harness.request('GET', '/1.0/Facet/Describe', null, {},
									(pDescribeError, pDescribe) =>
									{
										Expect(pDescribe.Status).to.equal(200);
										Expect(Object.keys(pDescribe.Body.Entities)).to.deep.equal([ 'Author' ]);
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'Scope policy without AllowAnonymous: a global entity is still 401 for anonymous callers',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start(
						{
							Port: PORT,
							Fixture: 'Bookstore-Tenant',
							TenancyEntities: tTenantEntities,
							Faceting:
								{
									Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant', Exclude: [ 'Author' ] }, Guard: 'Strict' },
									Catalog: { GlobalEntities: [ 'Author' ] }
								}
						}, fDone);
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('anonymous Author query and Describe are 401; a signed-in tenant gets the global entity',
					(fDone) =>
					{
						_Harness.facetQuery('Author', { Facets: [ { Key: 'Name', Facet: 'Author.Name', Top: 3 } ] }, {},
							(pError, pAnonymous) =>
							{
								Expect(pAnonymous.Status).to.equal(401);
								_Harness.request('GET', '/1.0/Facet/Describe', null, {},
									(pDescribeError, pDescribe) =>
									{
										Expect(pDescribe.Status).to.equal(401);
										_Harness.facetQuery('Author', { Facets: [ { Key: 'Name', Facet: 'Author.Name', Top: 3 } ] }, { Tenant: 2 },
											(pSignedError, pSigned) =>
											{
												Expect(pSigned.Status).to.equal(200);
												Expect(pSigned.Body.Total).to.equal(_Harness.seed.LiveCounts.Author);
												return fDone();
											});
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- labels and reloads (mutate the host)
		suite
		(
			'FK labels and model reloads',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' }, fDone); });
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('a target behavior that names Deleted cannot resurrect a soft-deleted parent\'s label (explicit soft delete)',
					(fDone) =>
					{
						// FoxHound's implicit Deleted = 0 switches off as soon as an entry names the column.
						_Harness.installBehavior('BookStore', 'Reads-QueryConfiguration',
							function (pRequest, pRequestState, fCallback)
							{
								pRequestState.Query.addFilter('Deleted', 1, '<=', 'AND', 'NamesDeleted');
								return fCallback();
							});
						let tmpDeleted = {};
						_Harness.db.prepare('SELECT IDBookStore AS K FROM BookStore WHERE Deleted = 1').all().forEach((pRow) => { tmpDeleted[String(pRow.K)] = true; });
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 100 } ] }, {},
							(pError, pResponse) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpBuckets = pResponse.Body.Facets.Store.Buckets;
								let tmpDeletedSeen = tmpBuckets.filter((pBucket) => { return tmpDeleted[String(pBucket.Key)]; });
								Expect(tmpDeletedSeen.length).to.be.above(0);
								tmpDeletedSeen.forEach((pBucket) => { Expect(pBucket.LabelResolved, `store ${pBucket.Key}`).to.equal(false); });
								Expect(tmpBuckets.some((pBucket) => { return pBucket.LabelResolved === true; })).to.equal(true);
								return fDone();
							});
					});

				test('after a model reload Live reads through the route-bound DAL the list uses (Live == Reference)',
					(fDone) =>
					{
						let tmpOldDAL = _Harness.fable.DAL.Book;
						let tmpModel = JSON.parse(JSON.stringify(_Harness.model));
						// The reloaded model no longer types Book.Deleted as the delete column: a DAL built
						// from it would count soft-deleted rows; the list (old controller) still excludes them.
						tmpModel.Tables.Book.MeadowSchema.Schema.forEach((pColumn) => { if (pColumn.Column === 'Deleted') { pColumn.Type = 'Boolean'; } });
						_Harness.rds.loadModel('Bookstore', tmpModel, 'SQLite',
							(pLoadError) =>
							{
								Expect(pLoadError).to.not.exist;
								let tmpHost = _Harness.faceting.Host;
								Expect(_Harness.fable.DAL.Book).to.not.equal(tmpOldDAL);
								Expect(tmpHost.getExecutionDAL('Book')).to.equal(tmpHost.getRouteBoundController('Book').DAL);
								Expect(tmpHost.getExecutionDAL('Book')).to.equal(tmpOldDAL);
								_Harness.compare('Book', { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 50 }, { Key: 'Year', Facet: 'Book.PublicationYear' } ] }, {},
									(pCompareError, pResult) =>
									{
										Expect(pResult.Live.Status).to.equal(200);
										Expect(pResult.Live.Body.Total).to.equal(_Harness.seed.LiveCounts.Book);
										Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
										return fDone();
									});
							});
					});
			}
		);
	}
);
