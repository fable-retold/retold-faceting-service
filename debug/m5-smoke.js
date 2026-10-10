#!/usr/bin/env node
/**
 * Milestone 5 smoke run (internal-contracts §66.2, port 19193, owner: wiring): boots ProjectTrack and
 * LabTrack on in-memory SQLite with the ClickHouse store (the dedicated rfs-test-clickhouse container,
 * started if needed; each domain materialized into a fresh rfs_<pid>_<n> database, dropped at the end)
 * and shows, over HTTP:
 *
 *   1. the backfill: every entity of both domains Live in the store (rows per entity)
 *   2. E1 (Project, as Lead) with Engine 'Live', then with the default Freshness (Exact): answered by
 *      ClickHouse — Engine / Exact / AsOf / LagMS per facet — with the same numbers as Live
 *   3. E2 (Document, as Lead), E3A (MaterialIntakeRequirement, as Tech), E3B (MaterialIntake, as Tech):
 *      ClickHouse, equal to Live
 *   4. a write through the stock CRUD route (PUT /1.0/Project as Member, a project of E1's answer)
 *   5. at once: Exact → Live (NotExact: the change is observed, not yet applied) with the new numbers;
 *      Fast → ClickHouse, Exact false, LagMS > 0, the old numbers
 *   6. polling Fast until the store caught up: LagMS → 0, Exact true, the new numbers
 *   7. Exact → ClickHouse again, equal to Live; the write undone; the store / freshness status
 *
 *   node debug/m5-smoke.js            (RFS_TEST_CLICKHOUSE_URL=http://user:pw@host:port to use another server)
 *
 * Exit code 0 when every step answered as above, 1 otherwise.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
if (!process.env.RFS_TEST_CLICKHOUSE_URL && !process.env.RFS_TEST_CLICKHOUSE)
{
	// A manual run: use (and start if needed) the dedicated test container.
	process.env.RFS_TEST_CLICKHOUSE = '1';
}

const libHarness = require('../test/support/Facet-Test-Harness.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = 19193;
const STORE = 'ClickHouse';

// Flushes every 1.5 s, so the store's lag after a write is visible for a moment.
const FACETING = { Materializer: { FlushIntervalMS: 1500, IdleTickMS: 20 }, ChangeCapture: { NotifySettleMS: 200 } };

let _ProjectTrack = null;
let _LabTrack = null;
let _Failures = 0;

/**
 * One checked step.
 *
 * @param {string} pLabel
 * @param {boolean} pPassed
 * @param {string} [pDetail]
 */
const step = (pLabel, pPassed, pDetail) =>
{
	if (!pPassed)
	{
		_Failures++;
	}
	console.log(`${pPassed ? 'ok  ' : 'FAIL'} ${pLabel}${pDetail ? `\n       ${pDetail}` : ''}`);
};

/**
 * Promise form of harness.request.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pMethod
 * @param {string} pPath
 * @param {any} pBody
 * @param {Record<string, any>} pPrincipal
 * @return {Promise<{ Status: number, Headers: Record<string, string>, Body: any }>}
 */
const request = (pHarness, pMethod, pPath, pBody, pPrincipal) =>
{
	return new Promise(
		(fResolve, fReject) =>
		{
			pHarness.request(pMethod, pPath, pBody, pPrincipal || {},
				(pError, pResponse) =>
				{
					return pError ? fReject(pError) : fResolve(pResponse);
				});
		});
};

/**
 * Wait.
 *
 * @param {number} pMS
 * @return {Promise<void>}
 */
const sleep = (pMS) =>
{
	return new Promise((fResolve) => { setTimeout(fResolve, pMS); });
};

/**
 * The per-facet engine line of an envelope.
 *
 * @param {Record<string, any>} pEnvelope
 * @return {string}
 */
