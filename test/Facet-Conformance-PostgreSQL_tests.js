/**
 * Facet-Conformance-PostgreSQL (internal-contracts §33): the faceting service executed on a real
 * PostgreSQL (the dedicated rfs-test-postgres container, or RFS_TEST_POSTGRES_URL).
 *
 *   always (no server)  the provider hook's DDL / coercion / gating rules, the docker guard, the
 *                       PostgreSQL dialect's bind renaming and shell bind hygiene;
 *   gated               (RFS_TEST_POSTGRES=1 or RFS_TEST_POSTGRES_URL, and TZ=UTC: `npm run test:pg`)
 *     - the provider hook lifecycle (fresh C-collated database, nullable typed DDL, coercions,
 *       sequences, counts, drop on release, the leftover sweep);
 *     - O1 + O2 for EVERY request of Facet-Conformance-SQLite_tests.js (read from that file, so the
 *       two lists never drift), with the two PostgreSQL deltas applied (LIKE is case-sensitive; the
 *       list CAN render IS NULL, so that fixture gets its O2 here);
 *     - the explicit parity checks of §33.4: the corrected numericIndex on numeric (values exactly
 *       on edges, decimal edges, every bucket's clause through the list), DateHistogram on every
 *       interval equal to FacetBuckets.dateKey (ISO weeks across year ends, the boundary traps),
 *       exact Stats sums on DECIMAL, Terms over SMALLINT booleans, bigint counts arriving as
 *       strings, IS NULL predicates, Terms tie-break order under the C collation;
 *     - two-tenant isolation and ScopeGuard Strict on PostgreSQL;
 *     - the M2 domains (ProjectTrack, LabTrack) once their seeds and the M2 harness exist: O1 for
 *       the four motivating requests as every principal, O5 plan forms (cube, staged keys through
 *       `= ANY(CAST(… AS bigint[]))` / `unnest`, EXISTS chains), hand-written SQL for E1 and E3A,
 *       Records / Count routes, tenant-2 isolation.
 *
 * Without the gate every PostgreSQL suite is pending, so plain `npm test` stays SQLite-only.
 *
 * Port 19125 (internal-contracts §32.4); the harnesses of the suites below run one after the other.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFable = require('fable');

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libDockerPostgres = require('./support/Facet-Docker-Postgres.js');
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');
const libConformanceFixtures = require('./fixtures/Bookstore-Conformance-Fixtures.js');

const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libDialects = require('../source/engine/live/Retold-Faceting-Dialects.js');
const libShellTemplatesPostgreSQL = require('../source/engine/live/Shell-Templates-PostgreSQL.js');

const PORT = 19125;

const POSTGRES = libProviders.available('PostgreSQL');

// Suites gate ONLY on the provider being available (RFS_TEST_POSTGRES=1 / RFS_TEST_POSTGRES_URL):
// any other unmet precondition is a hard failure in suiteSetup, never a pending suite.
const POSTGRES_READY = POSTGRES.Available;

const TEST_NOW = '2026-10-08T12:00:00Z';
const TEST_NOW_SQL = '2026-10-08 12:00:00';

const INTERVALS = [ 'day', 'week', 'month', 'quarter', 'year' ];

/**
 * suite, or suite.skip when the gate is closed (mocha shows the suite as pending).
 *
 * @param {boolean} pReady
 * @return {Function}
 */
const gatedSuite = (pReady) =>
{
	return pReady ? suite : suite.skip;
};

/**
 * The deep-equal message for an O1 mismatch: the first differing facet.
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
	let tmpLiveRest = JSON.stringify(Object.assign({}, pLive, { Facets: null }));
	let tmpReferenceRest = JSON.stringify(Object.assign({}, pReference, { Facets: null }));
	return `envelope fields differ\n  Live:      ${tmpLiveRest.slice(0, 1500)}\n  Reference: ${tmpReferenceRest.slice(0, 1500)}`;
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

/**
 * The non-empty buckets of a facet as { Key: Count }.
 *
 * @param {Record<string, any>} pFacet
 * @return {Record<string, number>}
 */
const nonEmptyCountsOf = (pFacet) =>
{
	let tmpCounts = {};
	pFacet.Buckets.forEach((pBucket) => { if (pBucket.Count > 0) { tmpCounts[String(pBucket.Key)] = pBucket.Count; } });
	return tmpCounts;
};

/**
 * Rows of one SQL statement on the harness's PostgreSQL database (test-side oracle).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pSQL
 * @param {Array<any>} pValues
 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
 */
const sqlRows = (pHarness, pSQL, pValues, fCallback) =>
{
	pHarness.connection.pool.query(pSQL, pValues || [],
		(pError, pResult) =>
		{
			// Leave pg's stack before asserting.
			setImmediate(() => { return pError ? fCallback(pError) : fCallback(null, pResult.rows); });
		});
};

/**
 * Run one statement exactly the way the Live engine does: a fresh query of an entity's DAL with the
 * SQL as its override and the binds as NAMED parameters, executed by the meadow PostgreSQL provider
 * (so the provider's named → positional conversion is part of what is tested).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity - whose DAL runs the statement
 * @param {string} pSQL - with :name binds
 * @param {Record<string, any>} pParams
 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
 */
const providerRows = (pHarness, pEntity, pSQL, pParams, fCallback) =>
{
	let tmpDAL = pHarness.fable.MeadowEndpoints[pEntity].controller.DAL;
	let tmpQuery = tmpDAL.query;
	tmpQuery.setDisableDeleteTracking(true);
	tmpQuery.parameters.queryOverride = pSQL;
	Object.assign(tmpQuery.query.parameters, pParams || {});
	let tmpDone = false;
	let fFinish = (pError) =>
	{
		if (tmpDone)
		{
			return;
		}
		tmpDone = true;
		let tmpResult = tmpQuery.parameters.result || {};
		let tmpError = pError || tmpResult.error || null;
		setImmediate(() => { return tmpError ? fCallback(tmpError) : fCallback(null, (Array.isArray(tmpResult.value) ? tmpResult.value : []).map((pRow) => { return Object.assign({}, pRow); })); });
	};
	try
	{
		tmpDAL.provider.Read(tmpQuery, () => { return fFinish(null); });
	}
	catch (pReadError)
	{
		fFinish(pReadError);
	}
};

/**
 * Watch every statement the harness's DALs execute for the two binds the meadow PostgreSQL provider
 * mishandles: its named → positional conversion expands an ARRAY bind only at its first reference
 * (a second reference silently binds the first element alone — a wrong answer, not an error), and
 * renders an empty array as `IN ( )` (a syntax error).  The facet's relations bind IN lists as arrays,
 * so a statement that splices one relation twice under one alias, or an empty list, would be wrong on
 * PostgreSQL only.  Returns the (live) list of violations.
 *
 * @param {Record<string, any>} pHarness
 * @return {Array<Record<string, any>>}
 */
const installArrayBindGuard = (pHarness) =>
{
	let tmpViolations = [];
	Object.keys(pHarness.fable.MeadowEndpoints || {}).forEach(
		(pEntity) =>
		{
			let tmpProvider = pHarness.fable.MeadowEndpoints[pEntity].controller.DAL.provider;
			if (!tmpProvider || tmpProvider.RFSArrayBindGuard)
			{
				return;
			}
			let fRead = tmpProvider.Read;
			tmpProvider.Read = function (pQuery, fCallback)
			{
				try
				{
					// Building twice is idempotent (the provider builds again): only the text is read here.
					pQuery.setDialect('PostgreSQL').buildReadQuery();
					let tmpBody = String(pQuery.query.body || '');
					let tmpParams = pQuery.query.parameters || {};
					Object.keys(tmpParams).forEach(
						(pName) =>
						{
							if (!Array.isArray(tmpParams[pName]))
							{
								return;
							}
							let tmpReferences = (tmpBody.match(new RegExp(`(^|[^:A-Za-z0-9_]):${pName}(?![A-Za-z0-9_])`, 'g')) || []).length;
							if ((tmpReferences > 1) || ((tmpReferences > 0) && (tmpParams[pName].length < 1)))
							{
								tmpViolations.push({ Entity: pEntity, Param: pName, References: tmpReferences, Length: tmpParams[pName].length, SQL: tmpBody.slice(0, 400) });
							}
						});
				}
				catch (pBuildError)
				{
					// The real Read reports build errors.
				}
				return fRead.call(this, pQuery, fCallback);
			};
			tmpProvider.RFSArrayBindGuard = true;
		});
	return tmpViolations;
};

/**
 * Every count-like field of an envelope (Total, bucket Counts, Sum/Missing/Other) is a JS integer:
 * PostgreSQL's bigint counts arrive as strings and must never leak through.
 *
 * @param {Record<string, any>} pEnvelope
 */
const assertNumericCounts = (pEnvelope) =>
{
	if (Object.prototype.hasOwnProperty.call(pEnvelope, 'Total'))
	{
		Expect(Number.isInteger(pEnvelope.Total), 'envelope Total').to.equal(true);
	}
	Object.keys(pEnvelope.Facets || {}).forEach(
		(pKey) =>
		{
			let tmpFacet = pEnvelope.Facets[pKey];
			[ 'Total', 'SumOfCounts', 'MissingCount', 'DistinctCount' ].forEach(
				(pField) =>
				{
					if ((typeof(tmpFacet[pField]) !== 'undefined') && (tmpFacet[pField] !== null))
					{
						Expect(Number.isInteger(tmpFacet[pField]), `${pKey}.${pField} = ${JSON.stringify(tmpFacet[pField])}`).to.equal(true);
					}
				});
			(Array.isArray(tmpFacet.Buckets) ? tmpFacet.Buckets : []).forEach(
				(pBucket) =>
				{
					Expect(Number.isInteger(pBucket.Count), `${pKey} bucket ${JSON.stringify(pBucket.Key)} Count = ${JSON.stringify(pBucket.Count)}`).to.equal(true);
				});
		});
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
			assertNumericCounts(pResult.Live.Body);
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

// ---------------------------------------------------------------- the M1 requests, shared with the SQLite suite

/**
 * The PostgreSQL deltas to the SQLite fixture list, by Name prefix.  Every prefix must match a
 * fixture (a renamed SQLite fixture is caught here, not silently dropped).
 */
const POSTGRES_FIXTURE_DELTAS =
	[
		{
			Prefix: 'StringMatch (LIKE)',
			Note: 'PostgreSQL LIKE is case-sensitive (on the list and on the facet alike): match the capitalized article',
			Apply: (pFixture) =>
			{
				let tmpBody = JSON.parse(JSON.stringify(pFixture.Body));
				tmpBody.Clauses.forEach((pClause) => { if (pClause.Type === 'StringMatch') { pClause.Values = [ 'The' ]; } });
				return Object.assign({}, pFixture,
					{
						Body: tmpBody,
						Check: (pEnvelope) =>
						{
							Expect(pEnvelope.Total).to.be.above(0);
							Expect(pEnvelope.Facets.Lang.Total).to.equal(pEnvelope.Total);
						}
					});
			}
		},
		{
			Prefix: 'IS NULL filter',
			Note: 'the PostgreSQL list renders IS NULL, so the round trip (O2) is checked here too',
			Apply: (pFixture) =>
			{
				return Object.assign({}, pFixture, { Name: `${pFixture.Name} — with O2 on PostgreSQL`, O2: true });
			}
		}
	];

/**
 * The Bookstore conformance list (test/fixtures/Bookstore-Conformance-Fixtures.js, the one the SQLite
 * suite runs) built with this file's Expect and countsOf, with the PostgreSQL deltas applied, so the
 * PostgreSQL run always covers exactly the SQLite list.  A missing delta target throws at load.
 *
 * @return {{ Fixtures: Array<Record<string, any>>, RatingRanges: Array<any>, Error: Error|null }}
 */
const loadConformanceFixtures = () =>
{
	let tmpLoaded = libConformanceFixtures.build(Expect, countsOf, libHarness);
	let tmpFixtures = tmpLoaded.Fixtures.slice();
	for (let i = 0; i < POSTGRES_FIXTURE_DELTAS.length; i++)
	{
		let tmpDelta = POSTGRES_FIXTURE_DELTAS[i];
		let tmpIndex = tmpFixtures.findIndex((pFixture) => { return String(pFixture.Name).indexOf(tmpDelta.Prefix) === 0; });
		if (tmpIndex < 0)
		{
			throw new Error(`no SQLite fixture named [${tmpDelta.Prefix}…] for the PostgreSQL delta (${tmpDelta.Note})`);
		}
		tmpFixtures[tmpIndex] = tmpDelta.Apply(tmpFixtures[tmpIndex]);
	}
	return { Fixtures: tmpFixtures, RatingRanges: tmpLoaded.RatingRanges, Error: null };
};

const CONFORMANCE = loadConformanceFixtures();

// ---------------------------------------------------------------- the M2 domains


/**
 * The E1 body of internal-contracts §31.5.
 *
 * @param {Record<string, any>} pTraps
 * @return {Record<string, any>}
 */
const bodyE1 = (pTraps) =>
{
	return (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: pTraps.E1ClientIDs, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
					{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
					{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
				],
			Total: true,
			Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
		});
};

/**
 * The E2 body of internal-contracts §31.5.
 *
 * @param {Record<string, any>} pTraps
 * @return {Record<string, any>}
 */
const bodyE2 = (pTraps) =>
{
	return (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ pTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
				],
			Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
			Records: { Begin: 0, Cap: 100 }
		});
};

