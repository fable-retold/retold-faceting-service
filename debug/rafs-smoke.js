#!/usr/bin/env node
/**
 * retold-application-foundation-server smoke run (internal-contracts Part V, port 19194): boots a real RAFS
 * app in-process with both faceting installers in its own hookInstallers() / routeInstallers() (the test
 * harness test/support/Facet-RAFS-Harness.js: in-memory SQLite, the Kit identity shape, Retold-Tenancy,
 * Retold-Entitlements and Retold-Membership, every user logged in through POST /1.0/Authenticate) and shows,
 * over HTTP on 127.0.0.1:19194, for two users in two tenants:
 *
 *   1. GET /1.0/Facet/Describe: Role, ScopeAssurance, the Live dialect and the facetable entities
 *   2. LabTrack — E3A (POST /1.0/Facet/MaterialIntakeRequirement/Query, "the lab forms I still have to fill
 *      out") as Tech (tenant 1) and OtherTech (tenant 2): Total and the buckets of every facet, then the
 *      same request through the Reference in-process (the entity's own RAFS list waterfall, same session)
 *   3. ProjectTrack — E1 (POST /1.0/Facet/Project/Query, "the projects for this user by complex criteria")
 *      as Lead (tenant 1) and OtherLead (tenant 2), the same way
 *   4. anonymous and the authenticated tenant-0 session: 401
 *
 * The two apps boot one after the other on the same port.  RAFS is private: without the monorepo checkout
 * (or RFS_TEST_RAFS_PATH) the run says so and exits 0.
 *
 *   node debug/rafs-smoke.js
 *
 * Exit code 0 when every step answered as above, 1 otherwise.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libRAFSHarness = require('../test/support/Facet-RAFS-Harness.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = libRAFSHarness.SMOKE_PORT;

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
 * Promise forms of the harness helpers.
 */
const start = (pOptions) =>
{
	return new Promise(
		(fResolve, fReject) =>
		{
			let tmpHarness = libRAFSHarness.start(pOptions, (pError) => { return pError ? fReject(Object.assign(pError, { Harness: tmpHarness })) : fResolve(tmpHarness); });
		});
};
const call = (pHarness, pMethod, ...pArguments) =>
{
	let tmpArguments = pArguments;
	return new Promise(
		(fResolve, fReject) =>
		{
			pHarness[pMethod].apply(pHarness, tmpArguments.concat([ (pError, pResult) => { return pError ? fReject(pError) : fResolve(pResult); } ]));
		});
};
const stop = (pHarness) =>
{
	return new Promise((fResolve) => { pHarness.stop(() => { return fResolve(); }); });
};

/**
 * 'Key=Count …' of the counted buckets of a facet (labels when resolved).
 *
 * @param {Record<string, any>} pFacet
 * @return {string}
 */
const bucketsText = (pFacet) =>
{
	if (!pFacet || !Array.isArray(pFacet.Buckets))
	{
		return '-';
	}
	return pFacet.Buckets.filter((pBucket) => { return pBucket.Count > 0; }).slice(0, 8)
		.map((pBucket) => { return `${(pBucket.LabelResolved && (pBucket.Label !== String(pBucket.Key))) ? `${pBucket.Key}:${pBucket.Label}` : pBucket.Key}=${pBucket.Count}`; }).join('  ');
};

/**
 * Describe as one user.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pName
 */
const describeAs = async (pHarness, pName) =>
{
	let tmpResponse = await call(pHarness, 'describe', null, pName);
	let tmpDescribe = tmpResponse.JSON || {};
	step(`GET /1.0/Facet/Describe as ${pName} (tenant ${pHarness.as(pName).Tenant}) → ${tmpResponse.Status}`, tmpResponse.Status === 200,
		`Role ${tmpDescribe.Role}  ScopeAssurance ${tmpDescribe.ScopeAssurance}  Live ${(tmpDescribe.Engines && tmpDescribe.Engines.Live) ? tmpDescribe.Engines.Live.Dialect : '?'}\n       Entities: ${Object.keys(tmpDescribe.Entities || {}).join(', ')}`);
};

/**
 * One motivating query as one user: HTTP Live, then the Reference in-process as the same session.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pLabel
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {string} pName
 */