const enginesText = (pEnvelope) =>
{
	let tmpFacets = pEnvelope.Facets || {};
	let tmpParts = Object.keys(tmpFacets).map(
		(pKey) =>
		{
			let tmpFacet = tmpFacets[pKey];
			let tmpReason = (pEnvelope.Store && pEnvelope.Store.Facets && pEnvelope.Store.Facets[pKey]) ? pEnvelope.Store.Facets[pKey].Reason : null;
			return `${pKey}:${tmpFacet.Engine}${tmpFacet.Exact ? '' : '~'}${tmpReason ? `(${tmpReason})` : ''}`;
		});
	return `Engine ${pEnvelope.Engine}  Exact ${pEnvelope.Exact}  AsOf ${pEnvelope.AsOf}  LagMS ${pEnvelope.LagMS}  Total ${pEnvelope.Total}  [${tmpParts.join(' ')}]`;
};

/**
 * Status buckets of a facet ('Active=3 AtRisk=1').
 *
 * @param {Record<string, any>} pFacet
 * @return {string}
 */
const bucketsText = (pFacet) =>
{
	return pFacet ? pFacet.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).map((pBucket) => { return `${pBucket.Key}=${pBucket.Count}`; }).join(' ') : '-';
};

/**
 * Are two envelopes the same answer (normalizeForComparison: no Engine / AsOf / LagMS / Store)?
 *
 * @param {Record<string, any>} pA
 * @param {Record<string, any>} pB
 * @return {boolean}
 */
const sameAnswer = (pA, pB) =>
{
	return JSON.stringify(libFacetEnvelope.normalizeForComparison(pA)) === JSON.stringify(libFacetEnvelope.normalizeForComparison(pB));
};

/**
 * Stop both harnesses (dropping their databases) and exit.
 */
const finish = () =>
{
	let tmpCode = (_Failures === 0) ? 0 : 1;
	console.log('');
	console.log(tmpCode === 0 ? 'M5 smoke: every step answered as expected.' : `M5 smoke: ${_Failures} step(s) failed.`);
	let fStop = (pHarness, fNext) => { return pHarness ? pHarness.stop(() => { return fNext(); }) : fNext(); };
	fStop(_LabTrack, () => { fStop(_ProjectTrack, () => { process.exit(tmpCode); }); });
};

/**
 * The run.
 */
