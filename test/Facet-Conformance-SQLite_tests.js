/**
 * Facet-Conformance-SQLite (wiring): the Milestone 1 exit criteria on in-memory SQLite.
 *
 *   O1  for a broad fixture list (every M1 fold kind on several columns, with and without clauses,
 *       multi-facet disjunctive requests, RawFilter and FBVOR precedence, Show-deleted, NULLs), the
 *       Live envelope (HTTP) deep-equals the Reference envelope (the pure-JS fold over the rows the
 *       LIST endpoint returns for the same clauses and session), after normalizeForComparison;
 *   O2  every selectable bucket's Clause, swapped in for the conjuncts the facet excluded and counted
 *       through the real list Count route, equals Bucket.Count; Σ + Missing + Other == facet Total;
 *       envelope Total == list Count;
 *   two-tenant isolation on Bookstore-Tenant (tenant A never sees tenant B rows; facets equal the
 *   tenant's own list and raw SQL for that tenant);
 *   ScopeGuard: a behavior that drops the policy predicate → 500 FACET_SCOPE_POLICY_VIOLATION in
 *   Strict, a repaired (tenant-only) answer plus X-Retold-Facet-Scope-Repaired in Repair.
 *
 * Port 19111 (internal-contracts §14.4); the harnesses of the suites below run one after the other.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');

const PORT = 19111;

const TENANT_COLUMN = 'IDTenant';

/**
 * The deep-equal message for an O1 mismatch: the first differing facet, so a failure is readable.
 *
 * @param {Record<string, any>} pLive
 * @param {Record<string, any>} pReference
 * @return {string}
 */
const firstDifference = (pLive, pReference) =>
{
	let tmpKeys = Object.keys(Object.assign({}, pLive.Facets || {}, pReference.Facets || {}));
	for (let i = 0; i < tmpKeys.length; i++)
	{
		let tmpLive = JSON.stringify((pLive.Facets || {})[tmpKeys[i]]);
		let tmpReference = JSON.stringify((pReference.Facets || {})[tmpKeys[i]]);
		if (tmpLive !== tmpReference)
		{
			return `facet ${tmpKeys[i]}\n  Live:      ${String(tmpLive).slice(0, 1500)}\n  Reference: ${String(tmpReference).slice(0, 1500)}`;
		}
	}
	return 'envelope fields differ';
};

/**
 * Run one fixture: O1 (and the fixture's own checks), then O2 unless the fixture opts out.
 *
 * @param {Record<string, any>} pHarness
 * @param {Record<string, any>} pFixture - { Name, Entity, Body, Session?, O2?, O2Options?, Check? }
 * @param {Function} fDone
 */
const runFixture = (pHarness, pFixture, fDone) =>
{
	let tmpSession = pFixture.Session || {};
	pHarness.compare(pFixture.Entity, pFixture.Body, tmpSession,
		(pError, pResult) =>
		{
			Expect(pError, pError ? pError.message : '').to.not.exist;
			Expect(pResult.Live.Status, JSON.stringify(pResult.Live.Body).slice(0, 600)).to.equal(200);
			Expect(pResult.Live.Body.Engine).to.equal('Live');
			Expect(pResult.Reference.Engine).to.equal('Reference');
			Expect(pResult.Live.Body.Exact).to.equal(true);
			if (JSON.stringify(pResult.LiveNormalized) !== JSON.stringify(pResult.ReferenceNormalized))
			{
				Expect(pResult.LiveNormalized, firstDifference(pResult.LiveNormalized, pResult.ReferenceNormalized)).to.deep.equal(pResult.ReferenceNormalized);
			}
			Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
			if (typeof(pFixture.Check) === 'function')
			{
				pFixture.Check(pResult.Live.Body, pHarness);
			}
			if (pFixture.O2 === false)
			{
				return fDone();
			}
			pHarness.assertSelectionRoundTrip(pFixture.Entity, pFixture.Body, pResult.Live.Body, Object.assign({}, tmpSession, pFixture.O2Options || {}),
				(pRoundTripError, pReport) =>
				{
					Expect(pRoundTripError, pRoundTripError ? pRoundTripError.message : '').to.not.exist;
					Expect(pReport.Checked).to.be.above(0);
					Expect(pReport.Mismatches).to.deep.equal([]);
					return fDone();
				});
		});
};

