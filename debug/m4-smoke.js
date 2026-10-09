#!/usr/bin/env node
/**
 * Milestone 4 smoke run (internal-contracts §49.1, port 19192, owner: wiring): boots the ProjectTrack
 * harness with Cache.Enabled on in-memory SQLite, renumbers the story principal to the principal of
 * design 08 (user 42 in tenant 7, as debug/m2-smoke.js does), and shows the change-capture loop end
 * to end over HTTP:
 *
 *   1. GET /1.0/Facet/Changes as user 42 (the SSE stream; 'ready' arrives)
 *   2. E1 (POST /1.0/Facet/Project/Query)                      → 200, X-Retold-Facet-Cache: Miss, ETag A
 *   3. E1 again                                                 → 200, Hit, the same ETag A
 *   4. E1 with If-None-Match: A                                 → 304, NotModified (no SQL ran)
 *   5. a write through the stock CRUD route: PUT /1.0/Project  { IDProject, Status }   (a project of E1)
 *   6. the SSE 'generation' event for Project                   (≈ CoalesceMS later)
 *   7. E1 with If-None-Match: A                                 → 200, Miss, a new ETag B (the counts moved)
 *   8. E1 again                                                 → 200, Hit, ETag B
 *   9. the write undone (PUT back), then the ResultCache / Generations / ChangeIntake / SSE stats
 *
 *   node debug/m4-smoke.js
 *
 * Exit code 0 when every step answered as above, 1 otherwise.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libHarness = require('../test/support/Facet-Test-Harness.js');

const PORT = 19192;

// The principal of design 08, and the fixtures' story principal renumbered to it.
const TENANT = 7;
const USER = 42;
const SEED_TENANT = 1;
const SEED_USER = 1;
const PRINCIPAL = { Tenant: TENANT, User: USER };

let _Harness = null;
let _Failures = 0;
let _Stream = null;

/**
 * Renumber the story principal of a seeded SQLite database to the principal of 08.
 *
 * @param {Record<string, any>} pHarness
 */
const renumber = (pHarness) =>
{
	let tmpTables = pHarness.model.Tables;
	Object.keys(tmpTables).forEach(
		(pTable) =>
		{
			tmpTables[pTable].Columns.forEach(
				(pColumn) =>
				{
					if (pColumn.Column === 'IDCustomer')
					{
						pHarness.db.prepare(`UPDATE "${pTable}" SET "IDCustomer" = ? WHERE "IDCustomer" = ?`).run(TENANT, SEED_TENANT);
					}
					else if (/IDUser$/.test(pColumn.Column))
					{
						pHarness.db.prepare(`UPDATE "${pTable}" SET "${pColumn.Column}" = ? WHERE "${pColumn.Column}" = ?`).run(USER, SEED_USER);
					}
				});
		});
};

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
	console.log(`${pPassed ? 'ok  ' : 'FAIL'} ${pLabel}${pDetail ? `  ${pDetail}` : ''}`);
};

/**
 * Promise form of harness.request.
 *
 * @param {string} pMethod
 * @param {string} pPath
 * @param {any} pBody
 * @param {Record<string, any>} [pHeaders]
 * @return {Promise<{ Status: number, Headers: Record<string, string>, Body: any }>}
 */
const request = (pMethod, pPath, pBody, pHeaders) =>
{
	return new Promise(
		(fResolve, fReject) =>
		{
			_Harness.request(pMethod, pPath, pBody, Object.assign({ Headers: pHeaders || {} }, PRINCIPAL),
				(pError, pResponse) =>
				{
					return pError ? fReject(pError) : fResolve(pResponse);
				});
		});
};

/**
 * Open the change stream as the principal: a fetch stream reader parsing 'event:' / 'data:' frames.
 *
 * @return {Promise<{ Events: Array<{ Event: string, Data: any }>, waitFor: Function, close: Function }>}
 */