const BODY_E3A =
	{
		Facets:
			[
				{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
				{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
				{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
			]
	};

const BODY_E3B =
	{
		Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ]
	};

// Coverage facets of the definitions files (K8 two hops, K9, K10 two hops, K19, K20).
const PROJECTTRACK_COVERAGE =
	[
		{ Name: 'K9 Project.ByMember and K20 Project.HasOpenIssues', Entity: 'Project', Body: { Facets: [ { Key: 'ByMember', Facet: 'Project.ByMember' }, { Key: 'Open', Facet: 'Project.HasOpenIssues' } ], Total: true } },
		{ Name: 'K19 scope Project.ManyOverdue', Entity: 'Project', Body: { Scopes: [ { Scope: 'Project.ManyOverdue' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ], Total: true } },
		{ Name: 'K8 two hops Document.ByClient', Entity: 'Document', Body: { Facets: [ { Key: 'Client', Facet: 'Document.ByClient' }, { Key: 'Status', Facet: 'Document.Status' } ], Total: true } },
		{ Name: 'K10 two hops: scope Document.InMyProjects', Entity: 'Document', Body: { Scopes: [ { Scope: 'Document.InMyProjects' } ], Facets: [ { Key: 'Form', Facet: 'Document.IDFormType', Top: 20 } ], Total: true } }
	];

const LABTRACK_COVERAGE =
	[
		{ Name: 'K9 through the bridge alias: MaterialIntake.ByRequiredForm', Entity: 'MaterialIntake', Body: { Facets: [ { Key: 'Required', Facet: 'MaterialIntake.ByRequiredForm' }, { Key: 'Status', Facet: 'MaterialIntake.Status' } ], Total: true } },
		{ Name: 'scope MaterialIntake.InMyQueues', Entity: 'MaterialIntake', Body: { Scopes: [ { Scope: 'MaterialIntake.InMyQueues' } ], Facets: [ { Key: 'Queue', Facet: 'MaterialIntake.IDLabQueue' }, { Key: 'Week', Facet: 'MaterialIntake.ReceivedDate', Interval: 'week' } ], Total: true } }
	];

// The plan forms O5 compares (internal-contracts §34).
const PLAN_FORMS =
	[
		{ Name: 'per Variant, nothing staged', PlanForm: { Cube: 'Never', Staged: 'Never' } },
		{ Name: 'cube always', PlanForm: { Cube: 'Always', Staged: 'Never' } },
		{ Name: 'staged always', PlanForm: { Cube: 'Never', Staged: 'Always' } },
		{ Name: 'cube and staged', PlanForm: { Cube: 'Always', Staged: 'Always' } }
	];

/**
 * In-process Live and Reference for one body as one principal with the pinned Now, normalized.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pOptions - { Tenant, User, Now, PlanForm? }
 * @param {(pError?: Error, pResult?: Record<string, any>) => void} fCallback
 */
const compareInProcess = (pHarness, pEntity, pBody, pOptions, fCallback) =>
{
	pHarness.query(pEntity, pBody, pOptions,
		(pLiveError, pLive) =>
		{
			pHarness.reference(pEntity, pBody, pOptions,
				(pReferenceError, pReference) =>
				{
					setImmediate(
						() =>
						{
							if (pLiveError || pReferenceError)
							{
								return fCallback(pLiveError || pReferenceError);
							}
							return fCallback(null,
								{
									Live: pLive,
									Reference: pReference,
									LiveNormalized: libFacetEnvelope.normalizeForComparison(pLive),
									ReferenceNormalized: libFacetEnvelope.normalizeForComparison(pReference)
								});
						});
				});
		});
};

/**
 * O1 for one in-process comparison: both engines answered every requested facet (no per-facet
 * error, so two identical refusals never count as agreement) and the envelopes are equal.
 *
 * @param {Record<string, any>} pResult - compareInProcess result
 * @param {Record<string, any>} pBody - the request (its facet Keys must all be answered)
 */
const assertSameEnvelope = (pResult, pBody) =>
{
	Expect(pResult.Live.Engine).to.equal('Live');
	Expect(pResult.Reference.Engine).to.equal('Reference');
	Expect(pResult.Live.Errors || {}, JSON.stringify(pResult.Live.Errors || {}).slice(0, 600)).to.deep.equal({});
	Expect(pResult.Reference.Errors || {}, JSON.stringify(pResult.Reference.Errors || {}).slice(0, 600)).to.deep.equal({});
	((pBody && Array.isArray(pBody.Facets)) ? pBody.Facets : []).forEach((pSpec) => { Expect(pResult.Live.Facets, `facet ${pSpec.Key}`).to.have.property(pSpec.Key); });
	if (JSON.stringify(pResult.LiveNormalized) !== JSON.stringify(pResult.ReferenceNormalized))
	{
		Expect(pResult.LiveNormalized, firstDifference(pResult.LiveNormalized, pResult.ReferenceNormalized)).to.deep.equal(pResult.ReferenceNormalized);
	}
	assertNumericCounts(pResult.Live);
};

suite
(
	'Facet-Conformance-PostgreSQL',
	() =>
	{
		// ---------------------------------------------------------------- always: the hook's rules (no server)
		suite
		(
			'Provider hook and PostgreSQL dialect rules (no server)',
			() =>
			{
				test('the gate: PostgreSQL is available only with RFS_TEST_POSTGRES=1 or RFS_TEST_POSTGRES_URL; SQLite always; unknown providers never',
					() =>
					{
						let tmpSaved = { Flag: process.env.RFS_TEST_POSTGRES, URL: process.env.RFS_TEST_POSTGRES_URL };
						try
						{
							delete process.env.RFS_TEST_POSTGRES;
							delete process.env.RFS_TEST_POSTGRES_URL;
							Expect(libProviders.available('PostgreSQL').Available).to.equal(false);
							Expect(libProviders.available('PostgreSQL').Reason).to.match(/RFS_TEST_POSTGRES/);
							process.env.RFS_TEST_POSTGRES = '0';
							Expect(libProviders.available('PostgreSQL').Available).to.equal(false);
							process.env.RFS_TEST_POSTGRES = '1';
							Expect(libProviders.available('PostgreSQL').Available).to.equal(true);
							delete process.env.RFS_TEST_POSTGRES;
							process.env.RFS_TEST_POSTGRES_URL = 'postgres://u:p@db.example:6543/x';
							Expect(libProviders.available('PostgreSQL').Available).to.equal(true);
							Expect(libProviders.available('SQLite')).to.deep.equal({ Available: true, Reason: null });
							Expect(libProviders.available('Oracle').Available).to.equal(false);
							Expect(libProviders.PROVIDERS).to.deep.equal([ 'SQLite', 'PostgreSQL' ]);
						}
						finally
						{
							[ [ 'RFS_TEST_POSTGRES', tmpSaved.Flag ], [ 'RFS_TEST_POSTGRES_URL', tmpSaved.URL ] ].forEach(
								(pPair) =>
								{
									if (typeof(pPair[1]) === 'undefined')
									{
										delete process.env[pPair[0]];
									}
									else
									{
										process.env[pPair[0]] = pPair[1];
									}
								});
						}
					});

				test('connectionInfo: the container defaults, or RFS_TEST_POSTGRES_URL parsed (decoded user / password / database)',
					() =>
					{
						let tmpSaved = process.env.RFS_TEST_POSTGRES_URL;
						try
						{
							delete process.env.RFS_TEST_POSTGRES_URL;
							let tmpContainer = libDockerPostgres.connectionInfo();
							Expect(tmpContainer).to.include({ host: '127.0.0.1', port: 15433, user: 'postgres', database: 'postgres', Source: 'Container' });
							Expect(libDockerPostgres.CONTAINER_NAME).to.equal('rfs-test-postgres');
							Expect(libDockerPostgres.IMAGE).to.equal('postgres:16-alpine');
							process.env.RFS_TEST_POSTGRES_URL = 'postgresql://some%20one:p%40ss@db.example:6543/fac%2Ddb';
							Expect(libDockerPostgres.connectionInfo()).to.deep.equal({ host: 'db.example', port: 6543, user: 'some one', password: 'p@ss', database: 'fac-db', Source: 'URL' });
							process.env.RFS_TEST_POSTGRES_URL = 'postgres://u@h';
							Expect(libDockerPostgres.connectionInfo()).to.include({ host: 'h', port: 5432, user: 'u', password: '', database: 'postgres' });
							process.env.RFS_TEST_POSTGRES_URL = 'mysql://u@h/x';
							Expect(() => { libDockerPostgres.connectionInfo(); }).to.throw(/postgres:\/\//);
						}
						finally
						{
							if (typeof(tmpSaved) === 'undefined')
							{
								delete process.env.RFS_TEST_POSTGRES_URL;
							}
							else
							{
								process.env.RFS_TEST_POSTGRES_URL = tmpSaved;
							}
						}
					});

				test('the docker guard: every command must target exactly rfs-test-postgres (never another container)',
					() =>
					{
						let fGuard = libDockerPostgres.assertOwnContainer;
						Expect(() => { fGuard([ 'ps', '-a', '--filter', 'name=^/rfs-test-postgres$' ]); }).to.not.throw();
						Expect(() => { fGuard([ 'ps', '-a' ]); }).to.throw();
						Expect(() => { fGuard([ 'run', '-d', '--name', 'rfs-test-postgres', 'postgres:16-alpine' ]); }).to.not.throw();
						Expect(() => { fGuard([ 'run', '-d', '--name', 'sluice-dev-postgres', 'postgres:16-alpine' ]); }).to.throw();
						Expect(() => { fGuard([ 'run', '-d', 'postgres:16-alpine' ]); }).to.throw();
						Expect(() => { fGuard([ 'start', 'rfs-test-postgres' ]); }).to.not.throw();
						Expect(() => { fGuard([ 'stop', 'sluice-dev-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'stop', 'rfs-test-postgres', 'sluice-dev-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'rm', '-v', 'rfs-test-postgres' ]); }).to.not.throw();
						Expect(() => { fGuard([ 'rm', '-f', 'rfs-test-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'rm', '-v', 'sluice-dev-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'exec', 'sluice-dev-postgres', 'psql' ]); }).to.throw();
						Expect(() => { fGuard([ 'exec', 'rfs-test-postgres', 'pg_isready', '-h', '127.0.0.1' ]); }).to.not.throw();
						// The name must be the exec target, not merely appear somewhere in the arguments.
						Expect(() => { fGuard([ 'exec', 'sluice-dev-postgres', 'psql', '-c', 'SELECT 1', 'rfs-test-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'exec', 'sluice-dev-postgres', 'sh', '-c', 'echo rfs-test-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'exec', 'rfs-test-postgres' ]); }).to.throw();
						// inspect is never used, so it is not allowed at all.
						Expect(() => { fGuard([ 'inspect', 'rfs-test-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'inspect', 'sluice-dev-postgres', 'rfs-test-postgres' ]); }).to.throw();
						Expect(() => { fGuard([ 'system', 'prune', '-f' ]); }).to.throw();
						Expect(() => { fGuard([ 'volume', 'rm', 'x' ]); }).to.throw();
					});

				test('per-harness database names are rfs_<pid>_<n>, distinct, and the only names the leftover sweep may drop',
					() =>
					{
						let tmpSettings = libProviders.fableSettings('PostgreSQL', {});
						let tmpOther = libProviders.fableSettings('PostgreSQL', {});
						Expect(tmpSettings.PostgreSQL.database).to.match(new RegExp(`^rfs_${process.pid}_[0-9]+$`));
						Expect(tmpOther.PostgreSQL.database).to.not.equal(tmpSettings.PostgreSQL.database);
						Expect(tmpSettings.PostgreSQL).to.include({ max: 4 });
						Expect(libProviders.fableSettings('SQLite', {})).to.deep.equal({ SQLite: { SQLiteFilePath: ':memory:' } });
						let tmpPattern = libDockerPostgres.DATABASE_NAME_PATTERN;
						Expect(tmpPattern.test('rfs_123_4')).to.equal(true);
						[ 'postgres', 'sluice', 'rfs_', 'rfs_1', 'rfs_1_2_3', 'rfs_x_1', 'xrfs_1_2', 'rfs_1_2; DROP' ].forEach((pName) => { Expect(tmpPattern.test(pName), pName).to.equal(false); });
					});

				test('DDL from the model: nullable columns, no defaults, SERIAL keys, SMALLINT booleans, DECIMAL(p,s), quoted case-preserving names',
					() =>
					{
						let tmpTypes = {};
						[
							[ { DataType: 'ID' }, 'SERIAL PRIMARY KEY' ],
							[ { DataType: 'GUID', Size: '36' }, 'VARCHAR(36)' ],
							[ { DataType: 'GUID' }, 'VARCHAR(255)' ],
							[ { DataType: 'String', Size: '128' }, 'VARCHAR(128)' ],
							[ { DataType: 'String' }, 'TEXT' ],
							[ { DataType: 'Numeric', Size: 'int' }, 'INTEGER' ],
							[ { DataType: 'Numeric', Size: 'bigint' }, 'BIGINT' ],
							[ { DataType: 'ForeignKey' }, 'INTEGER' ],
							[ { DataType: 'Decimal', Size: '10,2' }, 'DECIMAL(10,2)' ],
							[ { DataType: 'Decimal', Size: '8, 2' }, 'DECIMAL(8,2)' ],
							[ { DataType: 'Decimal' }, 'NUMERIC' ],
							[ { DataType: 'DateTime' }, 'TIMESTAMP' ],
							[ { DataType: 'Boolean' }, 'SMALLINT' ],
							[ { DataType: 'Text' }, 'TEXT' ],
							[ { DataType: 'JSON' }, 'TEXT' ]
						].forEach((pCase) => { Expect(libProviders.postgresType(pCase[0]), JSON.stringify(pCase[0])).to.equal(pCase[1]); tmpTypes[pCase[1]] = true; });

						let tmpModel = libBookstoreSeed.model('Bookstore');
						let tmpSQL = libProviders.createTableStatement('BookStoreSale', tmpModel.Tables.BookStoreSale);
						Expect(tmpSQL).to.match(/^CREATE TABLE "BookStoreSale" \("IDBookStoreSale" SERIAL PRIMARY KEY, /);
						Expect(tmpSQL).to.include('"TotalAmount" DECIMAL(10,2)');
						Expect(tmpSQL).to.include('"SaleDate" TIMESTAMP');
						Expect(tmpSQL).to.include('"Deleted" SMALLINT');
						Expect(tmpSQL).to.not.match(/NOT NULL|DEFAULT/);
						Expect(() => { libProviders.createTableStatement('Bad"Table', { Columns: [] }); }).to.throw(/refusing/);
						Expect(() => { libProviders.createTableStatement('T', { Columns: [ { Column: 'a b', DataType: 'String' } ] }); }).to.throw(/refusing/);
					});

				test('values a typed column cannot hold become NULL with a reason; everything else keeps its exact value',
					() =>
					{
						let fCoerce = libProviders.coerceValue;
						Expect(fCoerce({ DataType: 'Numeric' }, 12)).to.deep.equal({ Value: 12, Reason: null });
						Expect(fCoerce({ DataType: 'Numeric' }, '12')).to.deep.equal({ Value: 12, Reason: null });
						Expect(fCoerce({ DataType: 'Numeric' }, '')).to.deep.equal({ Value: null, Reason: 'NotInteger' });
						Expect(fCoerce({ DataType: 'Numeric' }, ' ')).to.deep.equal({ Value: null, Reason: 'NotInteger' });
						Expect(fCoerce({ DataType: 'Numeric' }, 1.5)).to.deep.equal({ Value: null, Reason: 'NotInteger' });
						Expect(fCoerce({ DataType: 'Numeric' }, true)).to.deep.equal({ Value: 1, Reason: null });
						Expect(fCoerce({ DataType: 'Numeric' }, null)).to.deep.equal({ Value: null, Reason: null });
						Expect(fCoerce({ DataType: 'Numeric' }, undefined)).to.deep.equal({ Value: null, Reason: null });
						Expect(fCoerce({ DataType: 'Boolean' }, false)).to.deep.equal({ Value: 0, Reason: null });
						Expect(fCoerce({ DataType: 'Boolean' }, '1')).to.deep.equal({ Value: 1, Reason: null });
						Expect(fCoerce({ DataType: 'Boolean' }, 2)).to.deep.equal({ Value: null, Reason: 'NotBoolean' });
						Expect(fCoerce({ DataType: 'Decimal' }, 499.996)).to.deep.equal({ Value: 499.996, Reason: null });
						Expect(fCoerce({ DataType: 'Decimal' }, '12.50')).to.deep.equal({ Value: '12.50', Reason: null });
						Expect(fCoerce({ DataType: 'Decimal' }, ' ')).to.deep.equal({ Value: null, Reason: 'NotNumeric' });
						Expect(fCoerce({ DataType: 'Decimal' }, 'abc')).to.deep.equal({ Value: null, Reason: 'NotNumeric' });
						Expect(fCoerce({ DataType: 'DateTime' }, '2023-04-01')).to.deep.equal({ Value: '2023-04-01 00:00:00', Reason: null });
						Expect(fCoerce({ DataType: 'DateTime' }, '2022-01-01T00:00:00')).to.deep.equal({ Value: '2022-01-01 00:00:00', Reason: null });
						Expect(fCoerce({ DataType: 'DateTime' }, '2023-07-01 00:00')).to.deep.equal({ Value: '2023-07-01 00:00:00', Reason: null });
						Expect(fCoerce({ DataType: 'DateTime' }, '')).to.deep.equal({ Value: null, Reason: 'NotDate' });
						Expect(fCoerce({ DataType: 'DateTime' }, '2026-02-30')).to.deep.equal({ Value: null, Reason: 'NotDate' });
						Expect(fCoerce({ DataType: 'String' }, '')).to.deep.equal({ Value: '', Reason: null });
						Expect(fCoerce({ DataType: 'String' }, 7)).to.deep.equal({ Value: '7', Reason: null });
						Expect(fCoerce({ DataType: 'JSON' }, { a: 1 })).to.deep.equal({ Value: '{"a":1}', Reason: null });
					});

				test('the generated bookstore loads as DDL + batched INSERTs + setval, and lists exactly the values PostgreSQL cannot type',
					() =>
					{
						let tmpGenerated = libBookstoreSeed.generate({ Fixture: 'Bookstore' });
						let tmpCoerced = [];
						let tmpStatements = libProviders.loadStatements(tmpGenerated.Model, tmpGenerated.Rows, tmpGenerated.Order, tmpCoerced);
						let tmpTables = Object.keys(tmpGenerated.Model.Tables);
						Expect(tmpStatements.filter((pStatement) => { return /^CREATE TABLE/.test(pStatement.text); }).length).to.equal(tmpTables.length);
						Expect(tmpStatements.filter((pStatement) => { return /^SELECT setval/.test(pStatement.text); }).length).to.equal(tmpTables.length);
						let tmpInserted = 0;
						tmpStatements.forEach(
							(pStatement) =>
							{
								if (!/^INSERT INTO/.test(pStatement.text))
								{
									return;
								}
								// One bound value per placeholder; never more than PostgreSQL's 65535.
								let tmpPlaceholders = (pStatement.text.match(/\$[0-9]+/g) || []).length;
								Expect(pStatement.values.length).to.equal(tmpPlaceholders);
								Expect(pStatement.values.length).to.be.at.most(65535);
								let tmpColumns = pStatement.text.slice(pStatement.text.indexOf('(') + 1, pStatement.text.indexOf(')')).split(',').length;
								tmpInserted += pStatement.values.length / tmpColumns;
								// Shells and loads never bind arrays.
								pStatement.values.forEach((pValue) => { Expect(Array.isArray(pValue)).to.equal(false); });
							});
						let tmpRowCount = 0;
						Object.keys(tmpGenerated.Rows).forEach((pTable) => { tmpRowCount += tmpGenerated.Rows[pTable].length; });
						Expect(tmpInserted).to.equal(tmpRowCount);
						// The bookstore's text-in-INTEGER trap and its blank end dates are the only coercions.
						let tmpByColumn = {};
						tmpCoerced.forEach((pEntry) => { let tmpKey = `${pEntry.Table}.${pEntry.Column}:${pEntry.Reason}`; tmpByColumn[tmpKey] = (tmpByColumn[tmpKey] || 0) + 1; });
						Expect(Object.keys(tmpByColumn).sort()).to.deep.equal([ 'BookPrice.EndDate:NotDate', 'BookStoreInventory.BookCount:NotInteger' ]);
						Expect(tmpCoerced.filter((pEntry) => { return pEntry.Column === 'BookCount'; }).map((pEntry) => { return pEntry.Value; }).sort()).to.deep.equal([ '', ' ' ]);
					});

				test('the PostgreSQL dialect renames binds but never a ::cast, and maximal munch keeps :p_w1 off :p_w10',
					() =>
					{
						let tmpDialects = new libDialects(new libFable({ Product: 'RFS-PG-Dialect', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] }), {});
						let tmpSQL = 'SELECT "a"::numeric FROM t WHERE "x" = :w1 AND "y" = :w10 AND "z"::text = :w1 AND "q" = :unbound';
						Expect(tmpDialects.renameParameters(tmpSQL, { w1: 1, w10: 2 }, 'h2_', ':'))
							.to.equal('SELECT "a"::numeric FROM t WHERE "x" = :h2_w1 AND "y" = :h2_w10 AND "z"::text = :h2_w1 AND "q" = :unbound');
						Expect(tmpDialects.forName('PostgreSQL')).to.include({ Sigil: ':', QuoteOpen: '"', QuoteClose: '"', GroupingSets: true });
						Expect(tmpDialects.forDAL({ providerName: 'PostgreSQL' }).Name).to.equal('PostgreSQL');
						Expect(tmpDialects.quote('PostgreSQL', 'IDBook')).to.equal('"IDBook"');
						Expect(() => { tmpDialects.quote('PostgreSQL', 'x" OR 1=1 --'); }).to.throw();
					});

				test('PostgreSQL shells bind only f* scalars, every bind typed by a CAST or a column, no literal holds a :f bind',
					() =>
					{
						let tmpNames = Object.keys(libShellTemplatesPostgreSQL.Templates);
						Expect(tmpNames.length).to.be.at.least(10);
						tmpNames.forEach(
							(pName) =>
							{
								let tmpTemplate = libShellTemplatesPostgreSQL.Templates[pName];
								// Outside single-quoted literals: every :name is an f* shell bind (relation binds arrive through SR slots).
								let tmpUnquoted = tmpTemplate.replace(/'[^']*'/g, "''");
								(tmpUnquoted.match(/(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g) || []).forEach(
									(pMatch) =>
									{
										Expect(pMatch.replace(/^[^:]*:/, ''), `${pName}: ${pMatch}`).to.match(/^f[A-Za-z0-9_]*$/);
									});
								// Inside literals (to_char formats …) nothing may look like an f* bind.
								(tmpTemplate.match(/'[^']*'/g) || []).forEach((pLiteral) => { Expect(pLiteral, `${pName}: ${pLiteral}`).to.not.match(/:f[A-Za-z0-9_]/); });
							});
						let tmpExpressions = libShellTemplatesPostgreSQL.Expressions;
						// Every numeric bind is typed numeric, so an integer column never types a fractional edge as integer.
						[ tmpExpressions.numericIndex('"p"."V"'), tmpExpressions.sumUnits('"p"."V"'), tmpExpressions.edgesIndex('"p"."V"', [ 'fE0', 'fE1' ], true), tmpExpressions.rangeIndex('"p"."V"', [ { From: 'fR0F', To: null } ]) ].forEach(
							(pSQL) =>
							{
								Expect(pSQL.replace(/CAST\(:f[A-Za-z0-9_]+ AS numeric\)/g, ''), pSQL).to.not.match(/:f/);
							});
						// numericIndex compares the RAW column against exact numeric edges ((LoUnits + i·W) / Factor).
						Expect(tmpExpressions.numericIndex('"p"."V"')).to.include('"p"."V" < ((CAST(:fLoUnits AS numeric) + (');
						Expect(tmpExpressions.dateKey('"p"."D"', 'week')).to.equal('to_char(date_trunc(\'week\', "p"."D"), \'YYYY-MM-DD HH24:MI:SS\')');
						INTERVALS.forEach((pInterval) => { Expect(tmpExpressions.dateBucket('"v"."Value"', pInterval)).to.equal(`date_trunc('${pInterval}', "v"."Value")`); });
						Expect(tmpExpressions.dateBucket('"v"."Value"', 'decade')).to.equal(null);
					});
			}
		);

		// ---------------------------------------------------------------- gated: the hook lifecycle
		gatedSuite(POSTGRES.Available)
		(
			'PostgreSQL provider hook lifecycle (a fresh C-collated database per harness, dropped on release)',
			() =>
			{
				let _Fable = null;
				let _Connection = null;
				let _Seed = null;

				suiteSetup((fDone) =>
				{
					_Fable = new libFable(Object.assign({ Product: 'RFS-PG-Hook', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] }, libProviders.fableSettings('PostgreSQL', {})));
					libProviders.connect('PostgreSQL', _Fable, {},
						(pError, pConnection) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							_Connection = pConnection;
							libProviders.seed(pConnection, libBookstoreSeed, { Fixture: 'Bookstore-Tenant' },
								(pSeedError, pSeed) =>
								{
									_Seed = pSeed;
									return fDone(pSeedError);
								});
						});
				});
				suiteTeardown((fDone) =>
				{
					if (!_Connection)
					{
						return fDone();
					}
					libProviders.release(_Connection, fDone);
				});

				test('the connection: provider names, the database fable asked for, UTF8 + C collation, PostgreSQL 16, its pool in meadow\'s provider',
					(fDone) =>
					{
						Expect(_Connection).to.include({ Provider: 'PostgreSQL', StorageProvider: 'PostgreSQL', db: null, Database: _Fable.settings.PostgreSQL.database });
						Expect(_Connection.pool).to.equal(_Fable.MeadowPostgreSQLProvider.pool);
						Expect(_Fable.MeadowPostgreSQLProvider.connected).to.equal(true);
						Expect(_Connection.ServerVersion).to.be.at.least(160000);
						Expect(libProviders.activeDatabases()).to.include(_Connection.Database);
						_Connection.pool.query('SELECT "d"."datcollate" AS "Collate", "d"."datctype" AS "CType", pg_encoding_to_char("d"."encoding") AS "Encoding" FROM pg_database "d" WHERE "d"."datname" = current_database()',
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResult.rows[0]).to.deep.equal({ Collate: 'C', CType: 'C', Encoding: 'UTF8' });
								return fDone();
							});
					});

				test('every column is nullable with no default, booleans are SMALLINT, decimals keep their scale',
					(fDone) =>
					{
						_Connection.pool.query('SELECT "table_name" AS "T", "column_name" AS "C", "is_nullable" AS "N", "column_default" AS "D", "data_type" AS "Y", "numeric_scale" AS "S" FROM information_schema.columns WHERE "table_schema" = \'public\'',
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								let tmpModel = _Seed.Model;
								let tmpExpected = 0;
								Object.keys(tmpModel.Tables).forEach((pTable) => { tmpExpected += tmpModel.Tables[pTable].Columns.length; });
								Expect(pResult.rows.length).to.equal(tmpExpected);
								pResult.rows.forEach(
									(pRow) =>
									{
										let tmpPrimary = /^ID/.test(pRow.C) && (pRow.C === `ID${pRow.T}`);
										Expect(pRow.N, `${pRow.T}.${pRow.C}`).to.equal(tmpPrimary ? 'NO' : 'YES');
										if (!tmpPrimary)
										{
											Expect(pRow.D, `${pRow.T}.${pRow.C}`).to.equal(null);
										}
									});
								let tmpByName = {};
								pResult.rows.forEach((pRow) => { tmpByName[`${pRow.T}.${pRow.C}`] = pRow; });
								Expect(tmpByName['Book.Deleted'].Y).to.equal('smallint');
								Expect(tmpByName['BookStoreEmployee.IsActive'].Y).to.equal('smallint');
								Expect(tmpByName['BookStoreSale.TotalAmount']).to.include({ Y: 'numeric', S: 2 });
								Expect(tmpByName['BookStoreSale.SaleDate'].Y).to.equal('timestamp without time zone');
								Expect(tmpByName['Book.IDTenant'].Y).to.equal('integer');
								return fDone();
							});
					});

				test('the seed result has the SQLite build() shape, counted by SQL; NULLs stay NULL; the coercions are listed on both',
					(fDone) =>
					{
						let tmpGenerated = libBookstoreSeed.generate({ Fixture: 'Bookstore-Tenant' });
						Expect(_Seed).to.include({ Fixture: 'Bookstore-Tenant', Provider: 'PostgreSQL', TenantColumn: 'IDTenant' });
						Expect(_Seed.Tenants).to.deep.equal([ 1, 2 ]);
						Object.keys(tmpGenerated.Rows).forEach(
							(pTable) =>
							{
								Expect(_Seed.Counts[pTable], pTable).to.equal(tmpGenerated.Rows[pTable].length);
								let tmpLive = tmpGenerated.Rows[pTable].filter((pRow) => { return !Object.prototype.hasOwnProperty.call(pRow, 'Deleted') || (pRow.Deleted !== 1); }).length;
								Expect(_Seed.LiveCounts[pTable], pTable).to.equal(tmpLive);
								Expect(_Seed.TenantCounts[1][pTable] + _Seed.TenantCounts[2][pTable], pTable).to.equal(_Seed.Counts[pTable]);
								Expect(_Seed.TenantLiveCounts[1][pTable] + _Seed.TenantLiveCounts[2][pTable], pTable).to.equal(_Seed.LiveCounts[pTable]);
							});
						Expect(_Seed.Traps).to.deep.equal(tmpGenerated.Traps);
						Expect(_Connection.Coerced).to.deep.equal(_Seed.Coerced);
						Expect(_Seed.Coerced.filter((pEntry) => { return pEntry.Column === 'BookCount'; }).map((pEntry) => { return pEntry.Key; }).sort()).to.deep.equal([ 5, 6 ]);
						let tmpNullLanguages = tmpGenerated.Rows.Book.filter((pRow) => { return pRow.Language === null; }).length;
						let tmpBlankLanguages = tmpGenerated.Rows.Book.filter((pRow) => { return pRow.Language === ''; }).length;
						_Connection.pool.query('SELECT count(*) FILTER (WHERE "Language" IS NULL) AS "Nulls", count(*) FILTER (WHERE "Language" = \'\') AS "Blanks", count(*) AS "Rows" FROM "Book"',
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								// bigint counts arrive as strings
								Expect(pResult.rows[0].Rows).to.be.a('string');
								Expect(Number(pResult.rows[0].Nulls)).to.equal(tmpNullLanguages);
								Expect(Number(pResult.rows[0].Blanks)).to.equal(tmpBlankLanguages);
								Expect(tmpNullLanguages).to.be.above(0);
								return fDone();
							});
					});

				test('DECIMAL(10,2) rounds the 499.996 trap to 500.00; timestamps read back as the stored wall clock under TZ=UTC; text traps are NULL',
					(fDone) =>
					{
						Expect(libProviders.timeZoneIsUTC()).to.equal(true);
						_Connection.pool.query('SELECT "TotalAmount"::text AS "Amount" FROM "BookStoreSale" WHERE "IDBookStoreSale" = 12',
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								Expect(_Seed.Traps.SubScaleAmount).to.equal(499.996);
								Expect(pResult.rows[0].Amount).to.equal('500.00');
								_Connection.pool.query('SELECT "SaleDate" AS "D", to_char("SaleDate", \'YYYY-MM-DD HH24:MI:SS\') AS "T" FROM "BookStoreSale" WHERE "SaleDate" IS NOT NULL ORDER BY "SaleDate" LIMIT 1',
									(pDateError, pDateResult) =>
									{
										Expect(pDateError).to.not.exist;
										Expect(pDateResult.rows[0].D).to.be.an.instanceof(Date);
										Expect(libFacetBuckets.canonicalDateTime(pDateResult.rows[0].D)).to.equal(pDateResult.rows[0].T);
										Expect(pDateResult.rows[0].T).to.equal(_Seed.Traps.FirstSaleDate);
										_Connection.pool.query('SELECT count(*) AS "N" FROM "BookStoreInventory" WHERE "IDBookStoreInventory" IN (5, 6) AND "BookCount" IS NULL',
											(pTrapError, pTrapResult) =>
											{
												Expect(pTrapError).to.not.exist;
												Expect(pTrapResult.rows[0].N).to.equal('2');
												return fDone();
											});
									});
							});
					});

				test('SERIAL sequences continue after the explicit IDs (a meadow Create gets the next key)',
					(fDone) =>
					{
						_Connection.pool.query('SELECT nextval(pg_get_serial_sequence(\'"Book"\', \'IDBook\')) AS "Next", (SELECT max("IDBook") FROM "Book") AS "Max"',
							(pError, pResult) =>
							{
								Expect(pError).to.not.exist;
								Expect(Number(pResult.rows[0].Next)).to.equal(Number(pResult.rows[0].Max) + 1);
								return fDone();
							});
					});

				test('the leftover sweep drops only rfs_<pid>_<n> databases of dead processes with no connections — never ours, never a live run\'s',
					(fDone) =>
					{
						let tmpInfo = libDockerPostgres.connectionInfo();
						// pid 2147480 is beyond every pid_max: a dead process.  Our parent (npm / the shell) is alive.
						// The counters carry our pid, so concurrent runs never share these names.
						let tmpDead = `rfs_2147480_${process.pid}`;
						let tmpLive = `rfs_${process.ppid}_${process.pid}`;
						libDockerPostgres.adminQuery(tmpInfo, `CREATE DATABASE "${tmpDead}" TEMPLATE template0`, [],
							(pDeadError) =>
							{
								Expect(pDeadError).to.not.exist;
								libDockerPostgres.adminQuery(tmpInfo, `CREATE DATABASE "${tmpLive}" TEMPLATE template0`, [],
									(pLiveError) =>
									{
										Expect(pLiveError).to.not.exist;
										libDockerPostgres.dropLeftoverDatabases(tmpInfo, [],
											(pSweepError, pDropped) =>
											{
												Expect(pSweepError).to.not.exist;
												// (A concurrent run's sweep may have dropped the dead one first: the name check below covers both.)
												Expect(pDropped).to.not.include(tmpLive);
												Expect(pDropped).to.not.include(_Connection.Database);
												libDockerPostgres.adminQuery(tmpInfo, 'SELECT "datname" AS "Name" FROM pg_database', [],
													(pListError, pList) =>
													{
														Expect(pListError).to.not.exist;
														let tmpNames = pList.rows.map((pRow) => { return pRow.Name; });
														Expect(tmpNames).to.not.include(tmpDead);
														Expect(tmpNames).to.include(tmpLive);
														Expect(tmpNames).to.include(_Connection.Database);
														Expect(tmpNames).to.include('postgres');
														libDockerPostgres.adminQuery(tmpInfo, `DROP DATABASE IF EXISTS "${tmpLive}"`, [], (pDropError) => { Expect(pDropError).to.not.exist; return fDone(); });
													});
											});
									});
							});
					});

				test('ensure() is idempotent: the running server is reused (the container stays running, nothing is recreated)',
					(fDone) =>
					{
						let tmpInfo = libDockerPostgres.connectionInfo();
						libDockerPostgres.ensure({ Keep: libProviders.activeDatabases() },
							(pError, pInfo) =>
							{
								Expect(pError, pError ? pError.message : '').to.not.exist;
								Expect(pInfo).to.deep.equal(tmpInfo);
								if (tmpInfo.Source !== 'Container')
								{
									return fDone();
								}
								libDockerPostgres.status(
									(pStatusError, pState) =>
									{
										Expect(pStatusError).to.not.exist;
										Expect(pState).to.equal('running');
										// The database this suite is using survived the second sweep.
										_Connection.pool.query('SELECT 1 AS "Alive"', (pAliveError, pAlive) =>
										{
											Expect(pAliveError).to.not.exist;
											Expect(pAlive.rows[0].Alive).to.equal(1);
											return fDone();
										});
									});
							});
					});

				test('release() ends the pool and drops the database, and is idempotent; a released connection cannot be seeded',
					(fDone) =>
					{
						let tmpFable = new libFable(Object.assign({ Product: 'RFS-PG-Release', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] }, libProviders.fableSettings('PostgreSQL', {})));
						libProviders.connect('PostgreSQL', tmpFable, {},
							(pError, pConnection) =>
							{
								Expect(pError).to.not.exist;
								let tmpName = pConnection.Database;
								libProviders.release(pConnection,
									(pReleaseError) =>
									{
										Expect(pReleaseError).to.not.exist;
										Expect(libProviders.activeDatabases()).to.not.include(tmpName);
										libProviders.release(pConnection,
											(pAgainError) =>
											{
												Expect(pAgainError).to.not.exist;
												libDockerPostgres.adminQuery(libDockerPostgres.connectionInfo(), 'SELECT count(*) AS "N" FROM pg_database WHERE "datname" = $1', [ tmpName ],
													(pListError, pList) =>
													{
														Expect(pListError).to.not.exist;
														Expect(pList.rows[0].N).to.equal('0');
														libProviders.seed(pConnection, libBookstoreSeed, {},
															(pSeedError) =>
															{
																Expect(pSeedError).to.be.an('error');
																return fDone();
															});
													});
											});
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- gated: the M1 conformance list on PostgreSQL
		gatedSuite(POSTGRES_READY)
		(
			'Bookstore on PostgreSQL: every request of the SQLite conformance list (O1 + O2)',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

				test('the harness runs on PostgreSQL (provider hook) and the SQLite fixture list was read',
					() =>
					{
						Expect(CONFORMANCE.Error, CONFORMANCE.Error ? CONFORMANCE.Error.message : '').to.equal(null);
						Expect(CONFORMANCE.Fixtures.length).to.be.at.least(40);
						Expect(_Harness.provider).to.equal('PostgreSQL');
						Expect(_Harness.connection.Provider).to.equal('PostgreSQL');
						Expect(_Harness.fable.MeadowEndpoints.Book.controller.DAL.providerName).to.equal('PostgreSQL');
					});

				CONFORMANCE.Fixtures.forEach(
					(pFixture) =>
					{
						test(pFixture.Name,
							(fDone) =>
							{
								runFixture(_Harness, pFixture, fDone);
							});
					});
			}
		);

		// ---------------------------------------------------------------- gated: §33.4 parity checks
		gatedSuite(POSTGRES_READY)
		(
			'PostgreSQL parity checks (internal-contracts §33.4)',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

				test('numericIndex on numeric (Nice, DECIMAL): every live row lands in the bucket the contract math gives, rows exactly on inner edges included; O2 counts each bucket through the list',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT "TotalAmount"::text AS "V" FROM "BookStoreSale" WHERE "Deleted" = 0', [],
							(pSQLError, pRows) =>
							{
								Expect(pSQLError).to.not.exist;
								let tmpValues = pRows.map((pRow) => { return pRow.V; }).filter((pValue) => { return pValue !== null; });
								let tmpLo = Math.min.apply(null, tmpValues.map(Number));
								let tmpHi = Math.max.apply(null, tmpValues.map(Number));
								let tmpMaxBuckets = _Harness.faceting.options.Limits.MaxBuckets;
								let fGeometry = (pBuckets) => { return libFacetBuckets.numericGeometry(tmpLo, tmpHi, pBuckets, 2, tmpMaxBuckets); };
								let fOnInnerEdge = (pGeometry) =>
								{
									let tmpInner = pGeometry.Edges.slice(1, -1);
									return tmpValues.filter((pValue) => { return tmpInner.indexOf(Number(pValue)) >= 0; });
								};
								// A bucket count whose Nice edges hit stored values: the edge rows decide the test.
								let tmpBuckets = null;
								for (let tmpCandidate = 5; (tmpCandidate <= 200) && (tmpBuckets === null); tmpCandidate++)
								{
									if (fOnInnerEdge(fGeometry(tmpCandidate)).length > 0)
									{
										tmpBuckets = tmpCandidate;
									}
								}
								Expect(tmpBuckets, 'a Nice geometry with stored values on its inner edges').to.not.equal(null);
								let tmpCases = [ [ 'OnEdges', tmpBuckets ], [ 'Coarse', 7 ], [ 'Fine', 40 ] ];
								let tmpBody = { Facets: tmpCases.map((pCase) => { return { Key: pCase[0], Facet: 'BookStoreSale.TotalAmount', Buckets: pCase[1] }; }) };
								// Every bucket's Clause is counted through the list (no MaxBuckets cap here).
								runFixture(_Harness, { Entity: 'BookStoreSale', Body: tmpBody },
									() =>
									{
										_Harness.facetQuery('BookStoreSale', tmpBody, {},
											(pError, pResponse) =>
											{
												Expect(pError).to.not.exist;
												tmpCases.forEach(
													(pCase) =>
													{
														let tmpFacet = pResponse.Body.Facets[pCase[0]];
														let tmpGeometry = fGeometry(pCase[1]);
														Expect(tmpFacet.Geometry.Edges, pCase[0]).to.deep.equal(tmpGeometry.Edges);
														let tmpExpected = {};
														tmpValues.forEach(
															(pValue) =>
															{
																let tmpStart = tmpGeometry.Edges[libFacetBuckets.numericIndex(pValue, tmpGeometry)];
																tmpExpected[String(tmpStart)] = (tmpExpected[String(tmpStart)] || 0) + 1;
															});
														// A value exactly on an inner edge opens the upper bucket.
														fOnInnerEdge(tmpGeometry).forEach(
															(pValue) =>
															{
																Expect(tmpGeometry.Edges[libFacetBuckets.numericIndex(pValue, tmpGeometry)], `${pValue} on an edge`).to.equal(Number(pValue));
															});
														let tmpActual = {};
														tmpFacet.Buckets.forEach((pBucket) => { if (pBucket.Count > 0) { tmpActual[String(pBucket.Start)] = pBucket.Count; } });
														Expect(tmpActual, pCase[0]).to.deep.equal(tmpExpected);
														Expect(tmpFacet.MissingCount, pCase[0]).to.equal(pRows.length - tmpValues.length);
													});
												return fDone();
											});
									});
							});
					});

				test('numericIndex on numeric (Edges): decimal edges 0.2 / 8.4 / 12.6, edges equal to stored values, an integer column against decimal edges (O1 + O2 + the contract math)',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT DISTINCT "UnitPrice" AS "N", "UnitPrice"::text AS "V" FROM "BookStoreSaleItem" WHERE "Deleted" = 0 AND "UnitPrice" > 12.6 ORDER BY "UnitPrice" LIMIT 3', [],
							(pError, pPrices) =>
							{
								Expect(pError).to.not.exist;
								let tmpStored = pPrices.map((pRow) => { return Number(pRow.V); });
								Expect(tmpStored.length).to.equal(3);
								let tmpEdges = [ 0.2, 8.4, 12.6 ].concat(tmpStored, [ Number((tmpStored[2] + 30.01).toFixed(2)) ]);
								let tmpBody =
									{
										Facets:
											[
												{ Key: 'Price', Facet: 'BookStoreSaleItem.UnitPrice', Edges: tmpEdges, OpenEnded: true },
												{ Key: 'Closed', Facet: 'BookStoreSaleItem.UnitPrice', Edges: [ 0.2, 8.4, 12.6, 20.2 ] }
											]
									};
								runFixture(_Harness, { Entity: 'BookStoreSaleItem', Body: tmpBody },
									() =>
									{
										_Harness.facetQuery('BookStoreSaleItem', tmpBody, {},
											(pQueryError, pResponse) =>
											{
												Expect(pQueryError).to.not.exist;
												sqlRows(_Harness, 'SELECT "UnitPrice"::text AS "V" FROM "BookStoreSaleItem" WHERE "Deleted" = 0 AND "UnitPrice" IS NOT NULL', [],
													(pSQLError, pRows) =>
													{
														Expect(pSQLError).to.not.exist;
														[ [ 'Price', tmpEdges, true ], [ 'Closed', [ 0.2, 8.4, 12.6, 20.2 ], false ] ].forEach(
															(pCase) =>
															{
																let tmpGeometry = libFacetBuckets.edgesGeometry(pCase[1], pCase[2], 2);
																let tmpExpected = {};
																let tmpOnEdge = 0;
																pRows.forEach(
																	(pRow) =>
																	{
																		let tmpIndex = libFacetBuckets.numericIndex(pRow.V, tmpGeometry);
																		if (pCase[1].indexOf(Number(pRow.V)) >= 0)
																		{
																			tmpOnEdge++;
																		}
																		if (tmpIndex !== null)
																		{
																			tmpExpected[String(pCase[1][tmpIndex])] = (tmpExpected[String(pCase[1][tmpIndex])] || 0) + 1;
																		}
																	});
																let tmpActual = {};
																pResponse.Body.Facets[pCase[0]].Buckets.forEach((pBucket) => { if (pBucket.Count > 0) { tmpActual[String(pBucket.Start)] = pBucket.Count; } });
																Expect(tmpActual, pCase[0]).to.deep.equal(tmpExpected);
																if (pCase[0] === 'Price')
																{
																	Expect(tmpOnEdge, 'rows exactly on a stored-value edge').to.be.above(0);
																}
															});
														// An INTEGER column against decimal edges: the shells CAST every edge to numeric (O1).  Its
														// bucket Clauses carry the fractional bounds, which PostgreSQL cannot bind to an integer
														// column on the list (22P02), so O2 is the pending test below.
														runFixture(_Harness, { Entity: 'Review', Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Edges: [ 0.5, 2.5, 3, 4.2, 5 ], OpenEnded: true } ] }, O2: false }, fDone);
													});
											});
									});
							});
					});

				// A fractional NumericRange bound on an INTEGER column ('Rating >= 0.5') would bind text '0.5' to
				// an integer parameter, which PostgreSQL rejects (22P02).  The clause compiler binds the integer
				// equivalent (GE / LT → ceil, GT / LE → floor; ClauseCompiler._rangeBound), so every bucket Clause
				// compiles to a filter the list, the Reference and Live all accept and count the same.
				test('O2 of Edges buckets with fractional bounds on an INTEGER column (integer-equivalent bounds)',
					(fDone) =>
					{
						runFixture(_Harness, { Entity: 'Review', Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Edges: [ 0.5, 2.5, 3, 4.2, 5 ], OpenEnded: true } ] } }, fDone);
					});

				test('DateHistogram on every interval equals FacetBuckets.dateKey over the stored timestamps (ISO weeks across year ends, the boundary traps)',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT to_char("SaleDate", \'YYYY-MM-DD HH24:MI:SS\') AS "V" FROM "BookStoreSale" WHERE "Deleted" = 0', [],
							(pError, pRows) =>
							{
								Expect(pError).to.not.exist;
								let tmpValues = pRows.map((pRow) => { return pRow.V; });
								let tmpDates = tmpValues.filter((pValue) => { return pValue !== null; });
								// The data crosses year ends inside an ISO week (2020-12-31 is in the week of 2020-12-28).
								Expect(tmpDates.some((pValue) => { return libFacetBuckets.dateKey(pValue, 'week').slice(0, 4) !== pValue.slice(0, 4); })).to.equal(true);
								Expect(libFacetBuckets.dateKey(_Harness.seed.Traps.FirstSaleDate, 'week')).to.equal('2020-12-28 00:00:00');
								let tmpTraps = _Harness.seed.Traps.BoundarySaleDates.map((pValue) => { return libFacetBuckets.canonicalDateTime(pValue); });
								let fInterval = (pIndex) =>
								{
									if (pIndex >= INTERVALS.length)
									{
										return fDone();
									}
									let tmpInterval = INTERVALS[pIndex];
									// 'day' over four years is TOO_FINE: bound it to the trap months.
									let tmpBody = (tmpInterval === 'day')
										? { FilterString: 'FBV~SaleDate~GE~2023-03-15~FBV~SaleDate~LT~2023-07-15', Facets: [ { Key: 'D', Facet: 'BookStoreSale.SaleDate', Interval: 'day', Exclude: 'None' } ] }
										: { Facets: [ { Key: 'D', Facet: 'BookStoreSale.SaleDate', Interval: tmpInterval } ] };
									let tmpInScope = (tmpInterval === 'day')
										? tmpDates.filter((pValue) => { return (pValue >= '2023-03-15 00:00:00') && (pValue < '2023-07-15 00:00:00'); })
										: tmpDates;
									_Harness.facetQuery('BookStoreSale', tmpBody, {},
										(pQueryError, pResponse) =>
										{
											Expect(pQueryError).to.not.exist;
											Expect(pResponse.Status, JSON.stringify(pResponse.Body).slice(0, 400)).to.equal(200);
											let tmpFacet = pResponse.Body.Facets.D;
											let tmpExpected = {};
											tmpInScope.forEach((pValue) => { let tmpKey = libFacetBuckets.dateKey(pValue, tmpInterval); tmpExpected[tmpKey] = (tmpExpected[tmpKey] || 0) + 1; });
											Expect(nonEmptyCountsOf(tmpFacet), tmpInterval).to.deep.equal(tmpExpected);
											if (tmpInterval !== 'day')
											{
												Expect(tmpFacet.MissingCount, tmpInterval).to.equal(tmpValues.length - tmpDates.length);
												Expect(tmpFacet.Bounds).to.deep.equal({ Lo: tmpDates.slice().sort()[0], Hi: tmpDates.slice().sort()[tmpDates.length - 1] });
											}
											// The boundary traps sit exactly on their bucket starts.
											tmpTraps.forEach(
												(pTrap) =>
												{
													if ((tmpInterval === 'day') && ((pTrap < '2023-03-15 00:00:00') || (pTrap >= '2023-07-15 00:00:00')))
													{
														return;
													}
													let tmpKey = libFacetBuckets.dateKey(pTrap, tmpInterval);
													Expect(tmpFacet.Buckets.some((pBucket) => { return (pBucket.Key === tmpKey) && (pBucket.Count > 0); }), `${pTrap} ${tmpInterval}`).to.equal(true);
												});
											return fInterval(pIndex + 1);
										});
								};
								return fInterval(0);
							});
					});

				test('DateHistogram × every interval also round-trips (O1 + O2) on a date column with NULLs that PostgreSQL coerced from blank text (BookPrice.EndDate)',
					(fDone) =>
					{
						let tmpBody = { Facets: INTERVALS.filter((pInterval) => { return pInterval !== 'day'; }).map((pInterval) => { return { Key: pInterval, Facet: 'BookPrice.EndDate', Interval: pInterval }; }).concat([ { Key: 'Missing', Facet: 'BookPrice.EndDate', Fold: 'Missing' } ]) };
						runFixture(_Harness, { Entity: 'BookPrice', Body: tmpBody, O2Options: { MaxBuckets: 8 } },
							() =>
							{
								let tmpBlank = _Harness.seed.Coerced.filter((pEntry) => { return (pEntry.Table === 'BookPrice') && (pEntry.Column === 'EndDate'); }).length;
								Expect(tmpBlank).to.be.above(0);
								_Harness.facetQuery('BookPrice', tmpBody, {},
									(pError, pResponse) =>
									{
										Expect(pError).to.not.exist;
										sqlRows(_Harness, 'SELECT count(*) AS "N" FROM "BookPrice" WHERE "Deleted" = 0 AND "EndDate" IS NULL', [],
											(pSQLError, pRows) =>
											{
												Expect(pSQLError).to.not.exist;
												Expect(pResponse.Body.Facets.Missing.MissingCount).to.equal(Number(pRows[0].N));
												Expect(pResponse.Body.Facets.year.MissingCount).to.equal(Number(pRows[0].N));
												return fDone();
											});
									});
							});
					});

				test('Stats on DECIMAL are exact: Sum equals PostgreSQL\'s numeric sum to the cent, Min / Max equal the stored values',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Amount', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' }, { Key: 'Line', Facet: 'BookStoreSaleItem.LineTotal', Fold: 'Stats' } ] };
						let tmpCases = [ [ 'BookStoreSale', 'TotalAmount' ], [ 'BookStoreSaleItem', 'LineTotal' ] ];
						let fCase = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpEntity = tmpCases[pIndex][0];
							let tmpColumn = tmpCases[pIndex][1];
							let tmpFacetBody = { Facets: [ tmpBody.Facets[pIndex] ] };
							runFixture(_Harness, { Entity: tmpEntity, Body: tmpFacetBody, O2: false },
								() =>
								{
									_Harness.facetQuery(tmpEntity, tmpFacetBody, {},
										(pError, pResponse) =>
										{
											Expect(pError).to.not.exist;
											sqlRows(_Harness, `SELECT sum("${tmpColumn}")::text AS "Sum", min("${tmpColumn}")::text AS "Min", max("${tmpColumn}")::text AS "Max", count("${tmpColumn}") AS "NonNull", count(*) AS "Rows" FROM "${tmpEntity}" WHERE "Deleted" = 0`, [],
												(pSQLError, pRows) =>
												{
													Expect(pSQLError).to.not.exist;
													let tmpStats = pResponse.Body.Facets[tmpBody.Facets[pIndex].Key].Stats;
													Expect(tmpStats.Sum, tmpColumn).to.equal(pRows[0].Sum);
													// Decimal Min / Max / Sum are strings with exactly Scale decimals (internal-contracts §10.2), as PostgreSQL prints numeric(10,2).
													Expect(tmpStats.Min).to.equal(pRows[0].Min);
													Expect(tmpStats.Max).to.equal(pRows[0].Max);
													Expect(tmpStats.NonNull).to.equal(Number(pRows[0].NonNull));
													Expect(tmpStats.Rows).to.equal(Number(pRows[0].Rows));
													return fCase(pIndex + 1);
												});
										});
								});
						};
						return fCase(0);
					});

				test('Terms over SMALLINT booleans: numeric 0 / 1 keys with the counts of a GROUP BY, as a Terms and as a Pivot axis',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Active', Facet: 'BookStoreEmployee.IsActive' }, { Key: 'Cross', Facet: [ 'BookStoreEmployee.IsActive', 'BookStoreEmployee.Title' ], Fold: 'Pivot' } ] };
						runFixture(_Harness, { Entity: 'BookStoreEmployee', Body: tmpBody },
							() =>
							{
								_Harness.facetQuery('BookStoreEmployee', tmpBody, {},
									(pError, pResponse) =>
									{
										Expect(pError).to.not.exist;
										sqlRows(_Harness, 'SELECT "IsActive" AS "K", count(*) AS "N" FROM "BookStoreEmployee" WHERE "Deleted" = 0 GROUP BY "IsActive"', [],
											(pSQLError, pRows) =>
											{
												Expect(pSQLError).to.not.exist;
												let tmpExpected = {};
												let tmpMissing = 0;
												pRows.forEach((pRow) => { if (pRow.K === null) { tmpMissing += Number(pRow.N); } else { tmpExpected[String(pRow.K)] = Number(pRow.N); } });
												let tmpFacet = pResponse.Body.Facets.Active;
												tmpFacet.Buckets.forEach((pBucket) => { Expect(pBucket.Key).to.be.oneOf([ 0, 1 ]); });
												Expect(countsOf(tmpFacet)).to.deep.equal(tmpExpected);
												Expect(tmpFacet.MissingCount).to.equal(tmpMissing);
												pResponse.Body.Facets.Cross.RowKeys.forEach((pKey) => { Expect(pKey).to.be.oneOf([ 0, 1 ]); });
												return fDone();
											});
									});
							});
					});

				test('bigint counts arrive from pg as strings and leave the service as integers (every Total, Count, Sum, Missing, Distinct)',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT count(*) AS "N", sum("Rating") AS "S" FROM "Review"', [],
							(pError, pRows) =>
							{
								Expect(pError).to.not.exist;
								Expect(pRows[0].N).to.be.a('string');
								Expect(pRows[0].S).to.be.a('string');
								let tmpBody =
									{
										Facets:
											[
												{ Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' }, { Key: 'Book', Facet: 'Review.IDBook', Top: 5 },
												{ Key: 'Distinct', Facet: 'Review.IDBook', Fold: 'DistinctCount' }, { Key: 'Missing', Facet: 'Review.Rating', Fold: 'Missing' },
												{ Key: 'Hist', Facet: 'Review.Rating', Buckets: 4 }, { Key: 'Stats', Facet: 'Review.Rating', Fold: 'Stats' }
											],
										Total: true
									};
								_Harness.facetQuery('Review', tmpBody, {},
									(pQueryError, pResponse) =>
									{
										Expect(pQueryError).to.not.exist;
										Expect(pResponse.Status).to.equal(200);
										assertNumericCounts(pResponse.Body);
										Expect(pResponse.Body.Total).to.equal(_Harness.seed.LiveCounts.Review);
										Expect(Number.isInteger(pResponse.Body.Facets.Stats.Stats.Sum)).to.equal(true);
										return fDone();
									});
							});
					});

				test('IS NULL predicates: FBV~SaleDate~IN~0 counts exactly the NULL dates, and the PostgreSQL list agrees (O2)',
					(fDone) =>
					{
						let tmpBody = { FilterString: 'FBV~SaleDate~IN~0', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' }, { Key: 'DateMissing', Facet: 'BookStoreSale.SaleDate', Fold: 'Missing' } ], Total: true };
						runFixture(_Harness, { Entity: 'BookStoreSale', Body: tmpBody },
							() =>
							{
								_Harness.facetQuery('BookStoreSale', tmpBody, {},
									(pError, pResponse) =>
									{
										Expect(pError).to.not.exist;
										sqlRows(_Harness, 'SELECT count(*) AS "N" FROM "BookStoreSale" WHERE "Deleted" = 0 AND "SaleDate" IS NULL', [],
											(pSQLError, pRows) =>
											{
												Expect(pSQLError).to.not.exist;
												Expect(Number(pRows[0].N)).to.be.above(0);
												Expect(pResponse.Body.Total).to.equal(Number(pRows[0].N));
												Expect(pResponse.Body.Facets.DateMissing.MissingCount).to.equal(Number(pRows[0].N));
												_Harness.listCount('BookStoreSale', 'FBV~SaleDate~IN~0', {},
													(pCountError, pCount) =>
													{
														Expect(pCountError).to.not.exist;
														Expect(pCount).to.equal(Number(pRows[0].N));
														return fDone();
													});
											});
									});
							});
					});

				test('the C collation orders keys exactly as compareKeys: ORDER BY of mixed-case and blank keys, KeyAsc Terms display',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT "Language" AS "K" FROM "Book" WHERE "Language" IS NOT NULL GROUP BY "Language" ORDER BY "Language"', [],
							(pError, pRows) =>
							{
								Expect(pError).to.not.exist;
								let tmpKeys = pRows.map((pRow) => { return pRow.K; });
								Expect(tmpKeys).to.include('en-US');
								Expect(tmpKeys).to.include('eng');
								Expect(tmpKeys).to.include('');
								Expect(tmpKeys).to.deep.equal(tmpKeys.slice().sort(libFacetBuckets.compareKeys));
								// Uppercase sorts before lowercase under C (a linguistic collation would interleave them).
								Expect(tmpKeys.indexOf('en-US')).to.be.below(tmpKeys.indexOf('eng'));
								let tmpBody = { Facets: [ { Key: 'Lang', Facet: 'Book.Language', Top: 50, Order: 'KeyAsc' } ] };
								runFixture(_Harness, { Entity: 'Book', Body: tmpBody },
									() =>
									{
										_Harness.facetQuery('Book', tmpBody, {},
											(pQueryError, pResponse) =>
											{
												Expect(pQueryError).to.not.exist;
												Expect(pResponse.Body.Facets.Lang.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal(tmpKeys);
												return fDone();
											});
									});
							});
					});

				test('Terms tie-break under the C collation: with MaxTermsGroups 7 the SQL cap (key order) still gives the canonical answer (O1)',
					(fDone) =>
					{
						let tmpLimits = _Harness.faceting.options.Limits;
						let tmpSavedMax = tmpLimits.MaxTermsGroups;
						tmpLimits.MaxTermsGroups = 7;
						// ISBN is unique per book: every key ties at count 1.
						let tmpBody = { Facets: [ { Key: 'ISBN', Facet: 'Book.ISBN', Fold: 'Terms', Order: 'KeyAsc', Top: 5 }, { Key: 'ISBNByCount', Facet: 'Book.ISBN', Fold: 'Terms', Top: 3 }, { Key: 'Title', Facet: 'Book.Title', Fold: 'Terms', Top: 4 } ] };
						_Harness.compare('Book', tmpBody, {},
							(pError, pResult) =>
							{
								tmpLimits.MaxTermsGroups = tmpSavedMax;
								Expect(pError).to.not.exist;
								Expect(pResult.Live.Status, JSON.stringify(pResult.Live.Body).slice(0, 400)).to.equal(200);
								if (JSON.stringify(pResult.LiveNormalized) !== JSON.stringify(pResult.ReferenceNormalized))
								{
									Expect(pResult.LiveNormalized, firstDifference(pResult.LiveNormalized, pResult.ReferenceNormalized)).to.deep.equal(pResult.ReferenceNormalized);
								}
								Expect(pResult.Live.Body.Facets.ISBN.Truncated).to.equal(true);
								Expect(pResult.Live.Body.Facets.ISBN.Buckets.length).to.equal(5);
								return fDone();
							});
					});

				test('values PostgreSQL could not type are Missing on every fold and on the list (BookStoreInventory.BookCount); open-ended ranges round-trip (no G1 on typed columns)',
					(fDone) =>
					{
						let tmpBody =
							{
								Facets:
									[
										{ Key: 'Count', Facet: 'BookStoreInventory.BookCount', Buckets: 6 },
										{ Key: 'Missing', Facet: 'BookStoreInventory.BookCount', Fold: 'Missing' },
										{ Key: 'Terms', Facet: 'BookStoreInventory.BookCount', Fold: 'Terms', Top: 5 },
										// SQLite's G1: an open-ended range also selects text in a numeric column; PostgreSQL holds no text there.
										{ Key: 'Open', Facet: 'BookStoreInventory.BookCount', Edges: [ 0, 10, 20 ], OpenEnded: true },
										{ Key: 'Band', Facet: 'BookStoreInventory.BookCount', Fold: 'Ranges', Ranges: [ { Key: 'few', To: 10 }, { Key: 'many', From: 10 } ] }
									]
							};
						runFixture(_Harness, { Entity: 'BookStoreInventory', Body: tmpBody },
							() =>
							{
								_Harness.facetQuery('BookStoreInventory', tmpBody, {},
									(pError, pResponse) =>
									{
										Expect(pError).to.not.exist;
										sqlRows(_Harness, 'SELECT count(*) AS "N" FROM "BookStoreInventory" WHERE "Deleted" = 0 AND "BookCount" IS NULL', [],
											(pSQLError, pRows) =>
											{
												Expect(pSQLError).to.not.exist;
												Expect(pResponse.Body.Facets.Missing.MissingCount).to.equal(Number(pRows[0].N));
												Expect(pResponse.Body.Facets.Terms.MissingCount).to.equal(Number(pRows[0].N));
												Expect(pResponse.Body.Facets.Count.MissingCount).to.equal(Number(pRows[0].N));
												return fDone();
											});
									});
							});
					});
			}
		);

		// ---------------------------------------------------------------- gated: staged key sets on PostgreSQL
		gatedSuite(POSTGRES_READY)
		(
			'Staged key sets on PostgreSQL: = ANY(CAST(:k AS bigint[])) and unnest through the meadow provider (internal-contracts §26.3)',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

				/**
				 * A StagedRelation (internal-contracts §26.3) over integer key tuples.
				 *
				 * @param {string} pAlias
				 * @param {string} pEntity
				 * @param {Array<string>} pColumns
				 * @param {Array<Array<number>>} pKeys
				 * @return {Record<string, any>}
				 */
				const fStaged = (pAlias, pEntity, pColumns, pKeys) =>
				{
					return { Alias: pAlias, Entity: pEntity, Staged: true, Dialect: 'PostgreSQL', Columns: pColumns, Keys: pKeys, Count: pKeys.length };
				};

				/**
				 * Count the rows of a table that pass (or, negated, fail) a staged membership, through the provider.
				 */
				const fCountMembers = (pEntity, pStaged, pOuterColumns, pNegated, fCallback) =>
				{
					let tmpMembership = _Harness.fable.RetoldFacetingStagedKeys.membership('PostgreSQL', pStaged, pOuterColumns.map((pColumn) => { return `"p"."${pColumn}"`; }), pNegated);
					Object.keys(tmpMembership.Params).forEach((pName) => { Expect(Array.isArray(tmpMembership.Params[pName]), `${pName} is one scalar`).to.equal(false); });
					providerRows(_Harness, pEntity, `SELECT count(*) AS "N" FROM "${pEntity}" "p" WHERE "p"."Deleted" = 0 AND ${tmpMembership.SQL}`, tmpMembership.Params,
						(pError, pRows) =>
						{
							return pError ? fCallback(pError) : fCallback(null, Number(pRows[0].N), tmpMembership.SQL);
						});
				};

				test('the array-bind guard sees a statement that references one array bind twice (the meadow PostgreSQL provider binds only its first element there)',
					(fDone) =>
					{
						providerRows(_Harness, 'Review', 'SELECT count(*) FILTER (WHERE "Rating" IN (:rfsGuardProbe)) AS "First", count(*) FILTER (WHERE "Rating" IN (:rfsGuardProbe)) AS "Second" FROM "Review"', { rfsGuardProbe: [ 4, 5 ] },
							(pError, pRows) =>
							{
								Expect(pError, pError ? pError.message : '').to.not.exist;
								// Upstream: the second reference gets "$1" alone (Rating IN (4)), so it never counts more.
								Expect(Number(pRows[0].First)).to.be.at.least(Number(pRows[0].Second));
								Expect(_Violations.length).to.equal(1);
								Expect(_Violations[0]).to.include({ Entity: 'Review', Param: 'rfsGuardProbe', References: 2, Length: 2 });
								// The probe is this test's own; the teardown check covers every other statement.
								_Violations.length = 0;
								return fDone();
							});
					});

				test('single-column membership (and NOT) equals IN / NOT EXISTS over the same keys; a NULL outer key never matches',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT "IDBook" AS "K" FROM "Book" WHERE "Deleted" = 0 AND "Genre" = \'Fiction\' ORDER BY "IDBook"', [],
							(pError, pBooks) =>
							{
								Expect(pError).to.not.exist;
								let tmpKeys = pBooks.map((pRow) => { return [ pRow.K ]; });
								Expect(tmpKeys.length).to.be.above(10);
								let tmpStaged = fStaged('h2', 'Book', [ 'IDBook' ], tmpKeys);
								fCountMembers('Review', tmpStaged, [ 'IDBook' ], false,
									(pMemberError, pMembers, pSQL) =>
									{
										Expect(pMemberError, pMemberError ? pMemberError.message : '').to.not.exist;
										Expect(pSQL).to.match(/= ANY\(CAST\(:h2_K0 AS bigint\[\]\)\)/);
										fCountMembers('Review', tmpStaged, [ 'IDBook' ], true,
											(pNotError, pNonMembers) =>
											{
												Expect(pNotError, pNotError ? pNotError.message : '').to.not.exist;
												sqlRows(_Harness, 'SELECT count(*) FILTER (WHERE "IDBook" = ANY($1::int[])) AS "In", count(*) FILTER (WHERE "IDBook" IS NULL OR NOT ("IDBook" = ANY($1::int[]))) AS "NotIn", count(*) AS "All" FROM "Review" WHERE "Deleted" = 0', [ tmpKeys.map((pKey) => { return pKey[0]; }) ],
													(pSQLError, pExpected) =>
													{
														Expect(pSQLError).to.not.exist;
														Expect(pMembers).to.equal(Number(pExpected[0].In));
														Expect(pNonMembers).to.equal(Number(pExpected[0].NotIn));
														Expect(pMembers + pNonMembers).to.equal(Number(pExpected[0].All));
														return fDone();
													});
											});
									});
							});
					});

				test('a staged set over 1 000 keys binds as one scalar and matches every key',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT "IDBookStoreSaleItem" AS "K" FROM "BookStoreSaleItem" WHERE "Deleted" = 0 ORDER BY 1', [],
							(pError, pItems) =>
							{
								Expect(pError).to.not.exist;
								Expect(pItems.length).to.be.above(1000);
								let tmpStaged = fStaged('h7', 'BookStoreSaleItem', [ 'IDBookStoreSaleItem' ], pItems.map((pRow) => { return [ pRow.K ]; }));
								fCountMembers('BookStoreSaleItem', tmpStaged, [ 'IDBookStoreSaleItem' ], false,
									(pMemberError, pMembers) =>
									{
										Expect(pMemberError, pMemberError ? pMemberError.message : '').to.not.exist;
										Expect(pMembers).to.equal(pItems.length);
										return fDone();
									});
							});
					});

				test('composite membership through unnest (and NOT EXISTS) equals the tuple semi-join; an empty set matches nothing / everything',
					(fDone) =>
					{
						sqlRows(_Harness, 'SELECT "IDBook" AS "B", "IDAuthor" AS "A" FROM "BookAuthorJoin" WHERE "IDBook" % 3 = 0 AND "IDBook" IS NOT NULL AND "IDAuthor" IS NOT NULL ORDER BY 1, 2', [],
							(pError, pPairs) =>
							{
								Expect(pError).to.not.exist;
								Expect(pPairs.length).to.be.above(10);
								let tmpStaged = fStaged('h3', 'BookAuthorJoin', [ 'IDBook', 'IDAuthor' ], pPairs.map((pRow) => { return [ pRow.B, pRow.A ]; }));
								let tmpEmpty = fStaged('h4', 'BookAuthorJoin', [ 'IDBook', 'IDAuthor' ], []);
								let tmpEmptySingle = fStaged('h5', 'Book', [ 'IDBook' ], []);
								// BookAuthorJoin has no Deleted column: count through Book's DAL over the join table.
								let fCount = (pStagedSet, pNegated, fNext) =>
								{
									let tmpMembership = _Harness.fable.RetoldFacetingStagedKeys.membership('PostgreSQL', pStagedSet, [ '"p"."IDBook"', '"p"."IDAuthor"' ], pNegated);
									providerRows(_Harness, 'BookAuthorJoin', `SELECT count(*) AS "N" FROM "BookAuthorJoin" "p" WHERE ${tmpMembership.SQL}`, tmpMembership.Params,
										(pCountError, pRows) =>
										{
											Expect(pCountError, pCountError ? pCountError.message : '').to.not.exist;
											return fNext(Number(pRows[0].N), tmpMembership.SQL);
										});
								};
								fCount(tmpStaged, false, (pMembers, pSQL) =>
								{
									Expect(pSQL).to.match(/unnest\(CAST\(:h3_K0 AS bigint\[\]\), CAST\(:h3_K1 AS bigint\[\]\)\)/);
									Expect(pMembers).to.equal(pPairs.length);
									fCount(tmpStaged, true, (pNonMembers) =>
									{
										sqlRows(_Harness, 'SELECT count(*) AS "N" FROM "BookAuthorJoin"', [],
											(pAllError, pAll) =>
											{
												Expect(pAllError).to.not.exist;
												Expect(pMembers + pNonMembers).to.equal(Number(pAll[0].N));
												fCount(tmpEmpty, false, (pEmptyMembers) =>
												{
													Expect(pEmptyMembers).to.equal(0);
													fCount(tmpEmpty, true, (pEmptyNonMembers) =>
													{
														Expect(pEmptyNonMembers).to.equal(Number(pAll[0].N));
														fCountMembers('Book', tmpEmptySingle, [ 'IDBook' ], false,
															(pSingleError, pSingleMembers) =>
															{
																Expect(pSingleError, pSingleError ? pSingleError.message : '').to.not.exist;
																Expect(pSingleMembers).to.equal(0);
																return fDone();
															});
													});
												});
											});
									});
								});
							});
					});
			}
		);

		// ---------------------------------------------------------------- gated: isolation and the guard on PostgreSQL
		gatedSuite(POSTGRES_READY)
		(
			'Bookstore-Tenant on PostgreSQL: two-tenant isolation',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

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
						[ 'Review', { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' }, { Key: 'Book', Facet: 'Review.IDBook', Top: 10 }, { Key: 'Band', Facet: 'Review.Rating', Fold: 'Ranges', Ranges: CONFORMANCE.RatingRanges } ] } ],
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

				test('each tenant counts exactly its own live rows (SQL per tenant on PostgreSQL), and the tenants sum to the whole table',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod', Missing: true } ] };
						let tmpTotals = {};
						let fTenant = (pTenant, fNext) =>
						{
							_Harness.facetQuery('BookStoreSale', tmpBody, { Tenant: pTenant },
								(pError, pResponse) =>
								{
									Expect(pError).to.not.exist;
									Expect(pResponse.Status).to.equal(200);
									sqlRows(_Harness, 'SELECT "PaymentMethod" AS "K", count(*) AS "C" FROM "BookStoreSale" WHERE "Deleted" = 0 AND "IDTenant" = $1 GROUP BY "PaymentMethod"', [ pTenant ],
										(pSQLError, pRows) =>
										{
											Expect(pSQLError).to.not.exist;
											let tmpCounts = {};
											let tmpMissing = 0;
											pRows.forEach((pRow) => { if (pRow.K === null) { tmpMissing += Number(pRow.C); } else { tmpCounts[pRow.K] = Number(pRow.C); } });
											Expect(countsOf(pResponse.Body.Facets.Pay)).to.deep.equal(tmpCounts);
											Expect(pResponse.Body.Facets.Pay.MissingCount).to.equal(tmpMissing);
											Expect(pResponse.Body.Total).to.equal(_Harness.seed.TenantLiveCounts[pTenant].BookStoreSale);
											tmpTotals[pTenant] = pResponse.Body.Total;
											return fNext();
										});
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

				test('tenant 2 never sees tenant 1 rows; cross-tenant parents stay unlabelled',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Store', Facet: 'BookStoreSale.IDBookStore', Top: 500 } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(200);
								sqlRows(_Harness, 'SELECT "IDBookStore" AS "K", count(*) AS "C" FROM "BookStoreSale" WHERE "Deleted" = 0 AND "IDTenant" = 2 AND "IDBookStore" IS NOT NULL GROUP BY "IDBookStore"', [],
									(pSQLError, pRows) =>
									{
										Expect(pSQLError).to.not.exist;
										let tmpOwn = {};
										pRows.forEach((pRow) => { tmpOwn[String(pRow.K)] = Number(pRow.C); });
										Expect(countsOf(pResponse.Body.Facets.Store)).to.deep.equal(tmpOwn);
										sqlRows(_Harness, 'SELECT "IDBookStore" AS "K", "Name" AS "N" FROM "BookStore" WHERE "Deleted" = 0 AND "IDTenant" = 2', [],
											(pStoreError, pStores) =>
											{
												Expect(pStoreError).to.not.exist;
												let tmpTenantStores = {};
												pStores.forEach((pRow) => { tmpTenantStores[String(pRow.K)] = pRow.N; });
												let tmpCrossTenant = 0;
												pResponse.Body.Facets.Store.Buckets.forEach(
													(pBucket) =>
													{
														if (Object.prototype.hasOwnProperty.call(tmpTenantStores, String(pBucket.Key)))
														{
															Expect(pBucket.LabelResolved).to.equal(true);
															Expect(pBucket.Label).to.equal(tmpTenantStores[String(pBucket.Key)]);
														}
														else
														{
															tmpCrossTenant++;
															Expect(pBucket.LabelResolved).to.equal(false);
														}
													});
												Expect(tmpCrossTenant).to.be.above(0);
												return fDone();
											});
									});
							});
					});

				test('a client filter naming the tenant column cannot reach another tenant',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { FilterString: 'FBV~IDTenant~EQ~1', Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] }, { Tenant: 2 },
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

		gatedSuite(POSTGRES_READY)
		(
			'ScopeGuard Strict on PostgreSQL: a behavior that drops the policy predicate is refused',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Harness.installBehavior('BookStoreSale', 'Reads-QueryConfiguration',
									function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.parameters.filter = pRequestState.Query.parameters.filter.filter((pEntry) => { return pEntry.Parameter !== 'TestTenancy'; });
										return fCallback();
									});
							}
							return fDone(pError);
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('Live refuses with 500 FACET_SCOPE_POLICY_VIOLATION (no Detail, no column name); other entities still answer',
					(fDone) =>
					{
						_Harness.facetQuery('BookStoreSale', { Facets: [ { Key: 'Pay', Facet: 'BookStoreSale.PaymentMethod' } ] }, { Tenant: 2 },
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(500);
								Expect(pResponse.Body.Error.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
								Expect(pResponse.Body.Error).to.not.have.property('Detail');
								Expect(JSON.stringify(pResponse.Body)).to.not.include('IDTenant');
								runFixture(_Harness, { Entity: 'Review', Body: { Facets: [ { Key: 'Rating', Facet: 'Review.Rating', Fold: 'Terms' } ] }, Session: { Tenant: 2 } }, fDone);
							});
					});
			}
		);

		// ---------------------------------------------------------------- gated: the M2 domains on PostgreSQL
		gatedSuite(POSTGRES_READY)
		(
			'ProjectTrack on PostgreSQL (E1, E2, coverage folds, O5 plan forms)',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

				test('the domain runs on PostgreSQL with its principals and traps',
					() =>
					{
						Expect(_Harness.provider).to.equal('PostgreSQL');
						[ 'Lead', 'Member', 'Outsider', 'OtherLead' ].forEach((pName) => { Expect(_Harness.as(pName)).to.have.property('Tenant'); });
						Expect(_Harness.traps.E1ClientIDs).to.be.an('array');
					});

				[ 'Lead', 'Member', 'Outsider', 'OtherLead' ].forEach(
					(pPrincipal) =>
					{
						test(`E1 and E2 as ${pPrincipal}: Live == Reference (O1) with the pinned Now`,
							(fDone) =>
							{
								let tmpOptions = Object.assign({}, _Harness.as(pPrincipal), { Now: TEST_NOW });
								compareInProcess(_Harness, 'Project', bodyE1(_Harness.traps), tmpOptions,
									(pError, pResult) =>
									{
										Expect(pError, pError ? `${pError.Code || ''} ${pError.message}` : '').to.not.exist;
										assertSameEnvelope(pResult, bodyE1(_Harness.traps));
										compareInProcess(_Harness, 'Document', bodyE2(_Harness.traps), tmpOptions,
											(pE2Error, pE2Result) =>
											{
												Expect(pE2Error, pE2Error ? `${pE2Error.Code || ''} ${pE2Error.message}` : '').to.not.exist;
												assertSameEnvelope(pE2Result, bodyE2(_Harness.traps));
												return fDone();
											});
									});
							});
					});

				PROJECTTRACK_COVERAGE.forEach(
					(pCase) =>
					{
						test(`${pCase.Name} as Lead and as OtherLead: Live == Reference`,
							(fDone) =>
							{
								compareInProcess(_Harness, pCase.Entity, pCase.Body, Object.assign({}, _Harness.as('Lead'), { Now: TEST_NOW }),
									(pError, pResult) =>
									{
										Expect(pError, pError ? `${pError.Code || ''} ${pError.message}` : '').to.not.exist;
										assertSameEnvelope(pResult, pCase.Body);
										compareInProcess(_Harness, pCase.Entity, pCase.Body, Object.assign({}, _Harness.as('OtherLead'), { Now: TEST_NOW }),
											(pOtherError, pOther) =>
											{
												Expect(pOtherError, pOtherError ? pOtherError.message : '').to.not.exist;
												assertSameEnvelope(pOther, pCase.Body);
												return fDone();
											});
									});
							});
					});

				test('E1 Total and the Records page equal hand-written SQL over the PostgreSQL database (as Lead)',
					(fDone) =>
					{
						let tmpLead = _Harness.as('Lead');
						_Harness.query('Project', bodyE1(_Harness.traps), Object.assign({}, tmpLead, { Now: TEST_NOW }),
							(pError, pEnvelope) =>
							{
								Expect(pError, pError ? pError.message : '').to.not.exist;
								let tmpSQL = 'SELECT "p"."IDProject" AS "K" FROM "Project" "p" WHERE "p"."Deleted" = 0 AND "p"."IDCustomer" = $1'
									+ ' AND (EXISTS (SELECT 1 FROM "ProjectMembership" "m" WHERE "m"."IDProject" = "p"."IDProject" AND "m"."Deleted" = 0 AND "m"."IDCustomer" = $1'
									+ ' AND "m"."IDUser" = $2 AND "m"."Role" IN (\'Owner\', \'Lead\') AND "m"."Active" = 1) OR "p"."OwnerIDUser" = $2)'
									+ ' AND EXISTS (SELECT 1 FROM "Task" "t" WHERE "t"."IDProject" = "p"."IDProject" AND "t"."Deleted" = 0 AND "t"."IDCustomer" = $1'
									+ ' AND "t"."AssignedIDUser" = $2 AND "t"."DueDate" < $3 AND "t"."Status" <> \'Done\')'
									+ ' AND NOT EXISTS (SELECT 1 FROM "Issue" "s" WHERE "s"."IDProject" = "p"."IDProject" AND "s"."Deleted" = 0 AND "s"."IDCustomer" = $1'
									+ ' AND "s"."Severity" = \'Blocker\' AND "s"."State" = \'Open\')'
									+ ' AND "p"."Status" IN (\'Active\', \'AtRisk\')'
									+ ' AND EXISTS (SELECT 1 FROM "Client" "c" WHERE "c"."IDClient" = "p"."IDClient" AND "c"."Deleted" = 0 AND "c"."IDCustomer" = $1 AND "c"."IDClient" = ANY($4::int[]))'
									+ ' AND "p"."StartDate" >= \'2026-01-01 00:00:00\' AND "p"."StartDate" < \'2027-01-01 00:00:00\''
									+ ' ORDER BY CASE WHEN "p"."StartDate" IS NULL THEN 1 ELSE 0 END, "p"."StartDate" DESC, "p"."IDProject"';
								sqlRows(_Harness, tmpSQL, [ tmpLead.Tenant, tmpLead.User, TEST_NOW_SQL, _Harness.traps.E1ClientIDs ],
									(pSQLError, pRows) =>
									{
										Expect(pSQLError).to.not.exist;
										Expect(pEnvelope.Total).to.equal(pRows.length);
										if (Array.isArray(pEnvelope.Records))
										{
											Expect(pEnvelope.Records.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(pRows.slice(0, 50).map((pRow) => { return pRow.K; }));
										}
										return fDone();
									});
							});
					});

				test('O5 on PostgreSQL: E1 is identical under every plan form (per Variant, cube, staged keys, both)',
					(fDone) =>
					{
						let tmpLead = _Harness.as('Lead');
						let tmpEnvelopes = [];
						let fForm = (pIndex) =>
						{
							if (pIndex >= PLAN_FORMS.length)
							{
								for (let i = 1; i < tmpEnvelopes.length; i++)
								{
									Expect(tmpEnvelopes[i], `${PLAN_FORMS[i].Name} vs ${PLAN_FORMS[0].Name}`).to.deep.equal(tmpEnvelopes[0]);
								}
								return fDone();
							}
							_Harness.query('Project', bodyE1(_Harness.traps), Object.assign({}, tmpLead, { Now: TEST_NOW, PlanForm: PLAN_FORMS[pIndex].PlanForm }),
								(pError, pEnvelope) =>
								{
									Expect(pError, pError ? `${PLAN_FORMS[pIndex].Name}: ${pError.message}` : '').to.not.exist;
									Expect(pEnvelope.Errors || {}, `${PLAN_FORMS[pIndex].Name}: ${JSON.stringify(pEnvelope.Errors || {}).slice(0, 400)}`).to.deep.equal({});
									tmpEnvelopes.push(libFacetEnvelope.normalizeForComparison(pEnvelope));
									return fForm(pIndex + 1);
								});
						};
						return fForm(0);
					});

				test('tenant 2 (OtherLead): every FK key of E1 / E2 / the coverage facets is a tenant-2 row',
					(fDone) =>
					{
						let tmpOther = _Harness.as('OtherLead');
						_Harness.query('Document', { Facets: [ { Key: 'Client', Facet: 'Document.ByClient' }, { Key: 'Form', Facet: 'Document.IDFormType', Top: 50 } ], Total: true }, Object.assign({}, tmpOther, { Now: TEST_NOW }),
							(pError, pEnvelope) =>
							{
								Expect(pError, pError ? pError.message : '').to.not.exist;
								Expect(pEnvelope.Errors || {}).to.deep.equal({});
								sqlRows(_Harness, 'SELECT "IDClient" AS "K" FROM "Client" WHERE "Deleted" = 0 AND "IDCustomer" = $1', [ tmpOther.Tenant ],
									(pSQLError, pRows) =>
									{
										Expect(pSQLError).to.not.exist;
										let tmpOwn = pRows.map((pRow) => { return pRow.K; });
										pEnvelope.Facets.Client.Buckets.forEach((pBucket) => { Expect(tmpOwn, `client ${pBucket.Key}`).to.include(pBucket.Key); });
										sqlRows(_Harness, 'SELECT count(*) AS "N" FROM "Document" WHERE "Deleted" = 0 AND "IDCustomer" = $1', [ tmpOther.Tenant ],
											(pCountError, pCount) =>
											{
												Expect(pCountError).to.not.exist;
												Expect(pEnvelope.Total).to.equal(Number(pCount[0].N));
												return fDone();
											});
									});
							});
					});
			}
		);

		gatedSuite(POSTGRES_READY)
		(
			'LabTrack on PostgreSQL (E3 variants A and B, TenantOnly, co-reference anti-join, TuplePivot, O5 plan forms)',
			() =>
			{
				let _Harness = null;

				let _Violations = [];

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Provider: 'PostgreSQL' },
						(pError) =>
						{
							if (!pError)
							{
								_Violations = installArrayBindGuard(_Harness);
							}
							return fDone(pError);
						});
				});
				// Every statement of the suite: no array bind referenced twice, no empty array (installArrayBindGuard).
				suiteTeardown((fDone) =>
				{
					_Harness.stop((pError) =>
					{
						return fDone((_Violations.length > 0) ? new Error(`array binds the PostgreSQL provider would mis-bind: ${JSON.stringify(_Violations.slice(0, 3))}`) : pError);
					});
				});

				/**
				 * E3A ToDo, written from the definition's prose (internal-contracts §31.5): live tenant
				 * requirement rows whose live intake (Received / InProgress) is in a live queue where the
				 * principal is an active live member, with no live tenant LabForm of ANY owner completing
				 * the same intake and form type.
				 */
				const TODO_SQL = 'SELECT "r"."IDMaterialIntakeRequirement" AS "K" FROM "MaterialIntakeRequirement" "r" WHERE "r"."Deleted" = 0 AND "r"."IDCustomer" = $1'
					+ ' AND EXISTS (SELECT 1 FROM "MaterialIntake" "i" WHERE "i"."IDMaterialIntake" = "r"."IDMaterialIntake" AND "i"."Deleted" = 0 AND "i"."IDCustomer" = $1'
					+ ' AND "i"."Status" IN (\'Received\', \'InProgress\')'
					+ ' AND EXISTS (SELECT 1 FROM "LabQueue" "q" WHERE "q"."IDLabQueue" = "i"."IDLabQueue" AND "q"."Deleted" = 0 AND "q"."IDCustomer" = $1'
					+ ' AND EXISTS (SELECT 1 FROM "LabQueueMember" "m" WHERE "m"."IDLabQueue" = "q"."IDLabQueue" AND "m"."Deleted" = 0 AND "m"."IDCustomer" = $1'
					+ ' AND "m"."IDUser" = $2 AND "m"."Active" = 1)))'
					+ ' AND NOT EXISTS (SELECT 1 FROM "LabForm" "f" WHERE "f"."IDMaterialIntake" = "r"."IDMaterialIntake" AND "f"."IDLabFormType" = "r"."IDLabFormType"'
					+ ' AND "f"."Deleted" = 0 AND "f"."IDCustomer" = $1 AND "f"."Status" = \'Complete\')';

				test('the domain runs on PostgreSQL with its principals and traps',
					() =>
					{
						Expect(_Harness.provider).to.equal('PostgreSQL');
						[ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ].forEach((pName) => { Expect(_Harness.as(pName)).to.have.property('Tenant'); });
					});

				[ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ].forEach(
					(pPrincipal) =>
					{
						test(`E3 variants A and B as ${pPrincipal}: Live == Reference (O1)`,
							(fDone) =>
							{
								let tmpOptions = Object.assign({}, _Harness.as(pPrincipal), { Now: TEST_NOW });
								compareInProcess(_Harness, 'MaterialIntakeRequirement', BODY_E3A, tmpOptions,
									(pError, pResult) =>
									{
										Expect(pError, pError ? `${pError.Code || ''} ${pError.message}` : '').to.not.exist;
										assertSameEnvelope(pResult, BODY_E3A);
										compareInProcess(_Harness, 'MaterialIntake', BODY_E3B, tmpOptions,
											(pBError, pBResult) =>
											{
												Expect(pBError, pBError ? `${pBError.Code || ''} ${pBError.message}` : '').to.not.exist;
												assertSameEnvelope(pBResult, BODY_E3B);
												return fDone();
											});
									});
							});
					});

				LABTRACK_COVERAGE.forEach(
					(pCase) =>
					{
						test(`${pCase.Name} as Tech: Live == Reference`,
							(fDone) =>
							{
								compareInProcess(_Harness, pCase.Entity, pCase.Body, Object.assign({}, _Harness.as('Tech'), { Now: TEST_NOW }),
									(pError, pResult) =>
									{
										Expect(pError, pError ? `${pError.Code || ''} ${pError.message}` : '').to.not.exist;
										assertSameEnvelope(pResult, pCase.Body);
										return fDone();
									});
							});
					});

				[ 'Tech', 'OtherTech' ].forEach(
					(pPrincipal) =>
					{
						test(`E3A ToDo.Total as ${pPrincipal} equals hand-written SQL, and equals the ToDoForMe Records/Count route and the Records page length`,
							(fDone) =>
							{
								let tmpPrincipal = _Harness.as(pPrincipal);
								_Harness.query('MaterialIntakeRequirement', BODY_E3A, Object.assign({}, tmpPrincipal, { Now: TEST_NOW }),
									(pError, pEnvelope) =>
									{
										Expect(pError, pError ? pError.message : '').to.not.exist;
										Expect(pEnvelope.Errors || {}).to.deep.equal({});
										sqlRows(_Harness, TODO_SQL, [ tmpPrincipal.Tenant, tmpPrincipal.User ],
											(pSQLError, pRows) =>
											{
												Expect(pSQLError).to.not.exist;
												Expect(pEnvelope.Facets.ToDo.Total).to.equal(pRows.length);
												let tmpPath = '/1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records';
												_Harness.request('POST', `${tmpPath}/Count`, { Clauses: [] }, tmpPrincipal,
													(pCountError, pCountResponse) =>
													{
														Expect(pCountError).to.not.exist;
														Expect(pCountResponse.Status, JSON.stringify(pCountResponse.Body).slice(0, 300)).to.equal(200);
														Expect(pCountResponse.Body.Count).to.equal(pRows.length);
														_Harness.request('POST', `${tmpPath}/0/500`, { Clauses: [] }, tmpPrincipal,
															(pRecordsError, pRecordsResponse) =>
															{
																Expect(pRecordsError).to.not.exist;
																Expect(pRecordsResponse.Status).to.equal(200);
																let tmpKeys = pRecordsResponse.Body.map((pRecord) => { return pRecord.IDMaterialIntakeRequirement; }).sort((pA, pB) => { return pA - pB; });
																Expect(tmpKeys).to.deep.equal(pRows.map((pRow) => { return pRow.K; }).sort((pA, pB) => { return pA - pB; }).slice(0, 500));
																return fDone();
															});
													});
											});
									});
							});
					});

				test('O5 on PostgreSQL: E3A and E3B are identical under every plan form (EXISTS chains, the cube, staged keys)',
					(fDone) =>
					{
						let tmpTech = _Harness.as('Tech');
						let tmpCases = [ [ 'MaterialIntakeRequirement', BODY_E3A ], [ 'MaterialIntake', BODY_E3B ] ];
						let fCase = (pCaseIndex) =>
						{
							if (pCaseIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpEnvelopes = [];
							let fForm = (pIndex) =>
							{
								if (pIndex >= PLAN_FORMS.length)
								{
									for (let i = 1; i < tmpEnvelopes.length; i++)
									{
										Expect(tmpEnvelopes[i], `${tmpCases[pCaseIndex][0]} ${PLAN_FORMS[i].Name}`).to.deep.equal(tmpEnvelopes[0]);
									}
									return fCase(pCaseIndex + 1);
								}
								_Harness.query(tmpCases[pCaseIndex][0], tmpCases[pCaseIndex][1], Object.assign({}, tmpTech, { Now: TEST_NOW, PlanForm: PLAN_FORMS[pIndex].PlanForm }),
									(pError, pEnvelope) =>
									{
										Expect(pError, pError ? `${PLAN_FORMS[pIndex].Name}: ${pError.message}` : '').to.not.exist;
										Expect(pEnvelope.Errors || {}, `${PLAN_FORMS[pIndex].Name}: ${JSON.stringify(pEnvelope.Errors || {}).slice(0, 400)}`).to.deep.equal({});
										tmpEnvelopes.push(libFacetEnvelope.normalizeForComparison(pEnvelope));
										return fForm(pIndex + 1);
									});
							};
							return fForm(0);
						};
						return fCase(0);
					});
			}
		);
	}
);