/**
 * The buckets of a facet as { Key: Count }.
 *
 * @param {Record<string, any>} pFacet
 * @return {Record<string, number>}
 */
const countsOf = (pFacet) =>
{
	let tmpCounts = {};
	pFacet.Buckets.forEach((pBucket) => { tmpCounts[String(pBucket.Key)] = pBucket.Count; });
	return tmpCounts;
};

// ---------------------------------------------------------------- the Bookstore fixture list

const libConformanceFixtures = require('./fixtures/Bookstore-Conformance-Fixtures.js');
const CONFORMANCE = libConformanceFixtures.build(Expect, countsOf, libHarness);
const BOOKSTORE_FIXTURES = CONFORMANCE.Fixtures;
const RATING_RANGES = CONFORMANCE.RatingRanges;

suite
(
	'Facet-Conformance-SQLite',
	() =>
	{
		// ---------------------------------------------------------------- Bookstore: O1 + O2
		suite
		(
			'Bookstore: Live == Reference (O1) and the selection round trip (O2)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' }, fDone); });
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				BOOKSTORE_FIXTURES.forEach(
					(pFixture) =>
					{
						test(pFixture.Name,
							(fDone) =>
							{
								runFixture(_Harness, pFixture, fDone);
							});
					});

				test('every M1 fold kind is covered by the fixture list',
					() =>
					{
						let tmpKinds = {};
						BOOKSTORE_FIXTURES.forEach(
							(pFixture) =>
							{
								pFixture.Body.Facets.forEach(
									(pFacet) =>
									{
										tmpKinds[pFacet.Fold || 'Default'] = true;
									});
							});
						[ 'Terms', 'Default', 'Stats', 'DistinctCount', 'Missing', 'Ranges', 'Pivot' ].forEach((pKind) => { Expect(tmpKinds, pKind).to.have.property(pKind); });
					});
			}
		);

		// ---------------------------------------------------------------- Bookstore-Tenant: isolation
		suite
		(
			'Bookstore-Tenant: two-tenant isolation',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) => { _Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant' }, fDone); });
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				const TENANT_BODIES =
					[
						[ 'BookStoreSale',
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Debit' ] } ],
								Facets:
									[
										{ Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' },
										{ Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 50 },
										{ Key: 'ByYear', Facet: 'BookStoreSale.SaleDate', Interval: 'year' },
										{ Key: 'Amount', Facet: 'BookStoreSale.TotalAmount', Buckets: 6 },
										{ Key: 'AmountStats', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' },
										{ Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ], Fold: 'Pivot', Interval: 'year' }
									]
							} ],
						[ 'Review', { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' }, { Key: 'Book', Facet: 'Review.IDBook', Top: 10 }, { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: RATING_RANGES } ] } ],
						[ 'Book', { FilterString: 'FBV~PublicationYear~GE~1900', Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 50 }, { Key: 'Year', Facet: 'Book.PublicationYear' } ] } ]
					];

				[ 1, 2 ].forEach(
					(pTenant) =>
					{
						TENANT_BODIES.forEach(
							(pCase) =>
							{
								test(`tenant ${pTenant}: ${pCase[0]} Live == Reference and the round trip holds`,
									(fDone) =>
									{
										runFixture(_Harness, { Entity: pCase[0], Body: pCase[1], Session: { Tenant: pTenant }, O2Options: { MaxBuckets: 15 } }, fDone);
									});
							});
					});

				test('each tenant counts exactly its own live rows (raw SQL per tenant), and the tenants sum to the whole table',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Missing: true } ] };
						let tmpSQL = (pTenant) =>
						{
							let tmpRows = _Harness.db.prepare(`SELECT PaymentMethod AS K, count(*) AS C FROM BookStoreSale WHERE Deleted = 0 AND ${TENANT_COLUMN} = ? GROUP BY PaymentMethod`).all(pTenant);
							let tmpCounts = {};
							let tmpMissing = 0;
							tmpRows.forEach((pRow) => { if (pRow.K === null) { tmpMissing += pRow.C; } else { tmpCounts[pRow.K] = pRow.C; } });
							return { Counts: tmpCounts, Missing: tmpMissing };
						};
						let tmpTotals = {};
						let fTenant = (pTenant, fNext) =>
						{
							_Harness.facetQuery('BookStoreSale', tmpBody, { Tenant: pTenant },
								(pError, pResponse) =>
								{
									Expect(pError).to.not.exist;
									Expect(pResponse.Status).to.equal(200);
									let tmpExpected = tmpSQL(pTenant);
									Expect(countsOf(pResponse.Body.Facets.Pay)).to.deep.equal(tmpExpected.Counts);
									Expect(pResponse.Body.Facets.Pay.MissingCount).to.equal(tmpExpected.Missing);
									Expect(pResponse.Body.Total).to.equal(_Harness.seed.TenantLiveCounts[pTenant].BookStoreSale);
									tmpTotals[pTenant] = pResponse.Body.Total;
									return fNext();
								});
						};
						fTenant(1, () =>
						{
							fTenant(2, () =>
							{
								Expect(tmpTotals[1] + tmpTotals[2]).to.equal(_Harness.seed.LiveCounts.BookStoreSale);
								Expect(tmpTotals[2]).to.be.below(tmpTotals[1]);
								return fDone();
							});
						});
					});

				test('tenant 2 never sees tenant 1 rows: every Store key it reports is one of its own sales rows; cross-tenant parents stay unlabelled',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 500 } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								let tmpOwn = {};
								_Harness.db.prepare(`SELECT IDBookStore AS K, count(*) AS C FROM BookStoreSale WHERE Deleted = 0 AND ${TENANT_COLUMN} = 2 AND IDBookStore IS NOT NULL GROUP BY IDBookStore`).all()
									.forEach((pRow) => { tmpOwn[String(pRow.K)] = pRow.C; });
								Expect(countsOf(pResponse.Body.Facets.Store)).to.deep.equal(tmpOwn);
								let tmpTenantStores = {};
								_Harness.db.prepare(`SELECT IDBookStore AS K, Name AS N FROM BookStore WHERE Deleted = 0 AND ${TENANT_COLUMN} = 2`).all()
									.forEach((pRow) => { tmpTenantStores[String(pRow.K)] = pRow.N; });
								let tmpCrossTenant = 0;
								pResponse.Body.Facets.Store.Buckets.forEach(
									(pBucket) =>
									{
										if (tmpTenantStores.hasOwnProperty(String(pBucket.Key)))
										{
											Expect(pBucket.LabelResolved).to.equal(true);
											Expect(pBucket.Label).to.equal(tmpTenantStores[String(pBucket.Key)]);
										}
										else
										{
											tmpCrossTenant++;
											Expect(pBucket.LabelResolved).to.equal(false);
											Expect(pBucket.Label).to.equal(String(pBucket.Key));
										}
									});
								Expect(tmpCrossTenant).to.be.above(0);
								return fDone();
							});
					});

				test('anonymous (no tenant) is 401 on Live and on the Reference, before any SQL',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] };
						_Harness.facetQuery('BookStoreSale', tmpBody, {},
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(401);
								Expect(pResponse.Body.Error.Code).to.equal('FACET_UNAUTHENTICATED');
								_Harness.reference('BookStoreSale', tmpBody, {},
									(pReferenceError) =>
									{
										setImmediate(() =>
										{
											Expect(pReferenceError.Code).to.equal('FACET_UNAUTHENTICATED');
											return fDone();
										});
									});
							});
					});

				test('a tenant-0 principal (an unset scope value) is 401, and Describe is 401 too',
					(fDone) =>
					{
						_Harness.facetQuery('Review', { Facets: [ { Key: 'Rating', Facet: 'Review.Rating' } ] }, { User: 5 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(401);
								_Harness.request('GET', '/1.0/Facet/Describe', null, { User: 5 },
									(pDescribeError, pDescribe) =>
									{
										Expect(pDescribeError).to.not.exist;
										Expect(pDescribe.Status).to.equal(401);
										return fDone();
									});
							});
					});

				test('a client filter naming the tenant column cannot reach another tenant (it is fenced; the policy predicate still applies)',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { FilterString: `FBV~${TENANT_COLUMN}~EQ~1`, Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Body.Total).to.equal(0);
								return fDone();
							});
					});
			}
		);

		// ---------------------------------------------------------------- ScopeGuard Strict / Repair
		/**
		 * A behavior that DROPS the policy predicate the tenancy behavior just appended (the E1
		 * clobber): chained after the tenancy behavior on BookStoreSale's Reads-QueryConfiguration.
		 */
		const fClobberTenancy = function (pRequest, pRequestState, fCallback)
		{
			pRequestState.Query.parameters.filter = pRequestState.Query.parameters.filter.filter((pEntry) => { return pEntry.Parameter !== 'TestTenancy'; });
			return fCallback();
		};

		suite
		(
			'ScopeGuard Strict: a behavior that drops the policy predicate is refused',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant' },
						(pError) =>
						{
							if (!pError)
							{
								_Harness.installBehavior('BookStoreSale', 'Reads-QueryConfiguration', fClobberTenancy);
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('the list itself now leaks every tenant (what the guard protects against)',
					(fDone) =>
					{
						_Harness.listRows('BookStoreSale', '', { Tenant: 2 },
							(pError, pRecords) =>
							{
								Expect(pError).to.not.exist;
								Expect(pRecords.length).to.equal(_Harness.seed.LiveCounts.BookStoreSale);
								return fDone();
							});
					});

				test('Live refuses: 500 FACET_SCOPE_POLICY_VIOLATION with the generic message (the rule and column only in the log), no envelope',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(500);
								Expect(pResponse.Body.Error.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
								Expect(pResponse.Body.Error.Message).to.equal('The scope policy could not be verified.');
								Expect(pResponse.Body.Error).to.not.have.property('Detail');
								Expect(JSON.stringify(pResponse.Body)).to.not.include(TENANT_COLUMN);
								Expect(pResponse.Body).to.not.have.property('Facets');
								Expect(pResponse.Headers).to.not.have.property('etag');
								return fDone();
							});
					});

				test('entities whose behaviors keep the predicate still answer',
					(fDone) =>
					{
						runFixture(_Harness, { Entity: 'Review', Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] }, Session: { Tenant: 2 } }, fDone);
					});
			}
		);

		suite
		(
			'ScopeGuard Repair: the dropped predicate is re-applied and flagged',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start(
						{
							Port: PORT,
							Fixture: 'Bookstore-Tenant',
							Faceting: { Scope: { Policy: { Column: TENANT_COLUMN, SessionField: 'IDTenant' }, Guard: 'Repair' } }
						},
						(pError) =>
						{
							if (!pError)
							{
								_Harness.installBehavior('BookStoreSale', 'Reads-QueryConfiguration', fClobberTenancy);
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('200 with X-Retold-Facet-Scope-Repaired and exactly the tenant\'s rows',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Headers['x-retold-facet-scope-repaired']).to.equal('1');
								Expect(pResponse.Body.Total).to.equal(_Harness.seed.TenantLiveCounts[2].BookStoreSale);
								return fDone();
							});
					});

				test('an unaffected entity carries no repaired header',
					(fDone) =>
					{
						_Harness.facetQuery('Review', { Facets: [ { Key: 'Rating', Facet: 'Review.Rating' } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Headers).to.not.have.property('x-retold-facet-scope-repaired');
								return fDone();
							});
					});
			}
		);
	}
);