const queryAs = async (pHarness, pLabel, pEntity, pBody, pName) =>
{
	let tmpResponse = await call(pHarness, 'facet', pEntity, pBody, pName);
	let tmpEnvelope = tmpResponse.JSON || {};
	let tmpErrors = Object.keys(tmpEnvelope.Errors || {});
	step(`${pLabel}: POST /1.0/Facet/${pEntity}/Query as ${pName} (tenant ${pHarness.as(pName).Tenant}) → ${tmpResponse.Status}`, (tmpResponse.Status === 200) && (tmpErrors.length < 1),
		[ `Total ${tmpEnvelope.Total}  Engine ${tmpEnvelope.Engine}  ETag ${tmpResponse.Headers.etag}` ]
			.concat(Object.keys(tmpEnvelope.Facets || {}).map((pKey) => { return `${pKey.padEnd(10)} ${bucketsText(tmpEnvelope.Facets[pKey])}`; }))
			.concat(tmpErrors.map((pKey) => { return `${pKey}: ${tmpEnvelope.Errors[pKey].Code}`; }))
			.join('\n       '));
	let tmpLive = await call(pHarness, 'query', pEntity, pBody, { As: pName });
	let tmpReference = await call(pHarness, 'reference', pEntity, pBody, { As: pName });
	let tmpSame = (JSON.stringify(libFacetEnvelope.normalizeForComparison(tmpEnvelope)) === JSON.stringify(libFacetEnvelope.normalizeForComparison(tmpLive)))
		&& (JSON.stringify(libFacetEnvelope.normalizeForComparison(tmpLive)) === JSON.stringify(libFacetEnvelope.normalizeForComparison(tmpReference)));
	step(`${pLabel} as ${pName}: HTTP == in-process Live == the Reference (RAFS's own list waterfall, same session)`, tmpSame);
	return tmpEnvelope;
};

/**
 * Anonymous and tenant 0: 401 on the facet route.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 */
const refusedAs = async (pHarness, pEntity, pBody) =>
{
	for (let tmpName of [ null, 'TenantZero' ])
	{
		let tmpResponse = await call(pHarness, 'facet', pEntity, pBody, tmpName);
		step(`POST /1.0/Facet/${pEntity}/Query as ${tmpName || 'anonymous'} → ${tmpResponse.Status} ${(tmpResponse.JSON && tmpResponse.JSON.Error) ? tmpResponse.JSON.Error.Code : ''}`, tmpResponse.Status === 401);
	}
};

const E3A = (
	{
		Facets:
			[
				{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' },
				{ Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
				{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' },
				{ Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' }
			]
	});

const e1Body = (pTraps) =>
{
	return (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: pTraps.E1ClientIDs.slice(), FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'Status', Facet: 'Project.Status' },
					{ Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
					{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
					{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' }
				],
			Total: true
		});
};

const main = async () =>
{
	let tmpRAFS = libRAFSHarness.resolveRAFS();
	if (!tmpRAFS.Available)
	{
		console.log(`skipped: ${tmpRAFS.Reason}`);
		return 0;
	}
	console.log(`retold-application-foundation-server ${tmpRAFS.Version} (${tmpRAFS.Path})`);
	let tmpApps = [ { Fixture: 'LabTrack', Users: [ 'Tech', 'OtherTech' ] }, { Fixture: 'ProjectTrack', Users: [ 'Lead', 'OtherLead' ] } ];
	for (let tmpApp of tmpApps)
	{
		let tmpHarness = null;
		try
		{
			tmpHarness = await start({ Port: PORT, FixedPort: true, Fixture: tmpApp.Fixture, Session: 'Login', LogLevel: 'error' });
			console.log(`\n== ${tmpApp.Fixture} on ${tmpHarness.baseURL} (Login sessions: Auth.Local + Entitlements + Membership; tenancy coverage: ${Object.keys(tmpHarness.host.tenancySnapshot().Classes).filter((pEntity) => { return tmpHarness.host.tenancySnapshot().Classes[pEntity] === 'Installed'; }).length} Installed entities)`);
			for (let tmpName of tmpApp.Users)
			{
				await describeAs(tmpHarness, tmpName);
			}
			let tmpTotals = [];
			for (let tmpName of tmpApp.Users)
			{
				let tmpEnvelope = (tmpApp.Fixture === 'LabTrack')
					? await queryAs(tmpHarness, 'E3A', 'MaterialIntakeRequirement', E3A, tmpName)
					: await queryAs(tmpHarness, 'E1', 'Project', e1Body(tmpHarness.traps), tmpName);
				tmpTotals.push(tmpEnvelope.Total);
			}
			if (tmpApp.Fixture === 'LabTrack')
			{
				step(`E3A: the two tenants see their own requirements (${tmpTotals.join(' vs ')})`, tmpTotals[0] !== tmpTotals[1]);
				await refusedAs(tmpHarness, 'MaterialIntakeRequirement', E3A);
			}
			else
			{
				await refusedAs(tmpHarness, 'Project', e1Body(tmpHarness.traps));
			}
		}
		catch (pError)
		{
			step(`${tmpApp.Fixture}`, false, pError.stack || pError.message);
			tmpHarness = tmpHarness || pError.Harness || null;
		}
		if (tmpHarness)
		{
			await stop(tmpHarness);
		}
	}
	console.log(`\n${(_Failures > 0) ? `FAILED: ${_Failures} step(s)` : 'all steps ok'}`);
	return (_Failures > 0) ? 1 : 0;
};

main().then(
	(pCode) =>
	{
		process.exitCode = pCode;
	},
	(pError) =>
	{
		console.error(pError);
		process.exitCode = 1;
	});