const run = async () =>
{
	let tmpLead = _ProjectTrack.as('Lead');
	let tmpMember = _ProjectTrack.as('Member');
	let tmpTech = _LabTrack.as('Tech');

	// 1. The backfill.
	[ [ 'ProjectTrack', _ProjectTrack ], [ 'LabTrack', _LabTrack ] ].forEach(
		(pDomain) =>
		{
			let tmpStatus = pDomain[1].faceting.status().Stores.Stores.ClickHouse;
			let tmpEntities = Object.keys(tmpStatus.Entities).map((pEntity) => { return `${pEntity} ${tmpStatus.Entities[pEntity].State} ${tmpStatus.Entities[pEntity].Rows}`; });
			step(`1. ${pDomain[0]}: every entity backfilled into ${pDomain[1].storeDatabase} and Live`, tmpStatus.Available && Object.keys(tmpStatus.Entities).every((pEntity) => { return tmpStatus.Entities[pEntity].State === 'Live'; }), tmpEntities.join(', '));
		});

	let tmpTraps = _ProjectTrack.traps;
	let tmpE1 = (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpTraps.E1ClientIDs, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'Status', Facet: 'Project.Status' },
					{ Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
					{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
					{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
					{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
				],
			Total: true,
			Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
		});
	let tmpE2 = (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ tmpTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
				],
			Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month' }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
			Total: true
		});
	let tmpE3A = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' } ], Total: true };
	let tmpE3B = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' } ], Total: true };

	// 2. E1 Live, then E1 on the store.
	let tmpE1Live = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', Object.assign({ Engine: 'Live' }, tmpE1), tmpLead);
	step('2a. E1 with Engine \'Live\' (the authoritative engine)', (tmpE1Live.Status === 200) && (tmpE1Live.Body.Engine === 'Live'), enginesText(tmpE1Live.Body));
	let tmpE1Store = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', tmpE1, tmpLead);
	let tmpE1AllStore = Object.keys(tmpE1Store.Body.Facets || {}).every((pKey) => { return tmpE1Store.Body.Facets[pKey].Engine === STORE; });
	step('2b. E1 with the default Freshness (Exact): every facet answered by ClickHouse, the same numbers as Live', (tmpE1Store.Status === 200) && tmpE1AllStore && sameAnswer(tmpE1Store.Body, tmpE1Live.Body), enginesText(tmpE1Store.Body));

	// 3. E2, E3A, E3B.
	let tmpCases = [ [ '3a. E2 (Document, as Lead)', _ProjectTrack, 'Document', tmpE2, tmpLead ], [ '3b. E3A (MaterialIntakeRequirement, as Tech)', _LabTrack, 'MaterialIntakeRequirement', tmpE3A, tmpTech ], [ '3c. E3B (MaterialIntake, as Tech)', _LabTrack, 'MaterialIntake', tmpE3B, tmpTech ] ];
	for (let i = 0; i < tmpCases.length; i++)
	{
		let tmpCase = tmpCases[i];
		let tmpLive = await request(tmpCase[1], 'POST', `/1.0/Facet/${tmpCase[2]}/Query`, Object.assign({ Engine: 'Live' }, tmpCase[3]), tmpCase[4]);
		let tmpStore = await request(tmpCase[1], 'POST', `/1.0/Facet/${tmpCase[2]}/Query`, tmpCase[3], tmpCase[4]);
		let tmpAllStore = Object.keys(tmpStore.Body.Facets || {}).every((pKey) => { return tmpStore.Body.Facets[pKey].Engine === STORE; });
		step(`${tmpCase[0]}: ClickHouse, equal to Live`, (tmpStore.Status === 200) && tmpAllStore && sameAnswer(tmpStore.Body, tmpLive.Body), enginesText(tmpStore.Body));
	}

	// 4. A write through the stock CRUD route (as Member: Lead's own reads are not upgraded).
	let tmpRecord = (Array.isArray(tmpE1Live.Body.Records) && (tmpE1Live.Body.Records.length > 0)) ? tmpE1Live.Body.Records[0] : null;
	if (!tmpRecord)
	{
		step('4. a project of E1 to write', false, 'E1 has no records');
		return finish();
	}
	let tmpOldStatus = tmpRecord.Status;
	let tmpNewStatus = (tmpOldStatus === 'Active') ? 'AtRisk' : 'Active';
	let tmpWrite = await request(_ProjectTrack, 'PUT', '/1.0/Project', { IDProject: tmpRecord.IDProject, Status: tmpNewStatus }, tmpMember);
	step(`4. PUT /1.0/Project { IDProject: ${tmpRecord.IDProject}, Status: '${tmpNewStatus}' } as Member`, (tmpWrite.Status === 200), `→ ${tmpWrite.Status}`);

	// 5. At once: Exact falls back to Live (with the new numbers); Fast reads the store (the old numbers, a lag).
	let tmpExact = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', tmpE1, tmpLead);
	let tmpExactReason = (tmpExact.Body.Store && tmpExact.Body.Store.Facets.Status) ? tmpExact.Body.Store.Facets.Status.Reason : null;
	step('5a. Exact while the store has not applied the write: Live (NotExact), the new numbers', (tmpExact.Status === 200) && (tmpExact.Body.Facets.Status.Engine === 'Live') && (tmpExactReason === 'NotExact') && (bucketsText(tmpExact.Body.Facets.Status) !== bucketsText(tmpE1Live.Body.Facets.Status)),
		`${enginesText(tmpExact.Body)}\n       Status[${bucketsText(tmpExact.Body.Facets.Status)}] (before: [${bucketsText(tmpE1Live.Body.Facets.Status)}])`);
	let tmpFast = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', Object.assign({ Freshness: { Mode: 'Fast' } }, tmpE1), tmpLead);
	step('5b. Fast at the same moment: ClickHouse, Exact false, LagMS > 0, the old numbers', (tmpFast.Status === 200) && (tmpFast.Body.Facets.Status.Engine === STORE) && (tmpFast.Body.Exact === false) && (tmpFast.Body.LagMS > 0) && (bucketsText(tmpFast.Body.Facets.Status) === bucketsText(tmpE1Live.Body.Facets.Status)),
		`${enginesText(tmpFast.Body)}\n       Status[${bucketsText(tmpFast.Body.Facets.Status)}]`);

	// 6. The store catching up (poll Fast).
	let tmpCaughtUp = null;
	let tmpPolls = [];
	for (let i = 0; (i < 50) && !tmpCaughtUp; i++)
	{
		await sleep(150);
		let tmpPoll = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', Object.assign({ Freshness: { Mode: 'Fast' } }, tmpE1), tmpLead);
		tmpPolls.push(`${tmpPoll.Body.LagMS}${tmpPoll.Body.Exact ? '✓' : ''}`);
		if (tmpPoll.Body.Exact === true)
		{
			tmpCaughtUp = tmpPoll;
		}
	}
	step('6. Fast until the store caught up: LagMS → 0, Exact, the new numbers', !!tmpCaughtUp && (tmpCaughtUp.Body.LagMS === 0) && (tmpCaughtUp.Body.Facets.Status.Engine === STORE) && sameAnswer(tmpCaughtUp.Body, tmpExact.Body),
		`LagMS per poll: ${tmpPolls.join(' ')}${tmpCaughtUp ? `\n       ${enginesText(tmpCaughtUp.Body)}` : ''}`);

	// 7. Exact on the store again; undo.
	let tmpExactAgain = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', tmpE1, tmpLead);
	let tmpLiveAgain = await request(_ProjectTrack, 'POST', '/1.0/Facet/Project/Query', Object.assign({ Engine: 'Live' }, tmpE1), tmpLead);
	step('7a. Exact after the flush: ClickHouse again, equal to Live', (tmpExactAgain.Body.Facets.Status.Engine === STORE) && sameAnswer(tmpExactAgain.Body, tmpLiveAgain.Body), enginesText(tmpExactAgain.Body));
	let tmpUndo = await request(_ProjectTrack, 'PUT', '/1.0/Project', { IDProject: tmpRecord.IDProject, Status: tmpOldStatus }, tmpMember);
	step(`7b. the write undone (Status '${tmpOldStatus}')`, (tmpUndo.Status === 200), `→ ${tmpUndo.Status}`);

	let tmpStatus = _ProjectTrack.faceting.status();
	console.log('');
	console.log(`Store          ${JSON.stringify(tmpStatus.StoreClickHouse)}`);
	console.log(`Freshness      ${JSON.stringify(tmpStatus.Freshness.Entities)}`);
	console.log(`Project mirror ${JSON.stringify(tmpStatus.Stores.Stores.ClickHouse.Entities.Project)}`);
	return finish();
};

_ProjectTrack = libHarness.start({ Port: PORT, FixedPort: true, Fixture: 'ProjectTrack', LogLevel: 'error', Store: STORE, Faceting: FACETING },
	(pError) =>
	{
		if (pError)
		{
			console.error(`ProjectTrack harness failed to start: ${pError.message}`);
			return finish();
		}
		_LabTrack = libHarness.start({ Port: PORT, Fixture: 'LabTrack', LogLevel: 'error', Store: STORE, Faceting: FACETING },
			(pLabError) =>
			{
				if (pLabError)
				{
					console.error(`LabTrack harness failed to start: ${pLabError.message}`);
					return finish();
				}
				console.log(`Retold faceting M5 smoke: ProjectTrack on ${_ProjectTrack.baseURL}, LabTrack on ${_LabTrack.baseURL} (SQLite sources, ClickHouse store)`);
				console.log('');
				run().catch(
					(pRunError) =>
					{
						_Failures++;
						console.error(`M5 smoke failed: ${pRunError.stack || pRunError.message}`);
						return finish();
					});
			});
	});