const openStream = async () =>
{
	let tmpAbort = new AbortController();
	let tmpResponse = await fetch(`${_Harness.baseURL}/1.0/Facet/Changes`,
		{
			headers: { 'accept': 'text/event-stream', 'x-facet-test-tenant': String(TENANT), 'x-facet-test-user': String(USER) },
			signal: tmpAbort.signal
		});
	let tmpStream = { Status: tmpResponse.status, Events: [], Waiters: [], Closed: false };
	tmpStream.close = () =>
	{
		tmpStream.Closed = true;
		tmpAbort.abort();
	};
	tmpStream.waitFor = (pType, pMS) =>
	{
		return new Promise(
			(fResolve) =>
			{
				let tmpFound = tmpStream.Events.find((pEvent) => { return (pEvent.Event === pType) && !pEvent.Taken; });
				if (tmpFound)
				{
					tmpFound.Taken = true;
					return fResolve(tmpFound);
				}
				let tmpWaiter = { Type: pType, Resolve: fResolve };
				tmpWaiter.Timer = setTimeout(() => { tmpStream.Waiters.splice(tmpStream.Waiters.indexOf(tmpWaiter), 1); fResolve(null); }, pMS);
				tmpStream.Waiters.push(tmpWaiter);
			});
	};
	let tmpDecoder = new TextDecoder();
	let tmpBuffer = '';
	let tmpReader = tmpResponse.body.getReader();
	let fPump = () =>
	{
		tmpReader.read().then(
			(pChunk) =>
			{
				if (pChunk.done)
				{
					return;
				}
				tmpBuffer += tmpDecoder.decode(pChunk.value, { stream: true });
				let tmpFrames = tmpBuffer.split('\n\n');
				tmpBuffer = tmpFrames.pop();
				tmpFrames.forEach(
					(pFrame) =>
					{
						let tmpEvent = { Event: 'message', Data: null, At: Date.now() };
						let tmpData = [];
						pFrame.split('\n').forEach(
							(pLine) =>
							{
								if (pLine.indexOf('event: ') === 0)
								{
									tmpEvent.Event = pLine.slice(7);
								}
								else if (pLine.indexOf('data: ') === 0)
								{
									tmpData.push(pLine.slice(6));
								}
							});
						if (tmpData.length < 1)
						{
							return;
						}
						tmpEvent.Data = JSON.parse(tmpData.join('\n'));
						let tmpWaiter = tmpStream.Waiters.find((pWaiter) => { return pWaiter.Type === tmpEvent.Event; });
						if (tmpWaiter)
						{
							tmpEvent.Taken = true;
							clearTimeout(tmpWaiter.Timer);
							tmpStream.Waiters.splice(tmpStream.Waiters.indexOf(tmpWaiter), 1);
							tmpWaiter.Resolve(tmpEvent);
						}
						tmpStream.Events.push(tmpEvent);
					});
				return fPump();
			},
			() => { /* aborted */ });
	};
	fPump();
	return tmpStream;
};

/**
 * One Query answer, abridged.
 *
 * @param {Record<string, any>} pResponse
 * @return {string}
 */
const answerText = (pResponse) =>
{
	let tmpHeaders = pResponse.Headers;
	let tmpBody = pResponse.Body || {};
	let tmpStatus = (tmpBody.Facets && tmpBody.Facets.Status) ? tmpBody.Facets.Status.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).map((pBucket) => { return `${pBucket.Key || "''"}=${pBucket.Count}`; }).join(' ') : '-';
	return `${pResponse.Status} ${tmpHeaders['x-retold-facet-cache'] || '-'}  ETag ${tmpHeaders.etag || '-'}  Seq ${tmpHeaders['x-retold-facet-seq'] || '-'}${(pResponse.Status === 200) ? `  Total ${tmpBody.Total}  Status[${tmpStatus}]  Cached ${tmpBody.Cached}  DependsOn ${JSON.stringify(tmpBody.DependsOn)}` : ''}`;
};

/**
 * Stop the harness and exit.
 */
const finish = () =>
{
	if (_Stream)
	{
		_Stream.close();
	}
	let tmpCode = (_Failures === 0) ? 0 : 1;
	console.log('');
	console.log(tmpCode === 0 ? 'M4 smoke: every step answered as expected.' : `M4 smoke: ${_Failures} step(s) failed.`);
	return _Harness ? _Harness.stop(() => { process.exit(tmpCode); }) : process.exit(tmpCode);
};

/**
 * The run.
 */
