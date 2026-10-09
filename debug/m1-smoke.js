#!/usr/bin/env node
/**
 * Milestone 1 smoke run: boots the test harness (plain retold-data-service, Embedded faceting,
 * seeded Bookstore on in-memory SQLite) on port 19190, prints the Describe manifest for Book and a
 * sample Query envelope over HTTP, then stops and exits.
 *
 *   node debug/m1-smoke.js
 *
 * The sample query: Book by PublicationYear (NumericHistogram) plus Language (Terms), with a
 * Language clause; the Language facet excludes its own clause (disjunctive) and marks the selected
 * bucket.  Exit code 0 when both calls answer 200, 1 otherwise.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libHarness = require('../test/support/Facet-Test-Harness.js');

const PORT = 19190;

const SAMPLE_QUERY =
	{
		Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'eng' ], FilterKey: 'Language', Hash: 'Language-eng' } ],
		Facets:
			[
				{ Key: 'ByYear', Facet: 'Book.PublicationYear', Buckets: 10 },
				{ Key: 'ByLanguage', Facet: 'Book.Language', Top: 8 }
			],
		Total: true
	};

let tmpExitCode = 1;

// A debug script pins its registry port (tests bind ephemeral ports).
let _Harness = libHarness.start({ Port: PORT, FixedPort: true, Fixture: 'Bookstore', LogLevel: 'error' },
	(pStartError) =>
	{
		if (pStartError)
		{
			console.error(`Harness failed to start: ${pStartError.message}`);
			return _Harness.stop(() => { process.exit(1); });
		}
		console.log(`Retold faceting M1 smoke: ${_Harness.baseURL} (seed ${_Harness.seed.Seed}, ${_Harness.seed.LiveCounts.Book} live books)\n`);

		_Harness.request('GET', '/1.0/Facet/Book/Describe', null, {},
			(pDescribeError, pDescribe) =>
			{
				if (pDescribeError)
				{
					console.error(`Describe failed: ${pDescribeError.message}`);
					return _Harness.stop(() => { process.exit(1); });
				}
				console.log(`GET /1.0/Facet/Book/Describe → ${pDescribe.Status}`);
				console.log(JSON.stringify(pDescribe.Body, null, '\t'));
				console.log('');

				_Harness.facetQuery('Book', SAMPLE_QUERY, {},
					(pQueryError, pQuery) =>
					{
						if (pQueryError)
						{
							console.error(`Query failed: ${pQueryError.message}`);
							return _Harness.stop(() => { process.exit(1); });
						}
						console.log(`POST /1.0/Facet/Book/Query → ${pQuery.Status}  ETag ${pQuery.Headers.etag}`);
						console.log(JSON.stringify(SAMPLE_QUERY, null, '\t'));
						console.log('');
						console.log(JSON.stringify(pQuery.Body, null, '\t'));
						tmpExitCode = ((pDescribe.Status === 200) && (pQuery.Status === 200)) ? 0 : 1;
						return _Harness.stop(() => { process.exit(tmpExitCode); });
					});
			});
	});
