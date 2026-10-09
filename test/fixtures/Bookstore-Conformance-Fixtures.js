/**
 * Bookstore-Conformance-Fixtures — the Milestone 1 Bookstore conformance request list, shared by
 * test/Facet-Conformance-SQLite_tests.js and test/Facet-Conformance-PostgreSQL_tests.js (which applies
 * its PostgreSQL deltas to the result), so the two lists never drift and neither file depends on the
 * other's formatting.
 *
 *   let libConformanceFixtures = require('./fixtures/Bookstore-Conformance-Fixtures.js');
 *   let tmpConformance = libConformanceFixtures.build(Expect, countsOf, libHarness);   // { Fixtures, RatingRanges }
 *
 * Each fixture is { Name, Entity, Body, Session?, O2?, O2Options?, Check? }; Check functions use the
 * caller's Expect and countsOf.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

/**
 * Build the fixture list with the caller's assertion helpers.
 *
 * @param {Function} Expect - chai expect
 * @param {(pFacet: Record<string, any>) => Record<string, number>} countsOf
 * @param {Record<string, any>} libHarness - test/support/Facet-Test-Harness.js
 * @return {{ Fixtures: Array<Record<string, any>>, RatingRanges: Array<Record<string, any>> }}
 */
const build = (Expect, countsOf, libHarness) =>
{
	const RATING_RANGES = [ { Key: 'low', To: 3, Label: 'Low' }, { Key: 'mid', From: 3, To: 5 }, { Key: 'top', From: 5, Label: 'Top' } ];
	const AMOUNT_RANGES = [ { Key: 'small', To: 50 }, { Key: 'medium', From: 50, To: 200 }, { Key: 'large', From: 200 } ];
	const GAPPED_AMOUNT_RANGES = [ { Key: 'small', To: 50 }, { Key: 'large', From: 200 } ];

	const BOOKSTORE_FIXTURES =
		[
			// ---- K1 Terms
			{
				Name: 'F1 Review.Rating as Terms (integer keys, no filter)',
				Entity: 'Review',
				Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] },
				Check: (pEnvelope) =>
				{
					let tmpFacet = pEnvelope.Facets.Rating;
					Expect(tmpFacet.Buckets.map((pBucket) => { return typeof(pBucket.Key); })).to.satisfy((pTypes) => { return pTypes.every((pType) => { return pType === 'number'; }); });
					Expect(tmpFacet.Disjunctive).to.equal('Exact');
					Expect(tmpFacet.SumOfCounts + tmpFacet.MissingCount + tmpFacet.OtherCount).to.equal(tmpFacet.Total);
				}
			},
			{
				Name: 'F2 BookStoreEmployee.IsActive (Boolean keys)',
				Entity: 'BookStoreEmployee',
				Body: { Facets: [ { Key: 'Active', Facet: 'BookStoreEmployee.IsActive' } ] }
			},
			{
				Name: 'F3 BookStoreSale.PaymentMethod (skewed categories) with a Chart',
				Entity: 'BookStoreSale',
				Body: { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Chart: true } ] },
				Check: (pEnvelope) =>
				{
					let tmpFacet = pEnvelope.Facets.Pay;
					Expect(tmpFacet.Chart.Labels).to.deep.equal(tmpFacet.Buckets.map((pBucket) => { return pBucket.Label; }));
					Expect(tmpFacet.Chart.Datasets[0].data).to.deep.equal(tmpFacet.Buckets.map((pBucket) => { return pBucket.Count; }));
				}
			},
			{
				Name: 'F4 Book.Language: blank strings are keys, NULLs are Missing; plus Missing and DistinctCount folds',
				Entity: 'Book',
				Body:
					{
						Facets:
							[
								{ Key: 'Lang', Facet: 'Book.Language', Top: 50 },
								{ Key: 'LangMissing', Facet: 'Book.Language', Fold: 'Missing' },
								{ Key: 'LangDistinct', Facet: 'Book.Language', Fold: 'DistinctCount' }
							]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Lang.Buckets.some((pBucket) => { return pBucket.Key === ''; })).to.equal(true);
					Expect(pEnvelope.Facets.LangMissing.MissingCount).to.equal(pEnvelope.Facets.Lang.MissingCount);
					Expect(pEnvelope.Facets.LangDistinct.DistinctCount).to.equal(pEnvelope.Facets.Lang.DistinctCount);
				}
			},
			{
				Name: 'Terms: Top truncation with KeyAsc display order and Missing: false',
				Entity: 'Book',
				Body: { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 3, Order: 'KeyAsc', Missing: false } ] },
				Check: (pEnvelope) =>
				{
					let tmpFacet = pEnvelope.Facets.Lang;
					Expect(tmpFacet.Truncated).to.equal(true);
					Expect(tmpFacet.TruncatedReason).to.equal('Top');
					Expect(tmpFacet.MissingCount).to.equal(0);
					let tmpKeys = tmpFacet.Buckets.map((pBucket) => { return pBucket.Key; });
					Expect(tmpKeys).to.deep.equal(tmpKeys.slice().sort());
				}
			},
			{
				Name: 'Terms: KeyDesc on an integer column',
				Entity: 'Review',
				Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms', Order: 'KeyDesc', Top: 3 } ] }
			},
			{
				Name: 'Terms: a selected key ranked below Top comes back with its real count',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Online' ], Hash: 'pay-online' } ],
						Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Top: 1 } ]
					},
				Check: (pEnvelope) =>
				{
					let tmpBuckets = pEnvelope.Facets.Pay.Buckets;
					Expect(tmpBuckets.length).to.equal(2);
					Expect(tmpBuckets[1]).to.include({ Key: 'Online', Selected: true });
					Expect(tmpBuckets[1].Count).to.be.above(0);
					Expect(pEnvelope.Facets.Pay.Excluded).to.deep.equal([ 'pay-online' ]);
				}
			},
			{
				Name: 'Terms on foreign keys (labelled by scoped reads) on a bridge and on a soft-deleting entity',
				Entity: 'BookAuthorJoin',
				Body: { Facets: [ { Key: 'Author', Facet: 'BookAuthorJoin.IDAuthor', Top: 8 }, { Key: 'Book', Facet: 'BookAuthorJoin.IDBook', Top: 5 } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Author.Buckets.every((pBucket) => { return typeof(pBucket.LabelResolved) === 'boolean'; })).to.equal(true);
				}
			},
			{
				Name: 'Terms on a String column of an entity without a delete column (User.Config)',
				Entity: 'User',
				Body: { Facets: [ { Key: 'Config', Facet: 'User.Config' } ] }
			},

			// ---- K2 DateHistogram
			{
				Name: 'F5 BookStoreSale.SaleDate by month (single-day first month, gap fill)',
				Entity: 'BookStoreSale',
				Body: { Facets: [ { Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate', Interval: 'month' } ] },
				Check: (pEnvelope) =>
				{
					let tmpFacet = pEnvelope.Facets.ByMonth;
					Expect(tmpFacet.Interval).to.equal('month');
					Expect(tmpFacet.TimeZone).to.equal('UTC');
					Expect(tmpFacet.Bounds.Lo <= tmpFacet.Buckets[0].End).to.equal(true);
					Expect(tmpFacet.MissingCount).to.be.above(0);
				}
			},
			{
				Name: 'DateHistogram by week, quarter and year (ISO weeks, calendar quarters)',
				Entity: 'BookStoreSale',
				Body:
					{
						Facets:
							[
								{ Key: 'ByWeek', Facet: 'BookStoreSale.SaleDate', Interval: 'week' },
								{ Key: 'ByQuarter', Facet: 'BookStoreSale.SaleDate', Interval: 'quarter' },
								{ Key: 'ByYear', Facet: 'BookStoreSale.SaleDate', Interval: 'year' }
							]
					},
				O2Options: { MaxBuckets: 12 }
			},
			{
				Name: 'DateHistogram by day inside a DateRange, EmptyBuckets false, KeyDesc',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Online' ] } ],
						FilterString: 'FBV~SaleDate~GE~2023-03-01~FBV~SaleDate~LT~2023-05-01',
						Facets:
							[
								{ Key: 'ByDay', Facet: 'BookStoreSale.SaleDate', Interval: 'day', EmptyBuckets: false, Order: 'KeyDesc', Exclude: 'None' },
								{ Key: 'ByWeekSelf', Facet: 'BookStoreSale.SaleDate', Interval: 'week' }
							]
					},
				O2Options: { MaxBuckets: 20 },
				Check: (pEnvelope) =>
				{
					let tmpDays = pEnvelope.Facets.ByDay;
					Expect(tmpDays.Excluded).to.deep.equal([]);
					Expect(tmpDays.Buckets.every((pBucket) => { return pBucket.Count > 0; })).to.equal(true);
					Expect(tmpDays.Buckets[0].Key > tmpDays.Buckets[tmpDays.Buckets.length - 1].Key).to.equal(true);
					Expect(tmpDays.Buckets.every((pBucket) => { return (pBucket.Key >= '2023-03-01') && (pBucket.Key < '2023-05-01'); })).to.equal(true);
					// The FilterString terms on SaleDate are the week facet's own: both excluded (no Hash → conjunct Ids).
					Expect(pEnvelope.Facets.ByWeekSelf.Excluded).to.deep.equal([ 'c2', 'c3' ]);
					Expect(pEnvelope.Facets.ByWeekSelf.Buckets.some((pBucket) => { return pBucket.Selected; })).to.equal(true);
				}
			},
			{
				Name: 'DateHistogram of a column holding NULL, blank and unparseable dates (BookPrice.EndDate) with Stats, Missing, DistinctCount',
				Entity: 'BookPrice',
				Body:
					{
						Facets:
							[
								{ Key: 'End', Facet: 'BookPrice.EndDate', Interval: 'year' },
								{ Key: 'EndStats', Facet: 'BookPrice.EndDate', Fold: 'Stats' },
								{ Key: 'EndMissing', Facet: 'BookPrice.EndDate', Fold: 'Missing' }
							]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.End.MissingCount).to.equal(pEnvelope.Facets.EndMissing.MissingCount);
					Expect(pEnvelope.Facets.EndStats.Stats.Rows - pEnvelope.Facets.EndStats.Stats.NonNull).to.equal(pEnvelope.Facets.EndMissing.MissingCount);
				}
			},
			{
				Name: 'DateHistogram too fine for the date span: per-facet 422 with Suggest, the rest of the envelope still answers',
				Entity: 'BookStoreSale',
				Body: { Facets: [ { Key: 'ByDay', Facet: 'BookStoreSale.SaleDate', Interval: 'day' }, { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Errors.ByDay).to.include({ Code: 'FACET_INTERVAL_TOO_FINE', Status: 422 });
					Expect(pEnvelope.Errors.ByDay.Detail.Suggest).to.deep.equal({ Interval: 'week' });
					Expect(pEnvelope.Facets).to.have.property('Pay');
					Expect(pEnvelope.Facets).to.not.have.property('ByDay');
				}
			},

			// ---- K3 NumericHistogram
			{
				Name: 'F6 BookStoreSale.TotalAmount Nice histogram (decimal edges) and exact Decimal Stats',
				Entity: 'BookStoreSale',
				Body: { Facets: [ { Key: 'Amount', Facet: 'BookStoreSale.TotalAmount' }, { Key: 'AmountStats', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' } ] },
				Check: (pEnvelope) =>
				{
					let tmpStats = pEnvelope.Facets.AmountStats.Stats;
					Expect(tmpStats.Sum).to.match(/^-?[0-9]+\.[0-9]{2}$/);
					Expect(pEnvelope.Facets.Amount.Geometry.Mode).to.equal('Nice');
					Expect(pEnvelope.Facets.Amount.Buckets[pEnvelope.Facets.Amount.Buckets.length - 1].EndExclusive).to.equal(false);
				}
			},
			{
				Name: 'F7 Book.PublicationYear Nice histogram with a negative outlier (integer edges), Buckets 7',
				Entity: 'Book',
				Body: { Facets: [ { Key: 'Year', Facet: 'Book.PublicationYear', Buckets: 7 } ] },
				Check: (pEnvelope) =>
				{
					let tmpGeometry = pEnvelope.Facets.Year.Geometry;
					Expect(tmpGeometry.Edges.every((pEdge) => { return Number.isInteger(pEdge); })).to.equal(true);
					Expect(pEnvelope.Facets.Year.Bounds.Lo).to.be.below(0);
				}
			},
			{
				Name: 'NumericHistogram in Edges mode, closed and open-ended (out-of-range rows are OtherCount)',
				Entity: 'Book',
				Body:
					{
						Facets:
							[
								{ Key: 'Closed', Facet: 'Book.PublicationYear', Edges: [ 1800, 1900, 1950, 2000 ] },
								{ Key: 'Open', Facet: 'Book.PublicationYear', Mode: 'Edges', Edges: [ 1900, 1990, 2010 ], OpenEnded: true }
							]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Closed.OtherCount).to.be.above(0);
					Expect(pEnvelope.Facets.Open.Buckets[pEnvelope.Facets.Open.Buckets.length - 1]).to.not.have.property('End');
				}
			},
			{
				Name: 'NumericHistogram on a small integer domain (Review.Rating, Buckets 3) and on a sale-item decimal',
				Entity: 'Review',
				Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Buckets: 3 } ] }
			},
			{
				Name: 'NumericHistogram on BookStoreSaleItem.LineTotal with a quantity clause',
				Entity: 'BookStoreSaleItem',
				Body:
					{
						Clauses: [ { Type: 'NumericRange', FilterByColumn: 'Quantity', Values: { Start: 2 } } ],
						Facets: [ { Key: 'Line', Facet: 'BookStoreSaleItem.LineTotal', Buckets: 10 }, { Key: 'Qty', Facet: 'BookStoreSaleItem.Quantity', Fold: 'Terms' } ]
					}
			},

			// ---- K4 Ranges
			{
				Name: 'Ranges on an integer column (first matching range wins) and on a decimal column',
				Entity: 'Review',
				Body: { Facets: [ { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: RATING_RANGES } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Band.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 'low', 'mid', 'top' ]);
					Expect(pEnvelope.Facets.Band.Buckets[0].Label).to.equal('Low');
				}
			},
			{
				Name: 'Ranges on BookStoreSale.TotalAmount under a NumericRange selection',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 50, End: 200 }, EndExclusive: true } ],
						Facets: [ { Key: 'Band', Facet: 'BookStoreSale.TotalAmount', Fold: 'Ranges', Ranges: AMOUNT_RANGES } ]
					},
				Check: (pEnvelope) =>
				{
					let tmpSelected = pEnvelope.Facets.Band.Buckets.filter((pBucket) => { return pBucket.Selected; }).map((pBucket) => { return pBucket.Key; });
					Expect(tmpSelected).to.deep.equal([ 'medium' ]);
				}
			},

			{
				Name: 'Overlapping Ranges (first match wins): Clauses select the effective span; shadowed or split ranges get no Clause',
				Entity: 'Review',
				Body:
					{
						Facets:
							[
								{
									Key: 'Overlap', Facet: 'Review.Rating', Fold: 'Ranges',
									Ranges: [ { Key: 'a', To: 2 }, { Key: 'b', From: 1, To: 4 }, { Key: 'c', From: 3 }, { Key: 'd', From: 2, To: 3 } ]
								},
								{ Key: 'Split', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: [ { Key: 'mid', From: 2, To: 4 }, { Key: 'rest', From: 1 } ] }
							]
					},
				Check: (pEnvelope) =>
				{
					let tmpByKey = {};
					pEnvelope.Facets.Overlap.Buckets.forEach((pBucket) => { tmpByKey[pBucket.Key] = pBucket; });
					// Declared spans stay on the bucket; the Clause carries what the bucket really holds.
					Expect(tmpByKey.b).to.include({ Start: 1, End: 4 });
					Expect(tmpByKey.b.Clause.Values).to.deep.equal({ Start: 2, End: 4 });
					Expect(tmpByKey.c.Clause.Values).to.deep.equal({ Start: 4 });
					Expect(tmpByKey.d).to.include({ Count: 0, Clause: null });
					Expect(tmpByKey.d.Selection).to.deep.equal({ Facet: 'Review.Rating', Key: 'd' });
					let tmpRest = pEnvelope.Facets.Split.Buckets.find((pBucket) => { return pBucket.Key === 'rest'; });
					Expect(tmpRest.Clause).to.equal(null);
					Expect(tmpRest.Count).to.be.above(0);
				}
			},

			// ---- K5 Stats, K6 DistinctCount, K7 Missing
			{
				Name: 'Stats on integer, DateTime and Decimal columns; DistinctCount on an FK; Missing on a nullable FK',
				Entity: 'BookStoreSale',
				Body:
					{
						Facets:
							[
								{ Key: 'DateStats', Facet: 'BookStoreSale.SaleDate', Fold: 'Stats' },
								{ Key: 'StoreDistinct', Facet: 'BookStoreSale.IDBookStore', Fold: 'DistinctCount' },
								{ Key: 'StoreMissing', Facet: 'BookStoreSale.IDBookStore', Fold: 'Missing' },
								{ Key: 'DateMissing', Facet: 'BookStoreSale.SaleDate', Fold: 'Missing' }
							]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.DateStats.Stats.Min).to.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/);
					Expect(pEnvelope.Facets.DateStats.Stats.Sum).to.equal(null);
					Expect(pEnvelope.Facets.StoreDistinct.DistinctCount).to.be.above(0);
				}
			},
			{
				Name: 'Stats on an integer column with an outlier (Book.PublicationYear) and on BookStoreInventory.BookCount',
				Entity: 'Book',
				Body: { Facets: [ { Key: 'YearStats', Facet: 'Book.PublicationYear', Fold: 'Stats' }, { Key: 'YearDistinct', Facet: 'Book.PublicationYear', Fold: 'DistinctCount' } ] },
				Check: (pEnvelope) =>
				{
					Expect(Number.isInteger(pEnvelope.Facets.YearStats.Stats.Sum)).to.equal(true);
				}
			},

			// ---- K14 Pivot
			{
				Name: 'F16 Pivot PaymentMethod × SaleDate year (marginals, null keys into Missing)',
				Entity: 'BookStoreSale',
				Body: { Facets: [ { Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.SaleDate' ], Fold: 'Pivot', Interval: 'year', Chart: true } ] },
				Check: (pEnvelope) =>
				{
					let tmpPivot = pEnvelope.Facets.Cross;
					let tmpRows = tmpPivot.Marginals.Rows.reduce((pSum, pEntry) => { return pSum + pEntry.Count; }, 0);
					let tmpColumns = tmpPivot.Marginals.Columns.reduce((pSum, pEntry) => { return pSum + pEntry.Count; }, 0);
					Expect(tmpRows).to.equal(tmpColumns);
					Expect(tmpPivot.Marginals.Total).to.equal(tmpPivot.SumOfCounts);
					Expect(pEnvelope.Facets.Cross.MissingCount).to.be.above(0);
				}
			},
			{
				Name: 'Pivot with a Ranges axis and a per-axis Top, under a clause on one axis (Exclude None)',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash', 'Debit' ] } ],
						Facets: [ { Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.TotalAmount' ], Fold: 'Pivot', Ranges: AMOUNT_RANGES, Top: 2 } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Cross.RowKeys.length).to.equal(2);
					Expect(pEnvelope.Facets.Cross.Disjunctive).to.equal('NotApplicable');
				}
			},
			{
				// A Range axis counts a value in no declared range exactly as the Ranges fold does: Other,
				// never Missing (the axis-1 clause keeps NULL payment methods out of the comparison).
				Name: 'Pivot Range axis vs the Ranges fold: no-range rows are Other on both, NULLs are Missing on both',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash', 'Debit' ] } ],
						Facets:
							[
								{ Key: 'Cross', Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.TotalAmount' ], Fold: 'Pivot', Ranges: GAPPED_AMOUNT_RANGES },
								{ Key: 'Band', Facet: 'BookStoreSale.TotalAmount', Fold: 'Ranges', Ranges: GAPPED_AMOUNT_RANGES }
							]
					},
				Check: (pEnvelope) =>
				{
					let tmpCross = pEnvelope.Facets.Cross;
					let tmpBand = pEnvelope.Facets.Band;
					Expect(tmpCross.Total).to.equal(tmpBand.Total);
					Expect(tmpBand.OtherCount).to.be.above(0);
					Expect(tmpBand.MissingCount).to.be.above(0);
					Expect(tmpCross.MissingCount).to.equal(tmpBand.MissingCount);
					Expect(tmpCross.OtherCount).to.equal(tmpBand.OtherCount);
					Expect(tmpCross.SumOfCounts).to.equal(tmpBand.SumOfCounts);
					Expect(tmpCross.ColumnKeys).to.not.include('#NoRange');
				}
			},
			{
				Name: 'Pivot of a Boolean and a String axis with Exclude Self',
				Entity: 'BookStoreEmployee',
				Body:
					{
						Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'IsActive', Values: [ 1 ] } ],
						Facets: [ { Key: 'Cross', Facet: [ 'BookStoreEmployee.IsActive', 'BookStoreEmployee.Title' ], Fold: 'Pivot', Exclude: 'Self', Order: 'KeyAsc' } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Cross.Disjunctive).to.equal('Exact');
					Expect(pEnvelope.Facets.Cross.RowKeys).to.deep.equal([ 0, 1 ]);
				}
			},

			// ---- disjunctive faceting
			{
				Name: 'F18 Review.Rating under FBV~Rating~GE~4: Self excludes the filter, None keeps it',
				Entity: 'Review',
				Body:
					{
						FilterString: 'FBV~Rating~GE~4',
						Facets: [ { Key: 'Self', Facet: 'Review.Rating', Fold: 'Terms' }, { Key: 'None', Facet: 'Review.Rating', Fold: 'Terms', Exclude: 'None' } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Self.Buckets.length).to.equal(5);
					Expect(pEnvelope.Facets.Self.Excluded).to.deep.equal([ 'c1' ]);
					// Terms selections come from IN / EQ only (internal-contracts §10.8): a GE bound selects no key.
					Expect(pEnvelope.Facets.Self.Buckets.some((pBucket) => { return pBucket.Selected; })).to.equal(false);
					Expect(pEnvelope.Facets.None.Buckets.length).to.equal(2);
					Expect(pEnvelope.Facets.None.Disjunctive).to.equal('NotApplicable');
					Expect(pEnvelope.Facets.Self.Total).to.be.above(pEnvelope.Total);
					Expect(pEnvelope.Facets.None.Total).to.equal(pEnvelope.Total);
				}
			},
			{
				Name: 'Multi-facet disjunctive request: each facet excludes only its own conjuncts (clauses and FilterString)',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses:
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash' ], Hash: 'pay' },
								{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2023-01-01', End: '2024-01-01' }, EndExclusive: true, Hash: 'date' }
							],
						FilterString: 'FBV~TotalAmount~GE~20',
						Facets:
							[
								{ Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' },
								{ Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate' },
								{ Key: 'Amount', Facet: 'BookStoreSale.TotalAmount', Buckets: 8 },
								{ Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 5 },
								{ Key: 'AmountStats', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' }
							]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Pay.Excluded).to.deep.equal([ 'pay' ]);
					Expect(pEnvelope.Facets.ByMonth.Excluded).to.deep.equal([ 'date' ]);
					Expect(pEnvelope.Facets.Amount.Excluded).to.deep.equal([ 'c3' ]);
					Expect(pEnvelope.Facets.Store.Excluded).to.deep.equal([]);
					Expect(pEnvelope.Facets.Store.Total).to.equal(pEnvelope.Total);
					Expect(pEnvelope.Facets.AmountStats.Total).to.equal(pEnvelope.Total);
					Expect(pEnvelope.Facets.ByMonth.Buckets.filter((pBucket) => { return pBucket.Selected; }).length).to.equal(12);
				}
			},
			{
				Name: 'An explicit Exclude list by clause Hash on a Stats facet',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 100 }, Hash: 'big' } ],
						Facets: [ { Key: 'Kept', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' }, { Key: 'Dropped', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats', Exclude: [ 'big' ] } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Kept.Total).to.equal(pEnvelope.Total);
					Expect(pEnvelope.Facets.Dropped.Total).to.be.above(pEnvelope.Total);
					Expect(pEnvelope.Facets.Dropped.Excluded).to.deep.equal([ 'big' ]);
				}
			},

			// ---- filter precedence and clause types
			{
				Name: 'FBVOR precedence: (A AND B) OR C is one mixed conjunct (kept, Partial)',
				Entity: 'BookStoreSale',
				Body:
					{
						FilterString: 'FBV~PaymentMethod~EQ~Credit~FBV~IDBookStore~EQ~3~FBVOR~PaymentMethod~EQ~Cash',
						Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' }, { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 5 } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Pay.Disjunctive).to.equal('Partial');
					Expect(pEnvelope.Facets.Pay.KeptMixed).to.deep.equal([ 'c1' ]);
					Expect(Object.keys(countsOf(pEnvelope.Facets.Pay)).sort()).to.deep.equal([ 'Cash', 'Credit' ]);
				}
			},
			{
				Name: 'A fenced OR group is its own conjunct: excluded by the facet it belongs to (Exact)',
				Entity: 'BookStoreSale',
				Body:
					{
						FilterString: 'FBV~IDBookStore~EQ~3~FOP~0~(~0~FBV~PaymentMethod~EQ~Credit~FBVOR~PaymentMethod~EQ~Cash~FCP~0~)~0',
						Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Pay.Disjunctive).to.equal('Exact');
					Expect(pEnvelope.Facets.Pay.Excluded).to.deep.equal([ 'c2' ]);
					Expect(pEnvelope.Facets.Pay.Buckets.filter((pBucket) => { return pBucket.Selected; }).map((pBucket) => { return pBucket.Key; }).sort()).to.deep.equal([ 'Cash', 'Credit' ]);
				}
			},
			{
				Name: 'RawFilter with FBVOR: never excluded (kept, Partial) and never a selection',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses: [ { Type: 'RawFilter', Value: 'FBV~PaymentMethod~EQ~Credit~FBVOR~PaymentMethod~EQ~Online', Hash: 'raw' } ],
						Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Pay.Disjunctive).to.equal('Partial');
					Expect(pEnvelope.Facets.Pay.Excluded).to.deep.equal([]);
					Expect(Object.keys(countsOf(pEnvelope.Facets.Pay)).sort()).to.deep.equal([ 'Credit', 'Online' ]);
					Expect(pEnvelope.Facets.Pay.Buckets.some((pBucket) => { return pBucket.Selected; })).to.equal(false);
				}
			},
			{
				Name: 'A GUIDGroup OR junction across two fields is one mixed conjunct',
				Entity: 'BookStoreSale',
				Body:
					{
						Clauses:
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Cash' ], GUIDGroup: 'g1', Junction: 'OR' },
								{ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 300 }, GUIDGroup: 'g1', Junction: 'OR' }
							],
						Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' }, { Key: 'Amount', Facet: 'BookStoreSale.TotalAmount', Buckets: 5 } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Pay.Disjunctive).to.equal('Partial');
					Expect(pEnvelope.Facets.Amount.Disjunctive).to.equal('Partial');
				}
			},
			{
				Name: 'StringMatch (LIKE) on a filterable non-facet column, a DateRange with only Start, a NumericRange bound of 0',
				Entity: 'Book',
				Body:
					{
						Clauses:
							[
								{ Type: 'StringMatch', FilterByColumn: 'Title', Values: [ 'the' ] },
								{ Type: 'DateRange', FilterByColumn: 'CreateDate', Values: { Start: '2015-01-01' } },
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 0 } }
							],
						Facets: [ { Key: 'Lang', Facet: 'Book.Language' }, { Key: 'Year', Facet: 'Book.PublicationYear', Buckets: 5 } ]
					},
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.Year.Bounds.Lo).to.be.below(0);
					Expect(pEnvelope.Facets.Lang.Total).to.equal(pEnvelope.Total);
				}
			},
			{
				Name: 'FSF stanzas are stripped with a warning',
				Entity: 'Review',
				Body: { FilterString: 'FBV~Rating~GE~2~FSF~Rating~ASC~0', Facets: [ { Key: 'Book', Facet: 'Review.IDBook', Top: 3 } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Filter.Warnings.map((pWarning) => { return pWarning.Code; })).to.include('FACET_SORT_IGNORED');
				}
			},

			// ---- soft delete and NULLs
			{
				Name: 'F21 Show-deleted (RawFilter FBL~Deleted~INN~0,1) counts soft-deleted rows',
				Entity: 'Review',
				Body:
					{
						Clauses: [ { Type: 'RawFilter', Value: 'FBL~Deleted~INN~0,1' } ],
						Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ]
					},
				Check: (pEnvelope, pHarness) =>
				{
					Expect(pEnvelope.IncludesDeleted).to.equal(true);
					Expect(pEnvelope.Total).to.equal(pHarness.seed.Counts.Review);
					Expect(pEnvelope.Total).to.be.above(pHarness.seed.LiveCounts.Review);
				}
			},
			{
				Name: 'Only soft-deleted rows (FilterString FBV~Deleted~EQ~1)',
				Entity: 'BookStoreSale',
				Body: { FilterString: 'FBV~Deleted~EQ~1', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] },
				Check: (pEnvelope, pHarness) =>
				{
					Expect(pEnvelope.Total).to.equal(pHarness.seed.Counts.BookStoreSale - pHarness.seed.LiveCounts.BookStoreSale);
				}
			},
			{
				Name: 'Default soft delete: no deleted row is ever counted',
				Entity: 'Book',
				Body: { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 50 }, { Key: 'Genre', Facet: 'Book.Genre', Top: 50 } ] },
				Check: (pEnvelope, pHarness) =>
				{
					Expect(pEnvelope.Total).to.equal(pHarness.seed.LiveCounts.Book);
					Expect(pEnvelope.IncludesDeleted).to.equal(false);
				}
			},
			{
				Name: 'NOT NULL filter (FBV~SaleDate~NN~0) leaves no missing dates',
				Entity: 'BookStoreSale',
				Body: { FilterString: 'FBV~SaleDate~NN~0', Facets: [ { Key: 'ByYear', Facet: 'BookStoreSale.SaleDate', Interval: 'year', Exclude: 'None' }, { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Facets.ByYear.MissingCount).to.equal(0);
				}
			},
			{
				// O1 only: the stock SQLite list cannot render IS NULL (FH-2), so the list oracle cannot count it.
				Name: 'IS NULL filter (FBV~SaleDate~IN~0) selects exactly the missing dates (O1 only, FH-2)',
				Entity: 'BookStoreSale',
				Body: { FilterString: 'FBV~SaleDate~IN~0', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' }, { Key: 'DateMissing', Facet: 'BookStoreSale.SaleDate', Fold: 'Missing' } ] },
				O2: false,
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope.Total).to.be.above(0);
					Expect(pEnvelope.Facets.DateMissing.MissingCount).to.equal(pEnvelope.Total);
				}
			},
			{
				Name: 'Total: false omits the envelope Total',
				Entity: 'BookStoreInventory',
				Body: { Total: false, Facets: [ { Key: 'Stock', Facet: 'BookStoreInventory.BookCount' }, { Key: 'Associate', Facet: 'BookStoreInventory.StockingAssociate', Top: 5 }, { Key: 'Stocked', Facet: 'BookStoreInventory.StockDate', Interval: 'quarter' } ] },
				Check: (pEnvelope) =>
				{
					Expect(pEnvelope).to.not.have.property('Total');
				}
			},
			{
				Name: 'An entity without a delete column (BookStoreCatalogJoin) with FK Terms',
				Entity: 'BookStoreCatalogJoin',
				Body: { Facets: [ { Key: 'Store', Facet: 'BookStoreCatalogJoin.IDBookStore', Top: 10 } ] }
			}
		];

	return { Fixtures: BOOKSTORE_FIXTURES, RatingRanges: RATING_RANGES };
};

module.exports = (
	{
		build: build
	});