const run = async () =>
{
	let tmpTraps = _Harness.traps;
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
	let tmpQuery = '/1.0/Facet/Project/Query';

	_Stream = await openStream();
	let tmpReady = await _Stream.waitFor('ready', 2000);
	step('1. GET /1.0/Facet/Changes as user 42 / tenant 7: the stream opens', (_Stream.Status === 200) && !!tmpReady, tmpReady ? `ready ${JSON.stringify(tmpReady.Data)}` : `status ${_Stream.Status}`);

	let tmpFirst = await request('POST', tmpQuery, tmpE1);
	step('2. E1: a miss', (tmpFirst.Status === 200) && (tmpFirst.Headers['x-retold-facet-cache'] === 'Miss'), answerText(tmpFirst));
	let tmpETagA = tmpFirst.Headers.etag;

	let tmpSecond = await request('POST', tmpQuery, tmpE1);
	step('3. E1 again: a hit with the same ETag', (tmpSecond.Status === 200) && (tmpSecond.Headers['x-retold-facet-cache'] === 'Hit') && (tmpSecond.Headers.etag === tmpETagA) && (tmpSecond.Body.Cached === true), answerText(tmpSecond));

	let tmpStatementsBefore = _Harness.faceting.status().Cache.NotModified;
	let tmpNotModified = await request('POST', tmpQuery, tmpE1, { 'if-none-match': tmpETagA });
	step('4. E1 with If-None-Match: a 304 decided before execution', (tmpNotModified.Status === 304) && (tmpNotModified.Headers['x-retold-facet-cache'] === 'NotModified') && (_Harness.faceting.status().Cache.NotModified === tmpStatementsBefore + 1), answerText(tmpNotModified));

	// A project of E1's answer whose status the write moves out of the Status selection's counts.
	let tmpRecord = (Array.isArray(tmpFirst.Body.Records) && (tmpFirst.Body.Records.length > 0)) ? tmpFirst.Body.Records[0] : null;
	if (!tmpRecord)
	{
		step('5. a project of E1 to write', false, 'E1 has no records');
		return finish();
	}
	let tmpOldStatus = tmpRecord.Status;
	let tmpNewStatus = (tmpOldStatus === 'Active') ? 'AtRisk' : 'Active';
	let tmpWrite = await request('PUT', '/1.0/Project', { IDProject: tmpRecord.IDProject, Status: tmpNewStatus });
	step(`5. PUT /1.0/Project { IDProject: ${tmpRecord.IDProject}, Status: '${tmpNewStatus}' } through the stock CRUD route`, (tmpWrite.Status === 200), `→ ${tmpWrite.Status}`);

	let tmpEvent = await _Stream.waitFor('generation', 3000);
	step('6. the SSE generation event for Project', !!tmpEvent && (tmpEvent.Data.Entity === 'Project') && (Object.keys(tmpEvent.Data).sort().join(',') === 'Entity,Generation,Seq'), tmpEvent ? `${JSON.stringify(tmpEvent.Data)}` : 'no event within 3 s');

	let tmpThird = await request('POST', tmpQuery, tmpE1, { 'if-none-match': tmpETagA });
	step('7. E1 with the old ETag after the write: a miss with a new ETag', (tmpThird.Status === 200) && (tmpThird.Headers['x-retold-facet-cache'] === 'Miss') && (tmpThird.Headers.etag !== tmpETagA), answerText(tmpThird));

	let tmpFourth = await request('POST', tmpQuery, tmpE1);
	step('8. E1 again: a hit with the new ETag', (tmpFourth.Status === 200) && (tmpFourth.Headers['x-retold-facet-cache'] === 'Hit') && (tmpFourth.Headers.etag === tmpThird.Headers.etag), answerText(tmpFourth));

	let tmpUndo = await request('PUT', '/1.0/Project', { IDProject: tmpRecord.IDProject, Status: tmpOldStatus });
	step(`9. the write undone (Status '${tmpOldStatus}')`, (tmpUndo.Status === 200), `→ ${tmpUndo.Status}`);

	let tmpStatus = _Harness.faceting.status();
	console.log('');
	console.log(`ResultCache    ${JSON.stringify(tmpStatus.Cache)}`);
	console.log(`Generations    ${JSON.stringify(tmpStatus.Generations)}`);
	console.log(`ChangeIntake   ${JSON.stringify(tmpStatus.Changes)}`);
	console.log(`SSE            ${JSON.stringify(tmpStatus.SSE)}`);
	console.log(`ReadYourWrites ${JSON.stringify(tmpStatus.ReadYourWrites)}`);
	return finish();
};

// ExposeStatus / SeqHeader / IncludeSeq: this run shows the cache status and the Seq (their defaults
// keep both away from clients on a multi-tenant host, internal-contracts §51.10 / §51.57).
_Harness = libHarness.start({ Port: PORT, FixedPort: true, Fixture: 'ProjectTrack', LogLevel: 'error', Faceting: { Cache: { Enabled: true, ExposeStatus: true }, Freshness: { SeqHeader: true }, SSE: { CoalesceMS: 100, IncludeSeq: true } } },
	(pError) =>
	{
		if (pError)
		{
			console.error(`ProjectTrack harness failed to start: ${pError.message}`);
			process.exit(1);
		}
		renumber(_Harness);
		console.log(`Retold faceting M4 smoke: ProjectTrack on ${_Harness.baseURL} (SQLite, Cache.Enabled), as user ${USER} / tenant ${TENANT}`);
		console.log('');
		run().catch(
			(pRunError) =>
			{
				_Failures++;
				console.error(`M4 smoke failed: ${pRunError.stack || pRunError.message}`);
				return finish();
			});
	});
