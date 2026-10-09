#!/usr/bin/env node
/**
 * Faceting-Demo-Smoke -- `npm test` in the example (DEMO-SPEC §2.5, §9): boot the whole demo IN-PROCESS on
 * port 19301 (Faceting-Demo-Server.startDemo, SQLite, Small) and drive it THROUGH THE FRONT SERVER the way
 * the browser does, building every body with the frozen client contract (Facet-Selection.js +
 * FacetDemo-Pages.js), so what passes here is byte-for-byte what the browser sends.
 *
 *    1. static: /, /pict.min.js, /<bundle>.compatible.min.js (skipped with a note when dist/ is not built)
 *    2. /api/Demo/Principals (5 personas), /api/Demo/Status (3 domains, clean definitions, guards on)
 *    3. Describe as user42: the scopes / declared facets each page uses
 *    4. every group x every persona -> FacetDemo-Pages.EXPECTED_INITIAL_TOTALS; anonymous -> 401
 *    5. the same Query with If-None-Match -> 304
 *    6. Records/Count == envelope Total, Records/25/25 row counts, envelope Records == min(Cap, Total)
 *    7. write-back round trips (toggleTermsKey, rangeClause, pivotCellSelections): Total == Records/Count
 *    8. forged x-facet-test-* headers are never forwarded
 *    9. Documents ByMonth Interval 'day' -> per-facet 422 FACET_INTERVAL_TOO_FINE, Suggest week
 *   10. every domain server listens on 127.0.0.1 only with the loopback guard installed (before listen);
 *       when the machine has a LAN address, a direct request to a domain server from it is refused
 *   11. the client's display logic against real answers: the Describe-derived Books facets, lookups (the
 *       work list's Started column == the Started facet for every row), the variant A / B breakdown
 *       (In both + Stored only == A, In both + Configured only == B, nothing negative), histogram coverage ==
 *       the server's Selected flags (and partial edge buckets after an interval change), the readout's range
 *       text, the Query body always asking for page 1
 *   + the demo host's own errors (unknown domain / route, method, body size, Host header, dot segments)
 *   + a stopped domain answers 502 DEMO_UPSTREAM_UNAVAILABLE (last: it stops the Bookstore domain)
 *
 * Exit 0 when every check passes, 1 with the failed checks listed otherwise; the domains are always stopped.
 * `TZ=UTC DEMO_PG=1 npm test` runs the same checks with every domain on PostgreSQL (rfs-test-postgres).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFS = require('node:fs');
const libHttp = require('node:http');
const libOS = require('node:os');
const libPath = require('node:path');

const libSelection = require('../source/providers/Facet-Selection.js');
const libDisplay = require('../source/providers/Facet-Display.js');
const libLookup = require('../source/providers/Facet-Lookup.js');
const libPages = require('../source/pages/FacetDemo-Pages.js');
const libServer = require('./Faceting-Demo-Server.js');
const libPersonas = require('./Faceting-Demo-Personas.js');

const SMOKE_PORT = 19301;
const EXAMPLE_ROOT = libPath.resolve(__dirname, '..');
const PACKAGE = require(libPath.join(EXAMPLE_ROOT, 'package.json'));
const BUNDLE = `${PACKAGE.name}.compatible.min.js`;

// Definitions each domain must load (DEMO-SPEC §2.2).
const EXPECTED_DEFINITIONS =
{
	ProjectTrack: { Facets: 4, Scopes: 5, Disabled: 0, Warnings: 0 },
	LabTrack: { Facets: 9, Scopes: 2, Disabled: 0, Warnings: 2 },
	Bookstore: { Facets: 3, Scopes: 1, Disabled: 0, Warnings: 0 }
};

// Groups with a list (Records) that must agree with the envelope Total.
const LIST_GROUPS = [ 'Projects', 'Documents', 'LabFormsA', 'Books' ];

let _Demo = null;
// The Books facet list the browser derives from Describe (set in section 3; groupState('Books') uses it).
let _BooksDescribed = null;
let _Checks = 0;
let _Skipped = [];
let _Failures = [];
let _Section = '';
let _Provider = 'SQLite';

/**
 * Record one check.
 *
 * @param {string} pName
 * @param {boolean} pPassed
 * @param {any} [pDetail] - printed on failure (expected / actual)
 * @return {boolean}
 */
const check = (pName, pPassed, pDetail) =>
{
	_Checks++;
	if (!pPassed)
	{
		_Failures.push({ Section: _Section, Name: pName, Detail: pDetail });
		console.log(`    FAIL  ${pName}${(typeof(pDetail) !== 'undefined') ? `\n          ${JSON.stringify(pDetail)}` : ''}`);
	}
	return !!pPassed;
};

/**
 * Compare two values and record the check.
 *
 * @param {string} pName
 * @param {any} pActual
 * @param {any} pExpected
 * @return {boolean}
 */
const checkEqual = (pName, pActual, pExpected) =>
{
	let tmpPassed = (JSON.stringify(pActual) === JSON.stringify(pExpected));
	return check(pName, tmpPassed, tmpPassed ? undefined : { Expected: pExpected, Actual: pActual });
};

/**
 * Start a section of the report.
 *
 * @param {string} pTitle
 */
const section = (pTitle) =>
{
	_Section = pTitle;
	console.log(`  ${pTitle}`);
};

/**
 * One request through the front server, the way the browser sends it.
 *
 * @param {string} pMethod
 * @param {string} pPath - '/api/…' or a static path
 * @param {any} [pBody] - JSON body (POST)
 * @param {{ Persona?: string, Headers?: Record<string, string> }} [pOptions]
 * @return {Promise<{ Status: number, Headers: Record<string, string>, Body: any, Text: string, Bytes: number }>}
 */
const call = async (pMethod, pPath, pBody, pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpHeaders = Object.assign({ 'Accept': 'application/json' }, tmpOptions.Headers || {});
	if (typeof(tmpOptions.Persona) === 'string')
	{
		tmpHeaders[libPersonas.HEADER] = tmpOptions.Persona;
	}
	let tmpFetch = { method: pMethod, headers: tmpHeaders };
	if ((typeof(pBody) !== 'undefined') && (pBody !== null))
	{
		tmpHeaders['Content-Type'] = 'application/json';
		tmpFetch.body = (typeof(pBody) === 'string') ? pBody : JSON.stringify(pBody);
	}
	let tmpResponse = await fetch(`http://127.0.0.1:${SMOKE_PORT}${pPath}`, tmpFetch);
	let tmpBuffer = Buffer.from(await tmpResponse.arrayBuffer());
	let tmpText = tmpBuffer.toString('utf8');
	let tmpBody = null;
	try
	{
		tmpBody = (tmpText.length > 0) ? JSON.parse(tmpText) : null;
	}
	catch (pError)
	{
		tmpBody = null;
	}
	let tmpResponseHeaders = {};
	tmpResponse.headers.forEach((pValue, pKey) => { tmpResponseHeaders[pKey] = pValue; });
	return { Status: tmpResponse.status, Headers: tmpResponseHeaders, Body: tmpBody, Text: tmpText, Bytes: tmpBuffer.length };
};

/**
 * A raw node:http request (for what fetch will not send: a foreign Host header, a non-loopback address).
 *
 * @param {{ host: string, port: number, path: string, method?: string, headers?: Record<string, string> }} pRequest
 * @return {Promise<{ Status: number, Body: any }>}
 */
const rawCall = (pRequest) =>
{
	return new Promise(
		(fResolve, fReject) =>
		{
			let tmpRequest = libHttp.request(Object.assign({ method: 'GET', timeout: 4000 }, pRequest),
				(pResponse) =>
				{
					let tmpChunks = [];
					pResponse.on('data', (pChunk) => { tmpChunks.push(pChunk); });
					pResponse.on('end',
						() =>
						{
							let tmpBody = null;
							try
							{
								tmpBody = JSON.parse(Buffer.concat(tmpChunks).toString('utf8'));
							}
							catch (pError)
							{
								tmpBody = null;
							}
							fResolve({ Status: pResponse.statusCode, Body: tmpBody });
						});
				});
			tmpRequest.on('timeout', () => { tmpRequest.destroy(new Error('timeout')); });
			tmpRequest.on('error', fReject);
			tmpRequest.end();
		});
};

/**
 * A fresh group state (the browser's initial state for a group).
 *
 * @param {string} pGroup
 * @return {Record<string, any>}
 */
const groupState = (pGroup) =>
{
	let tmpState = libSelection.initialGroupState(libPages.Groups[pGroup]);
	if ((libPages.Groups[pGroup].FacetsFrom === 'Describe') && _BooksDescribed && (pGroup === 'Books'))
	{
		tmpState.Facets = libSelection.cloneJSON(_BooksDescribed.Facets);
	}
	return tmpState;
};

/**
 * The browser path of a group request.
 *
 * @param {Record<string, any>} pState
 * @param {string} pKind
 * @param {number} [pBegin]
 * @param {number} [pCap]
 * @return {string}
 */
const browserPath = (pState, pKind, pBegin, pCap) =>
{
	return `/api/${pState.Domain}${libSelection.routePath(pState, pKind, pBegin, pCap)}`;
};

/**
 * POST the group's Query.
 *
 * @param {Record<string, any>} pState
 * @param {string} pPersona
 * @param {Record<string, string>} [pHeaders]
 */
const query = (pState, pPersona, pHeaders) =>
{
	return call('POST', browserPath(pState, libSelection.KIND_QUERY), libSelection.buildQueryBody(pState), { Persona: pPersona, Headers: pHeaders });
};

/**
 * POST the group's Records/Count.
 *
 * @param {Record<string, any>} pState
 * @param {string} pPersona
 */
const recordsCount = (pState, pPersona) =>
{
	return call('POST', browserPath(pState, libSelection.KIND_COUNT), libSelection.buildRecordsBody(pState), { Persona: pPersona });
};

/**
 * The question's total of an envelope: envelope Total, or (LabFormsB) the ToDo facet's.
 *
 * @param {string} pGroup
 * @param {Record<string, any>} pEnvelope
 * @return {number|null}
 */
const totalOf = (pGroup, pEnvelope) =>
{
	if (!pEnvelope)
	{
		return null;
	}
	if (pGroup === 'LabFormsB')
	{
		return (pEnvelope.Facets && pEnvelope.Facets.ToDo) ? pEnvelope.Facets.ToDo.Total : null;
	}
	return pEnvelope.Total;
};

/**
 * Bucket index by key (sameKey) in a facet result.
 *
 * @param {Record<string, any>} pFacet
 * @param {any} pKey
 * @return {number}
 */
const bucketIndex = (pFacet, pKey) =>
{
	let tmpBuckets = (pFacet && Array.isArray(pFacet.Buckets)) ? pFacet.Buckets : [];
	for (let i = 0; i < tmpBuckets.length; i++)
	{
		if (libSelection.sameKey(tmpBuckets[i].Key, pKey) || (tmpBuckets[i].Label === pKey))
		{
			return i;
		}
	}
	return -1;
};

/**
 * Apply selections to a state, query, and check Total == Records/Count.  Returns the new envelope.
 *
 * @param {string} pName
 * @param {Record<string, any>} pState - mutated (Selections)
 * @param {Record<string, any>} pSelections - { FacetKey: clause|null }
 * @param {string} pPersona
 * @param {number|null} pExpectedTotal - null = only Total == Records/Count
 * @return {Promise<Record<string, any>|null>}
 */
const roundTrip = async (pName, pState, pSelections, pPersona, pExpectedTotal) =>
{
	Object.keys(pSelections).forEach(
		(pKey) =>
		{
			if (pSelections[pKey])
			{
				pState.Selections[pKey] = pSelections[pKey];
			}
			else
			{
				delete pState.Selections[pKey];
			}
		});
	pState.Records = pState.Records ? Object.assign({}, pState.Records, { Begin: 0 }) : null;
	let tmpQuery = await query(pState, pPersona);
	if (!checkEqual(`${pName}: Query status`, tmpQuery.Status, 200))
	{
		return null;
	}
	let tmpEnvelope = tmpQuery.Body;
	checkEqual(`${pName}: no facet errors`, Object.keys(tmpEnvelope.Errors || {}), []);
	let tmpCount = await recordsCount(pState, pPersona);
	checkEqual(`${pName}: Records/Count status`, tmpCount.Status, 200);
	checkEqual(`${pName}: Total == Records/Count`, tmpEnvelope.Total, tmpCount.Body ? tmpCount.Body.Count : null);
	if (typeof(pExpectedTotal) === 'number')
	{
		checkEqual(`${pName}: Total`, tmpEnvelope.Total, pExpectedTotal);
	}
	console.log(`    ${pName}: Total ${tmpEnvelope.Total} == Records/Count ${tmpCount.Body ? tmpCount.Body.Count : '?'}`);
	return tmpEnvelope;
};

// ------------------------------------------------------------------------------------------------ checks

const checkStatic = async () =>
{
	section('1. static files');
	let tmpDist = _Demo.Options.DistRoot;
	let tmpBuilt = libFS.existsSync(libPath.join(tmpDist, 'index.html')) && libFS.existsSync(libPath.join(tmpDist, BUNDLE));
	let tmpPict = await call('GET', '/pict.min.js');
	checkEqual('/pict.min.js (dist/ or the installed pict) answers 200', tmpPict.Status, 200);
	check('/pict.min.js is JavaScript', /javascript/.test(tmpPict.Headers['content-type'] || ''), tmpPict.Headers['content-type']);
	if (!tmpBuilt)
	{
		let tmpRoot = await call('GET', '/');
		checkEqual('/ without a build: the "run npm run build" page (503)', tmpRoot.Status, 503);
		_Skipped.push('static bundle checks: dist/ is not built (run npm run build)');
		console.log('    skipped: dist/ is not built (run npm run build) -- bundle and index checks');
	}
	else
	{
		let tmpRoot = await call('GET', '/');
		checkEqual('/ answers 200', tmpRoot.Status, 200);
		check('/ is the index.html (mounts the app container, loads the bundle)', (tmpRoot.Text.indexOf('FacetingDemo-Application-Container') >= 0) && (tmpRoot.Text.indexOf(BUNDLE) >= 0));
		let tmpBundle = await call('GET', `/${BUNDLE}`);
		checkEqual(`/${BUNDLE} answers 200`, tmpBundle.Status, 200);
		check(`/${BUNDLE} is non-empty JavaScript`, (tmpBundle.Bytes > 1000) && /javascript/.test(tmpBundle.Headers['content-type'] || ''), { Bytes: tmpBundle.Bytes, Type: tmpBundle.Headers['content-type'] });
		let tmpCSS = await call('GET', '/faceting-demo.css');
		checkEqual('/faceting-demo.css answers 200', tmpCSS.Status, 200);
		let tmpMissing = await call('GET', '/no-such-file.js');
		checkEqual('a missing file answers 404', tmpMissing.Status, 404);
	}
	let tmpEscape = await call('GET', '/%2e%2e/package.json');
	check('an encoded ../ cannot leave dist/', (tmpEscape.Status !== 200) || (tmpEscape.Text.indexOf('"retold-faceting-service-example-faceting-demo"') < 0), tmpEscape.Status);
	let tmpEscape2 = await call('GET', '/..%2fpackage.json');
	check('an encoded ..%2f cannot leave dist/', (tmpEscape2.Status !== 200) || (tmpEscape2.Text.indexOf('"retold-faceting-service-example-faceting-demo"') < 0), tmpEscape2.Status);
	let tmpFavicon = await call('GET', '/favicon.ico');
	check('/favicon.ico does not 404 (clean browser console)', (tmpFavicon.Status === 200) || (tmpFavicon.Status === 204), tmpFavicon.Status);
};

const checkDemoEndpoints = async () =>
{
	section('2. demo endpoints');
	let tmpPrincipals = await call('GET', '/api/Demo/Principals');
	checkEqual('/api/Demo/Principals answers 200', tmpPrincipals.Status, 200);
	let tmpList = tmpPrincipals.Body || {};
	checkEqual('five personas', (tmpList.Personas || []).map((pPersona) => { return pPersona.Key; }), [ 'user42', 'user43', 'user44', 'user81', 'anonymous' ]);
	checkEqual('header name', tmpList.Header, 'X-Retold-Facet-Demo-Principal');
	checkEqual('default persona', tmpList.Default, 'user42');
	check('every persona has a note per domain', (tmpList.Personas || []).every((pPersona) => { return pPersona.Domains && pPersona.Domains.ProjectTrack && pPersona.Domains.LabTrack && pPersona.Domains.Bookstore; }));
	check('a DEMO warning is served', (typeof(tmpList.Warning) === 'string') && (tmpList.Warning.indexOf('DEMO') >= 0));

	let tmpStatus = await call('GET', '/api/Demo/Status');
	checkEqual('/api/Demo/Status answers 200', tmpStatus.Status, 200);
	let tmpBody = tmpStatus.Body || {};
	checkEqual('three domains', Object.keys(tmpBody.Domains || {}), [ 'ProjectTrack', 'LabTrack', 'Bookstore' ]);
	checkEqual('provider / scale', [ tmpBody.Provider, tmpBody.Scale ], [ _Provider, 'Small' ]);
	Object.keys(EXPECTED_DEFINITIONS).forEach(
		(pDomain) =>
		{
			let tmpDomain = (tmpBody.Domains || {})[pDomain] || {};
			let tmpDefinitions = tmpDomain.Definitions || {};
			checkEqual(`${pDomain} definitions load clean`, { Facets: tmpDefinitions.Facets, Scopes: tmpDefinitions.Scopes, Disabled: tmpDefinitions.Disabled, Warnings: tmpDefinitions.Warnings }, EXPECTED_DEFINITIONS[pDomain]);
			check(`${pDomain} lists entities and live counts`, Array.isArray(tmpDomain.Entities) && (tmpDomain.Entities.length > 0) && (Object.keys(tmpDomain.LiveCounts || {}).length > 0));
			checkEqual(`${pDomain} tenants renumbered to 7, 8`, tmpDomain.Tenants, [ 7, 8 ]);
			let tmpExpectedUsers = libPersonas.RENUMBER[pDomain].Users;
			checkEqual(`${pDomain} users renumbered as design 08 (Small)`, tmpDomain.Renumbered ? tmpDomain.Renumbered.Users : null, JSON.parse(JSON.stringify(tmpExpectedUsers)));
			checkEqual(`${pDomain} nothing relocated (Small)`, tmpDomain.Renumbered ? tmpDomain.Renumbered.Relocated : null, {});
			check(`${pDomain} Status does not leak the upstream address`, JSON.stringify(tmpDomain).indexOf('127.0.0.1') < 0);
		});
	checkEqual('Book live rows of tenant 7', (((tmpBody.Domains || {}).Bookstore || {}).TenantLiveCounts || {})['7'] ? tmpBody.Domains.Bookstore.TenantLiveCounts['7'].Book : null, 1436);
};

const checkDescribe = async () =>
{
	section('3. Describe as user42');
	let fEntity = (pDescribe, pEntity) => { return (pDescribe && pDescribe.Entities) ? pDescribe.Entities[pEntity] : null; };
	let fScope = (pEntity, pScope) => { return (pEntity && Array.isArray(pEntity.Scopes)) ? pEntity.Scopes.find((pCandidate) => { return pCandidate.Scope === pScope; }) : null; };
	let fFacet = (pEntity, pFacet) => { return (pEntity && Array.isArray(pEntity.Facets)) ? pEntity.Facets.find((pCandidate) => { return pCandidate.Facet === pFacet; }) : null; };

	let tmpProjectTrack = await call('GET', '/api/ProjectTrack/1.0/Facet/Describe', null, { Persona: 'user42' });
	checkEqual('ProjectTrack Describe 200', tmpProjectTrack.Status, 200);
	let tmpProject = fEntity(tmpProjectTrack.Body, 'Project');
	let tmpMyProjects = fScope(tmpProject, 'Project.MyProjects');
	check('Project.MyProjects has an EnumList Roles param', !!tmpMyProjects && !!tmpMyProjects.Params && !!tmpMyProjects.Params.Roles && (tmpMyProjects.Params.Roles.Type === 'EnumList'), tmpMyProjects);
	[ 'Project.HasMyOverdue', 'Project.Unblocked', 'Project.ManyOverdue' ].forEach((pScope) => { check(`Project scope ${pScope}`, !!fScope(tmpProject, pScope)); });
	check('proxied answers Vary on the DEMO header', (tmpProjectTrack.Headers.vary || '').indexOf(libPersonas.HEADER) >= 0, tmpProjectTrack.Headers.vary);
	check('no x-facet-test-* header comes back', Object.keys(tmpProjectTrack.Headers).every((pHeader) => { return pHeader.indexOf('x-facet-test-') !== 0; }));
	check('Project.MyOverdueBand is declared', !!fFacet(tmpProject, 'Project.MyOverdueBand') && (fFacet(tmpProject, 'Project.MyOverdueBand').Declared === true));
	check('Describe answers carry the proxy headers', (tmpProjectTrack.Headers['x-retold-facet-demo-upstream'] === 'GET /1.0/Facet/Describe') && (tmpProjectTrack.Headers['x-retold-facet-demo-session'] === 'tenant=7; user=42') && /^upstream;dur=\d+(\.\d)?$/.test(tmpProjectTrack.Headers['server-timing'] || ''), tmpProjectTrack.Headers);

	let tmpBookstore = await call('GET', '/api/Bookstore/1.0/Facet/Describe', null, { Persona: 'user42' });
	checkEqual('Bookstore Describe 200', tmpBookstore.Status, 200);
	let tmpBook = fEntity(tmpBookstore.Body, 'Book');
	check('Book scope Book.WellReviewed', !!fScope(tmpBook, 'Book.WellReviewed'));
	let tmpRating = fFacet(tmpBook, 'Book.ReviewRating');
	check('Book.ReviewRating declared, MultiValued', !!tmpRating && (tmpRating.Declared === true) && (tmpRating.MultiValued === true), tmpRating);
	check('Book.ReviewCount declared', !!fFacet(tmpBook, 'Book.ReviewCount') && (fFacet(tmpBook, 'Book.ReviewCount').Declared === true));
	check('Book.HasFiveStar declared', !!fFacet(tmpBook, 'Book.HasFiveStar') && (fFacet(tmpBook, 'Book.HasFiveStar').Declared === true));
	// The Bookstore page builds its facet list from this Describe answer, exactly as the browser does.
	_BooksDescribed = libPages.describedFacets(libPages.Groups.Books, tmpBook);
	checkEqual('Books facets derived from Describe', _BooksDescribed.Facets.map((pSpec) => { return `${pSpec.Key}=${pSpec.Facet}`; }), [ 'Genre=Book.Genre', 'Language=Book.Language', 'Type=Book.Type', 'Year=Book.PublicationYear', 'ReviewRating=Book.ReviewRating', 'ReviewCount=Book.ReviewCount', 'HasFiveStar=Book.HasFiveStar' ]);
	checkEqual('Books cards derived from Describe', _BooksDescribed.Panels.map((pPanel) => { return `${pPanel.Region}:${pPanel.Widget}:${pPanel.Display || ''}`; }), [ 'Rail:Terms:Checklist', 'Rail:Terms:Chips', 'Rail:Terms:Chips', 'Main:Histogram:', 'Rail:Terms:Bars', 'Rail:Terms:Bars', 'Rail:Terms:Split' ]);
	checkEqual('Books: what Describe offers but the page does not draw', _BooksDescribed.Skipped.map((pSkipped) => { return pSkipped.Facet; }).sort(), [ 'Book.CreateDate', 'Book.ISBN', 'Book.UpdateDate' ]);
	check('Books Year keeps the Edges override', JSON.stringify((_BooksDescribed.Facets.find((pSpec) => { return pSpec.Key === 'Year'; }) || {}).Edges) === JSON.stringify([ 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030 ]));
	console.log(`    Books from Describe: ${_BooksDescribed.Facets.map((pSpec) => { return pSpec.Key; }).join(', ')} (skipped ${_BooksDescribed.Skipped.map((pSkipped) => { return pSkipped.Title; }).join(', ')})`);

	let tmpLabTrack = await call('GET', '/api/LabTrack/1.0/Facet/Describe', null, { Persona: 'user42' });
	checkEqual('LabTrack Describe 200', tmpLabTrack.Status, 200);
	let tmpRequirement = fEntity(tmpLabTrack.Body, 'MaterialIntakeRequirement');
	let tmpToDo = fScope(tmpRequirement, 'MaterialIntakeRequirement.ToDoForMe');
	check('MaterialIntakeRequirement.ToDoForMe is Relaxed', !!tmpToDo && (tmpToDo.Relaxed === true), tmpToDo);
	check('MaterialIntake.FormsToDo declared (variant B)', !!fFacet(fEntity(tmpLabTrack.Body, 'MaterialIntake'), 'MaterialIntake.FormsToDo'));

	let tmpAnonymous = await call('GET', '/api/ProjectTrack/1.0/Facet/Describe', null, { Persona: 'anonymous' });
	checkEqual('Describe as anonymous: 401 FACET_UNAUTHENTICATED', [ tmpAnonymous.Status, (tmpAnonymous.Body && tmpAnonymous.Body.Error) ? tmpAnonymous.Body.Error.Code : null ], [ 401, 'FACET_UNAUTHENTICATED' ]);
};

/**
 * @return {Promise<Record<string, Record<string, any>>>} the user42 initial responses by group
 */
const checkInitialTotals = async () =>
{
	section('4. initial totals, every group x every persona');
	let tmpUser42 = {};
	let tmpPersonas = Object.keys(libPages.EXPECTED_INITIAL_TOTALS);
	let tmpGroups = Object.keys(libPages.Groups);
	for (let p = 0; p < tmpPersonas.length; p++)
	{
		let tmpPersona = tmpPersonas[p];
		let tmpPersonaRow = libPersonas.personaFor(tmpPersona);
		let tmpLine = [];
		for (let g = 0; g < tmpGroups.length; g++)
		{
			let tmpGroup = tmpGroups[g];
			let tmpResponse = await query(groupState(tmpGroup), tmpPersona);
			if (!checkEqual(`${tmpPersona} ${tmpGroup}: status`, tmpResponse.Status, 200))
			{
				tmpLine.push(`${tmpGroup} ${tmpResponse.Status}`);
				continue;
			}
			let tmpTotal = totalOf(tmpGroup, tmpResponse.Body);
			checkEqual(`${tmpPersona} ${tmpGroup}: total`, tmpTotal, libPages.EXPECTED_INITIAL_TOTALS[tmpPersona][tmpGroup]);
			checkEqual(`${tmpPersona} ${tmpGroup}: no facet errors`, Object.keys(tmpResponse.Body.Errors || {}), []);
			checkEqual(`${tmpPersona} ${tmpGroup}: session header`, tmpResponse.Headers['x-retold-facet-demo-session'], `tenant=${tmpPersonaRow.Tenant}; user=${tmpPersonaRow.User}`);
			check(`${tmpPersona} ${tmpGroup}: ETag`, /^W\/"fv1:/.test(tmpResponse.Headers.etag || ''), tmpResponse.Headers.etag);
			tmpLine.push(`${tmpGroup} ${tmpTotal}`);
			if (tmpPersona === 'user42')
			{
				tmpUser42[tmpGroup] = tmpResponse;
			}
		}
		console.log(`    ${tmpPersona}: ${tmpLine.join(' · ')}`);
	}
	for (let g = 0; g < tmpGroups.length; g++)
	{
		let tmpResponse = await query(groupState(tmpGroups[g]), 'anonymous');
		checkEqual(`anonymous ${tmpGroups[g]}: 401`, tmpResponse.Status, 401);
		checkEqual(`anonymous ${tmpGroups[g]}: FACET_UNAUTHENTICATED`, (tmpResponse.Body && tmpResponse.Body.Error) ? tmpResponse.Body.Error.Code : null, 'FACET_UNAUTHENTICATED');
		checkEqual(`anonymous ${tmpGroups[g]}: session header`, tmpResponse.Headers['x-retold-facet-demo-session'], 'anonymous');
	}
	let tmpUnknown = await query(groupState('Projects'), 'nobody-such');
	checkEqual('an unknown persona key forwards no session (401)', tmpUnknown.Status, 401);
	let tmpNoHeader = await call('POST', browserPath(groupState('Books'), 'Query'), libSelection.buildQueryBody(groupState('Books')));
	checkEqual('no DEMO header forwards no session (401)', tmpNoHeader.Status, 401);
	console.log('    anonymous: 401 FACET_UNAUTHENTICATED on every group');
	return tmpUser42;
};

const checkNotModified = async (pUser42) =>
{
	section('5. If-None-Match');
	let tmpFirst = pUser42.Projects;
	let tmpETag = tmpFirst ? tmpFirst.Headers.etag : null;
	let tmpAgain = await query(groupState('Projects'), 'user42', { 'If-None-Match': tmpETag });
	checkEqual('the same Query with If-None-Match: <etag> answers 304', tmpAgain.Status, 304);
	checkEqual('the 304 carries no body', tmpAgain.Bytes, 0);
	checkEqual('the 304 repeats the ETag', tmpAgain.Headers.etag, tmpETag);
	let tmpOther = await query(groupState('Projects'), 'user81', { 'If-None-Match': tmpETag });
	checkEqual('the same ETag as another principal answers 200 (never cross-principal)', tmpOther.Status, 200);
	let tmpDescribe = await call('GET', '/api/Bookstore/1.0/Facet/Describe', null, { Persona: 'user42' });
	if (tmpDescribe.Headers.etag)
	{
		let tmpDescribeAgain = await call('GET', '/api/Bookstore/1.0/Facet/Describe', null, { Persona: 'user42', Headers: { 'If-None-Match': tmpDescribe.Headers.etag } });
		checkEqual('Describe revalidates (304)', tmpDescribeAgain.Status, 304);
	}
	console.log(`    Projects ${tmpETag} -> 304; user81 with that ETag -> ${tmpOther.Status}`);
};

const checkRecords = async (pUser42) =>
{
	section('6. Records agree with the envelope Total');
	let tmpPersonas = [ 'user42', 'user43', 'user81' ];
	for (let p = 0; p < tmpPersonas.length; p++)
	{
		for (let g = 0; g < LIST_GROUPS.length; g++)
		{
			let tmpGroup = LIST_GROUPS[g];
			let tmpState = groupState(tmpGroup);
			let tmpQuery = (tmpPersonas[p] === 'user42') ? pUser42[tmpGroup] : await query(tmpState, tmpPersonas[p]);
			let tmpTotal = (tmpQuery && tmpQuery.Body) ? tmpQuery.Body.Total : null;
			let tmpCount = await recordsCount(tmpState, tmpPersonas[p]);
			checkEqual(`${tmpPersonas[p]} ${tmpGroup}: Records/Count status`, tmpCount.Status, 200);
			checkEqual(`${tmpPersonas[p]} ${tmpGroup}: Records/Count == Total`, tmpCount.Body ? tmpCount.Body.Count : null, tmpTotal);
			let tmpEnvelopeRecords = (tmpQuery && tmpQuery.Body && Array.isArray(tmpQuery.Body.Records)) ? tmpQuery.Body.Records.length : null;
			checkEqual(`${tmpPersonas[p]} ${tmpGroup}: envelope Records == min(Cap, Total)`, tmpEnvelopeRecords, Math.min(25, tmpTotal));
			if (tmpPersonas[p] === 'user42')
			{
				let tmpPage = await call('POST', browserPath(tmpState, 'Records', 25, 25), libSelection.buildRecordsBody(tmpState), { Persona: 'user42' });
				checkEqual(`user42 ${tmpGroup}: Records/25/25 status`, tmpPage.Status, 200);
				checkEqual(`user42 ${tmpGroup}: Records/25/25 rows`, Array.isArray(tmpPage.Body) ? tmpPage.Body.length : null, Math.max(0, Math.min(25, tmpTotal - 25)));
				// Page 2 must not repeat page 1 (the sort is total: the Records sort adds the PK tiebreak).
				if (Array.isArray(tmpPage.Body) && (tmpPage.Body.length > 0) && tmpQuery.Body && Array.isArray(tmpQuery.Body.Records))
				{
					let tmpEntity = tmpState.Entity;
					let tmpIDField = `ID${tmpEntity}`;
					let tmpFirstIDs = tmpQuery.Body.Records.map((pRecord) => { return pRecord[tmpIDField]; });
					check(`user42 ${tmpGroup}: page 2 does not repeat page 1`, tmpPage.Body.every((pRecord) => { return tmpFirstIDs.indexOf(pRecord[tmpIDField]) < 0; }));
				}
				console.log(`    user42 ${tmpGroup}: Total ${tmpTotal} == Records/Count ${tmpCount.Body ? tmpCount.Body.Count : '?'}; page 2: ${Array.isArray(tmpPage.Body) ? tmpPage.Body.length : '?'} rows`);
			}
		}
	}
	console.log('    user43, user81: Records/Count == Total on every list group');
};

const checkWriteBack = async (pUser42) =>
{
	section('7. write-back round trips (user42)');
	// Projects: Status toggle OnHold (disjunctive: the Status card's own counts stay)
	let tmpProjects = pUser42.Projects.Body;
	let tmpState = groupState('Projects');
	let tmpOnHold = bucketIndex(tmpProjects.Facets.Status, 'OnHold');
	check('Projects Status has an OnHold bucket', tmpOnHold >= 0);
	let tmpEnvelope = await roundTrip('Projects + OnHold', tmpState, { Status: libSelection.toggleTermsKey(tmpProjects.Facets.Status, tmpState.Selections.Status, tmpOnHold) }, 'user42', 7);
	if (tmpEnvelope)
	{
		checkEqual('Projects + OnHold: Status counts unchanged (disjunctive)', tmpEnvelope.Facets.Status.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }), tmpProjects.Facets.Status.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }));
		checkEqual('Projects + OnHold: Status Excluded names the selection', tmpEnvelope.Facets.Status.Excluded, [ 'Projects-Status' ]);
		checkEqual('Projects + OnHold: OnHold bucket Selected', tmpEnvelope.Facets.Status.Buckets[bucketIndex(tmpEnvelope.Facets.Status, 'OnHold')].Selected, true);
	}

	// Projects: drag Started buckets 2..7 (Feb-Jul 2026)
	tmpState = groupState('Projects');
	let tmpStarted = tmpProjects.Facets.Started;
	let tmpRange = libSelection.rangeClause(tmpStarted, 2, 7);
	check('Projects Started rangeClause(2, 7) is a DateRange', !!tmpRange && (tmpRange.Type === 'DateRange'), tmpRange);
	tmpEnvelope = await roundTrip('Projects Started drag 2..7', tmpState, { Started: tmpRange }, 'user42', null);
	if (tmpEnvelope)
	{
		let tmpExpectedKeys = tmpStarted.Buckets.slice(2, 8).map((pBucket) => { return pBucket.Key; });
		let tmpSelectedKeys = tmpEnvelope.Facets.Started.Buckets.filter((pBucket) => { return pBucket.Selected; }).map((pBucket) => { return pBucket.Key; });
		checkEqual('Projects Started drag 2..7: exactly those buckets come back Selected', tmpSelectedKeys, tmpExpectedKeys);
		checkEqual('Projects Started drag 2..7: they are Feb-Jul 2026', tmpEnvelope.Facets.Started.Buckets.filter((pBucket) => { return pBucket.Selected; }).map((pBucket) => { return pBucket.Label; }), [ 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026' ]);
	}

	// Projects: a single month bar == that bar's count when nothing else is selected but the scopes
	tmpState = groupState('Projects');
	let tmpBarIndex = tmpStarted.Buckets.findIndex((pBucket) => { return pBucket.Count > 0; });
	if (tmpBarIndex >= 0)
	{
		tmpState.Selections = {};
		let tmpBare = await query(tmpState, 'user42');
		let tmpBareStarted = tmpBare.Body.Facets.Started;
		let tmpBareIndex = tmpBareStarted.Buckets.findIndex((pBucket) => { return pBucket.Count > 0; });
		await roundTrip('Projects (scopes only) + one Started bar', tmpState, { Started: libSelection.rangeClause(tmpBareStarted, tmpBareIndex, tmpBareIndex) }, 'user42', tmpBareStarted.Buckets[tmpBareIndex].Count);
	}

	// Projects: pivot cell Active x Iris Media (9)
	tmpState = groupState('Projects');
	let tmpPivot = libSelection.pivotCellSelections(tmpProjects, 'Status', 'Client', 'Active', 9);
	check('Projects pivot cell (Active, 9) has clauses for both facets', !!tmpPivot && !!tmpPivot.Status && !!tmpPivot.Client, tmpPivot);
	let tmpCell = (tmpProjects.Facets.StatusByClient.Cells || []).find((pCell) => { return libSelection.sameKey(pCell.K1, 'Active') && libSelection.sameKey(pCell.K2, 9); });
	tmpEnvelope = await roundTrip('Projects pivot (Active, Iris Media)', tmpState, tmpPivot || {}, 'user42', 2);
	if (tmpEnvelope && tmpCell)
	{
		checkEqual('Projects pivot (Active, Iris Media): Total == the cell count', tmpEnvelope.Total, tmpCell.Count);
	}

	// Documents: add Form G to Form D (disjunctive: every form's count stays)
	let tmpDocuments = pUser42.Documents.Body;
	tmpState = groupState('Documents');
	let tmpFormG = bucketIndex(tmpDocuments.Facets.ByForm, 'Form G');
	check('Documents ByForm has a Form G bucket', tmpFormG >= 0);
	let tmpFormGCount = (tmpFormG >= 0) ? tmpDocuments.Facets.ByForm.Buckets[tmpFormG].Count : null;
	tmpEnvelope = await roundTrip('Documents + Form G', tmpState, { ByForm: libSelection.toggleTermsKey(tmpDocuments.Facets.ByForm, tmpState.Selections.ByForm, tmpFormG) }, 'user42', 41 + tmpFormGCount);
	if (tmpEnvelope)
	{
		checkEqual('Documents + Form G: ByForm counts unchanged (disjunctive)', tmpEnvelope.Facets.ByForm.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }), tmpDocuments.Facets.ByForm.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }));
	}

	// LabFormsA: Lab Form H alone (41), Physics alone (84), weeks 0..4 + Physics (8)
	let tmpLabA = pUser42.LabFormsA.Body;
	let tmpFormH = bucketIndex(tmpLabA.Facets.ToDo, 'Lab Form H');
	check('LabFormsA ToDo has a Lab Form H bucket', tmpFormH >= 0);
	tmpState = groupState('LabFormsA');
	await roundTrip('LabFormsA Lab Form H', tmpState, { ToDo: libSelection.toggleTermsKey(tmpLabA.Facets.ToDo, null, tmpFormH) }, 'user42', (tmpFormH >= 0) ? tmpLabA.Facets.ToDo.Buckets[tmpFormH].Count : null);
	tmpState = groupState('LabFormsA');
	checkEqual('LabFormsA Discipline bucket 0 is Physics', tmpLabA.Facets.Discipline.Buckets[0].Key, 'Physics');
	await roundTrip('LabFormsA Physics', tmpState, { Discipline: libSelection.toggleTermsKey(tmpLabA.Facets.Discipline, null, 0) }, 'user42', tmpLabA.Facets.Discipline.Buckets[0].Count);
	tmpState = groupState('LabFormsA');
	let tmpWeeks = libSelection.rangeClause(tmpLabA.Facets.Week, 0, 4);
	check('LabFormsA Week rangeClause(0, 4) is an InternalJoinDateRange', !!tmpWeeks && (tmpWeeks.Type === 'InternalJoinDateRange'), tmpWeeks);
	await roundTrip('LabFormsA weeks 0..4 + Physics', tmpState, { Week: tmpWeeks, Discipline: libSelection.toggleTermsKey(tmpLabA.Facets.Discipline, null, 0) }, 'user42', 8);

	// Books: Language '' + Year 2000-2019 (57); Year 2000-2019 + WellReviewed (614); WellReviewed alone (1250)
	let tmpBooks = pUser42.Books.Body;
	let tmpBlank = tmpBooks.Facets.Language.Buckets.findIndex((pBucket) => { return pBucket.Key === ''; });
	check('Books Language has a \'\' bucket', tmpBlank >= 0);
	tmpState = groupState('Books');
	let tmpYears = libSelection.rangeClause(tmpBooks.Facets.Year, 5, 6);
	check('Books Year rangeClause(5, 6) is a NumericRange 2000-2020', !!tmpYears && (tmpYears.Type === 'NumericRange'), tmpYears);
	await roundTrip('Books Language \'\' + Year 2000-2019', tmpState, { Language: libSelection.toggleTermsKey(tmpBooks.Facets.Language, null, tmpBlank), Year: tmpYears }, 'user42', 57);
	tmpState = groupState('Books');
	tmpState.ScopeState['Book.WellReviewed'].On = true;
	await roundTrip('Books WellReviewed', tmpState, {}, 'user42', 1250);
	tmpState = groupState('Books');
	tmpState.ScopeState['Book.WellReviewed'].On = true;
	await roundTrip('Books WellReviewed + Year 2000-2019', tmpState, { Year: tmpYears }, 'user42', 614);

	// Projects: OnHold, then drag Feb-Jul (the DEMO-SPEC §9 sequence) -> 5
	tmpState = groupState('Projects');
	tmpState.Selections.Status = libSelection.toggleTermsKey(tmpProjects.Facets.Status, tmpState.Selections.Status, tmpOnHold);
	await roundTrip('Projects + OnHold + Started drag 2..7', tmpState, { Started: libSelection.rangeClause(tmpStarted, 2, 7) }, 'user42', 5);

	// Projects user43: the initial state is empty (Owner / Lead only).  Adding Member is not enough while
	// "Has my overdue tasks" is on (user43 has none on those projects); Member + that scope off -> 2.
	tmpState = groupState('Projects');
	tmpState.ScopeState['Project.MyProjects'].Params.Roles = [ 'Owner', 'Lead', 'Member' ];
	let tmpMember = await query(tmpState, 'user43');
	checkEqual('user43 Projects + Member (HasMyOverdue still on): 0', (tmpMember.Status === 200) ? tmpMember.Body.Total : tmpMember.Status, 0);
	tmpState.ScopeState['Project.HasMyOverdue'].On = false;
	await roundTrip('user43 Projects + Member, HasMyOverdue off', tmpState, {}, 'user43', 2);
	tmpState = groupState('Projects');
	tmpState.ScopeState['Project.MyProjects'].Params.Roles = [];
	let tmpNoRoles = await query(tmpState, 'user42');
	checkEqual('Projects with no Roles: 400 FACET_PARAM_INVALID on Roles', [ tmpNoRoles.Status, (tmpNoRoles.Body && tmpNoRoles.Body.Error) ? tmpNoRoles.Body.Error.Code : null, (tmpNoRoles.Body && tmpNoRoles.Body.Error && tmpNoRoles.Body.Error.Detail) ? tmpNoRoles.Body.Error.Detail.Param : null ], [ 400, 'FACET_PARAM_INVALID', 'Roles' ]);
	console.log(`    no roles: ${tmpNoRoles.Status}${(tmpNoRoles.Body && tmpNoRoles.Body.Error) ? ` ${tmpNoRoles.Body.Error.Code} ${JSON.stringify(tmpNoRoles.Body.Error.Detail || {})}` : ''}`);
};

const checkForgedHeaders = async () =>
{
	section('8. forged session headers');
	let tmpForged = { 'x-facet-test-tenant': '7', 'x-facet-test-user': '42' };
	let tmpAnonymous = await query(groupState('Books'), 'anonymous', tmpForged);
	checkEqual('anonymous + x-facet-test-tenant: 7 -> still 401', tmpAnonymous.Status, 401);
	let tmpUser81 = await query(groupState('Books'), 'user81', tmpForged);
	checkEqual('user81 + forged tenant 7 -> tenant 8\'s 81 books', tmpUser81.Body ? tmpUser81.Body.Total : null, 81);
	let tmpNone = await query(groupState('Projects'), undefined, tmpForged);
	checkEqual('no DEMO header + forged headers -> 401', tmpNone.Status, 401);
};

const checkIntervalError = async () =>
{
	section('9. per-facet error: Documents ByMonth interval day');
	let tmpState = groupState('Documents');
	tmpState.Facets.forEach((pSpec) => { if (pSpec.Key === 'ByMonth') { pSpec.Interval = 'day'; } });
	let tmpResponse = await query(tmpState, 'user42');
	checkEqual('Documents interval day: 200 (the envelope survives)', tmpResponse.Status, 200);
	let tmpError = (tmpResponse.Body && tmpResponse.Body.Errors) ? tmpResponse.Body.Errors.ByMonth : null;
	checkEqual('Errors.ByMonth.Code', tmpError ? tmpError.Code : null, 'FACET_INTERVAL_TOO_FINE');
	checkEqual('Errors.ByMonth.Detail.Suggest.Interval', (tmpError && tmpError.Detail && tmpError.Detail.Suggest) ? tmpError.Detail.Suggest.Interval : null, 'week');
	check('the other facets still answer', !!(tmpResponse.Body && tmpResponse.Body.Facets && tmpResponse.Body.Facets.ByForm && tmpResponse.Body.Facets.Status));
	console.log(`    ${tmpError ? `${tmpError.Code} ${tmpError.Status}: suggest ${tmpError.Detail && tmpError.Detail.Suggest ? tmpError.Detail.Suggest.Interval : '?'}` : 'no error'}`);
};

const checkLoopbackGuard = async () =>
{
	section('10. domain servers are private (loopback bind + guard before listen)');
	Object.keys(_Demo.Domains).forEach(
		(pDomain) =>
		{
			let tmpHarness = _Demo.Domains[pDomain];
			let tmpGuard = tmpHarness.DemoLoopbackGuard;
			check(`${pDomain} guard installed`, !!tmpGuard && (tmpGuard.Installed === true));
			check(`${pDomain} listens on 127.0.0.1 only`, libServer.Domains.isBoundToLoopback(tmpHarness), tmpHarness.fable.OratorServiceServer.server.address());
		});
	// From a LAN address the domain server is not even reachable (bound to loopback); if it were, the guard
	// (installed before listen) would answer 403 DEMO_LOOPBACK_ONLY.
	let tmpAddress = null;
	let tmpInterfaces = libOS.networkInterfaces();
	Object.keys(tmpInterfaces).forEach(
		(pName) =>
		{
			(tmpInterfaces[pName] || []).forEach(
				(pEntry) =>
				{
					if (!tmpAddress && (pEntry.family === 'IPv4') && !pEntry.internal)
					{
						tmpAddress = pEntry.address;
					}
				});
		});
	if (!tmpAddress)
	{
		_Skipped.push('domain server over a LAN address: this machine has no non-internal IPv4 address');
		console.log('    skipped: no non-internal IPv4 address to probe from');
		return;
	}
	let tmpHarness = _Demo.Domains.Bookstore;
	let tmpOutcome = null;
	try
	{
		let tmpResponse = await rawCall({ host: tmpAddress, port: tmpHarness.port, path: '/1.0/Facet/Describe', headers: { 'x-facet-test-tenant': '7', 'x-facet-test-user': '42' } });
		tmpOutcome = `${tmpResponse.Status} ${(tmpResponse.Body && tmpResponse.Body.Error) ? tmpResponse.Body.Error.Code : ''}`.trim();
		checkEqual(`a direct request from ${tmpAddress} never gets a facet answer`, [ tmpResponse.Status, (tmpResponse.Body && tmpResponse.Body.Error) ? tmpResponse.Body.Error.Code : null ], [ 403, 'DEMO_LOOPBACK_ONLY' ]);
	}
	catch (pError)
	{
		tmpOutcome = pError.code || pError.message;
		check(`a direct request from ${tmpAddress} is refused (not listening there)`, (pError.code === 'ECONNREFUSED') || (pError.code === 'EADDRNOTAVAIL') || (pError.message === 'timeout'), pError.code || pError.message);
	}
	console.log(`    ${tmpAddress}:${tmpHarness.port} -> ${tmpOutcome}`);
};

/**
 * Every list row of a group state (pages of 500), as the provider's fetchAllRecords reads them.
 */
const allRows = async (pState, pPersona) =>
{
	let tmpRows = [];
	for (let tmpBegin = 0; tmpBegin <= 10000; tmpBegin += libLookup.PAGE_SIZE)
	{
		let tmpPage = await call('POST', browserPath(pState, 'Records', tmpBegin, libLookup.PAGE_SIZE), libSelection.buildRecordsBody(pState), { Persona: pPersona });
		if ((tmpPage.Status !== 200) || !Array.isArray(tmpPage.Body))
		{
			throw new Error(`Records ${tmpBegin}: ${tmpPage.Status}`);
		}
		tmpRows = tmpRows.concat(tmpPage.Body);
		if (tmpPage.Body.length < libLookup.PAGE_SIZE)
		{
			break;
		}
	}
	return tmpRows;
};

/**
 * A lookup through the faceting Records route of a related entity, as the provider's fetchLookup sends it;
 * returns Facet-Lookup.indexRows of the answer.
 */
const lookup = async (pDomain, pEntity, pKeyField, pKeys, pPersona) =>
{
	let tmpIndex = {};
	let tmpChunks = libLookup.chunk(pKeys, libLookup.KEYS_PER_REQUEST);
	for (let i = 0; i < tmpChunks.length; i++)
	{
		let tmpRows = [];
		for (let tmpBegin = 0; tmpBegin <= 10000; tmpBegin += libLookup.PAGE_SIZE)
		{
			let tmpPage = await call('POST', `/api/${pDomain}/1.0/Facet/${pEntity}/Records/${tmpBegin}/${libLookup.PAGE_SIZE}`, libLookup.requestBody(pKeyField, tmpChunks[i]), { Persona: pPersona });
			if ((tmpPage.Status !== 200) || !Array.isArray(tmpPage.Body))
			{
				throw new Error(`lookup ${pEntity}: ${tmpPage.Status}`);
			}
			tmpRows = tmpRows.concat(tmpPage.Body);
			if (tmpPage.Body.length < libLookup.PAGE_SIZE)
			{
				break;
			}
		}
		Object.assign(tmpIndex, libLookup.indexRows(tmpRows, pKeyField, tmpChunks[i]));
	}
	return tmpIndex;
};

const checkClientLogic = async () =>
{
	section('11. the client display logic against real answers');
	// The Query body always asks for page 1 (a refresh never carries the list's paging cursor).
	let tmpPaged = groupState('Documents');
	tmpPaged.Records.Begin = 25;
	checkEqual('buildQueryBody asks for page 1 whatever the state says', libSelection.buildQueryBody(tmpPaged).Records.Begin, 0);

	// The readout and filter chips say the clause span the way the axis does (inclusive end).
	checkEqual('rangeText: the Projects initial Started clause', libDisplay.rangeText(libPages.Groups.Projects.InitialSelections.Started.Values, true), '2026');
	checkEqual('rangeText: the Documents initial month range', libDisplay.rangeText(libPages.Groups.Documents.InitialSelections.ByMonth.Values, true), 'Jan – Jun 2026');
	checkEqual('rangeText: a week span', libDisplay.rangeText({ Start: '2026-01-05 00:00:00', End: '2026-02-02 00:00:00' }, true), 'Jan 5 – Feb 1, 2026');
	checkEqual('rangeText: decades 2000-2019', libDisplay.rangeText({ Start: 2000, End: 2020 }, true), '2000–2019');
	checkEqual('tickText: the year shows on the first tick and where it changes', [ [ 'week', '2025-12-29 00:00:00', null ], [ 'week', '2026-01-05 00:00:00', '2025-12-29 00:00:00' ], [ 'week', '2026-01-12 00:00:00', '2026-01-05 00:00:00' ], [ 'month', '2026-03-01 00:00:00', '2026-02-01 00:00:00' ] ].map((pCase) => { return libDisplay.tickText({ Fold: 'DateHistogram', Interval: pCase[0] }, { Start: pCase[1] }, pCase[2] ? { Start: pCase[2] } : null); }), [ 'Dec 29 ’25', 'Jan 5 ’26', 'Jan 12', 'Mar' ]);

	// Coverage: the client's Full buckets are exactly the server's Selected buckets; after an interval change
	// the edge buckets are Partial and the Total does not change.
	for (let tmpInterval of [ 'month', 'week', 'quarter', 'year' ])
	{
		let tmpState = groupState('Documents');
		tmpState.Facets.forEach((pSpec) => { if (pSpec.Key === 'ByMonth') { pSpec.Interval = tmpInterval; } });
		let tmpAnswer = await query(tmpState, 'user42');
		let tmpFacet = (tmpAnswer.Body && tmpAnswer.Body.Facets) ? tmpAnswer.Body.Facets.ByMonth : null;
		if (!check(`Documents ByMonth ${tmpInterval}: answered`, (tmpAnswer.Status === 200) && !!tmpFacet, tmpAnswer.Status))
		{
			continue;
		}
		let tmpRange = libSelection.rangeOf(tmpState.Selections.ByMonth);
		let tmpCoverage = tmpFacet.Buckets.map((pBucket) => { return libSelection.bucketCoverage(pBucket, tmpRange); });
		checkEqual(`Documents ByMonth ${tmpInterval}: client Full == server Selected`, tmpCoverage.map((pCoverage) => { return pCoverage === 'Full'; }), tmpFacet.Buckets.map((pBucket) => { return pBucket.Selected === true; }));
		checkEqual(`Documents ByMonth ${tmpInterval}: Total stays 41 (the filter did not change)`, tmpAnswer.Body.Total, 41);
		let tmpPartial = tmpCoverage.filter((pCoverage) => { return pCoverage === 'Partial'; }).length;
		let tmpExpectedPartial = { month: 0, week: 2, quarter: 0, year: 1 }[tmpInterval];
		checkEqual(`Documents ByMonth ${tmpInterval}: partial edge buckets`, tmpPartial, tmpExpectedPartial);
		console.log(`    Documents ${tmpInterval}: ${tmpCoverage.filter((pCoverage) => { return pCoverage === 'Full'; }).length} full, ${tmpPartial} partial bucket(s); Total ${tmpAnswer.Body.Total}`);
	}
	let tmpOne = libPages.Groups.Documents.InitialSelections.ByMonth;
	check('sameRange: a selection is its bucket\'s own clause', libSelection.sameRange(tmpOne, libSelection.cloneJSON(tmpOne)) && !libSelection.sameRange(tmpOne, Object.assign({}, tmpOne, { Values: { Start: '2026-01-01 00:00:00', End: '2026-02-01 00:00:00' } })));

	// The work list's lookups: every A row's Started (one of my LabForms for the intake + form, not Complete)
	// agrees with the Started facet, and every row resolves its intake, queue and form type.
	let tmpPage = libPages.Pages.find((pCandidate) => { return pCandidate.Hash === 'LabForms'; });
	let tmpColumns = tmpPage.Layout.A.Main.find((pPanel) => { return pPanel.Widget === 'Records'; }).Columns;
	let tmpStartedColumn = tmpColumns.find((pColumn) => { return pColumn.Label === 'Started'; });
	for (let tmpPersona of [ 'user42', 'user43', 'user81' ])
	{
		let tmpState = groupState('LabFormsA');
		let tmpRows = await allRows(tmpState, tmpPersona);
		let tmpIntakes = libLookup.keysOf(tmpRows, 'IDMaterialIntake');
		let tmpCache = {};
		tmpCache['LabForm|IDMaterialIntake'] = await lookup('LabTrack', 'LabForm', 'IDMaterialIntake', tmpIntakes, tmpPersona);
		tmpCache['MaterialIntake|IDMaterialIntake'] = await lookup('LabTrack', 'MaterialIntake', 'IDMaterialIntake', tmpIntakes, tmpPersona);
		let fRowsFor = (pEntity, pKeyField, pKey) => { let tmpMap = tmpCache[`${pEntity}|${pKeyField}`]; return tmpMap ? tmpMap[String(pKey)] : undefined; };
		let tmpStarted = tmpRows.filter((pRow) => { return libLookup.cellValue(tmpStartedColumn, pRow, fRowsFor, {}).Text === 'Started'; }).length;
		let tmpFacetAnswer = await query(tmpState, tmpPersona);
		let tmpStartedBucket = ((tmpFacetAnswer.Body && tmpFacetAnswer.Body.Facets && tmpFacetAnswer.Body.Facets.Started) ? tmpFacetAnswer.Body.Facets.Started.Buckets : []).find((pBucket) => { return libSelection.sameKey(pBucket.Key, 1); });
		checkEqual(`${tmpPersona} work list: the Started column == the Started facet`, tmpStarted, tmpStartedBucket ? tmpStartedBucket.Count : 0);
		checkEqual(`${tmpPersona} work list: every intake resolves`, tmpIntakes.filter((pKey) => { return (fRowsFor('MaterialIntake', 'IDMaterialIntake', pKey) || []).length !== 1; }).length, 0);

		// The variant A / B breakdown (FacetDemo-Compare): In both + Stored only == A; In both + Configured only == B.
		let tmpConfiguration = await lookup('LabTrack', 'MaterialTypeFormRequirement', 'Required', [ 1 ], tmpPersona);
		let tmpConfigured = {};
		(tmpConfiguration['1'] || []).forEach((pRequirement) => { tmpConfigured[`${pRequirement.IDMaterialType}|${pRequirement.IDLabFormType}`] = true; });
		let tmpAOnly = {};
		let tmpA = {};
		tmpRows.forEach(
			(pRow) =>
			{
				let tmpIntake = (fRowsFor('MaterialIntake', 'IDMaterialIntake', pRow.IDMaterialIntake) || [])[0];
				let tmpForm = String(pRow.IDLabFormType);
				tmpA[tmpForm] = (tmpA[tmpForm] || 0) + 1;
				if (!tmpConfigured[`${tmpIntake ? tmpIntake.IDMaterialType : null}|${pRow.IDLabFormType}`])
				{
					tmpAOnly[tmpForm] = (tmpAOnly[tmpForm] || 0) + 1;
				}
			});
		let tmpB = await query(groupState('LabFormsB'), tmpPersona);
		let tmpBCounts = {};
		((tmpB.Body && tmpB.Body.Facets && tmpB.Body.Facets.ToDo) ? tmpB.Body.Facets.ToDo.Buckets : []).forEach((pBucket) => { tmpBCounts[String(pBucket.Key)] = pBucket.Count; });
		let tmpForms = Object.keys(Object.assign({}, tmpA, tmpBCounts));
		let tmpNegative = tmpForms.filter((pForm) => { return ((tmpBCounts[pForm] || 0) - ((tmpA[pForm] || 0) - (tmpAOnly[pForm] || 0))) < 0; });
		checkEqual(`${tmpPersona} A/B: no form type has a negative "Configured only"`, tmpNegative, []);
		let tmpAOnlyTotal = Object.keys(tmpAOnly).reduce((pSum, pForm) => { return pSum + tmpAOnly[pForm]; }, 0);
		let tmpBothTotal = tmpRows.length - tmpAOnlyTotal;
		let tmpBTotal = tmpB.Body.Facets.ToDo.Total;
		check(`${tmpPersona} A/B: A − stored only == B − configured only`, (tmpBTotal - tmpBothTotal) >= 0, { A: tmpRows.length, AOnly: tmpAOnlyTotal, B: tmpBTotal });
		console.log(`    ${tmpPersona}: Started ${tmpStarted} == facet; A ${tmpRows.length} = ${tmpBothTotal} in both + ${tmpAOnlyTotal} stored only; B ${tmpBTotal} = ${tmpBothTotal} + ${tmpBTotal - tmpBothTotal} configured only`);
	}
};

const checkHostErrors = async () =>
{
	section('+ demo host errors');
	let fCode = (pResponse) => { return (pResponse.Body && pResponse.Body.Error) ? pResponse.Body.Error.Code : null; };
	let tmpUnknown = await call('GET', '/api/Nowhere/1.0/Facet/Describe', null, { Persona: 'user42' });
	checkEqual('unknown domain: 404 DEMO_UNKNOWN_DOMAIN', [ tmpUnknown.Status, fCode(tmpUnknown) ], [ 404, 'DEMO_UNKNOWN_DOMAIN' ]);
	let tmpRoute = await call('GET', '/api/ProjectTrack/1.0/Project', null, { Persona: 'user42' });
	checkEqual('a non-facet route: 404 DEMO_NOT_FOUND (the CRUD API is not exposed)', [ tmpRoute.Status, fCode(tmpRoute) ], [ 404, 'DEMO_NOT_FOUND' ]);
	let tmpDots = await call('GET', '/api/ProjectTrack/1.0/Facet/%2e%2e/%2e%2e/1.0/Project', null, { Persona: 'user42' });
	check('dot segments cannot walk out of /1.0/Facet/', (tmpDots.Status === 404) || (tmpDots.Status === 400), [ tmpDots.Status, fCode(tmpDots) ]);
	let tmpSlash = await call('GET', '/api/ProjectTrack/1.0/Facet/..%2f..%2f1.0%2fProject', null, { Persona: 'user42' });
	checkEqual('encoded slashes are refused: 400 DEMO_BAD_PATH', [ tmpSlash.Status, fCode(tmpSlash) ], [ 400, 'DEMO_BAD_PATH' ]);
	let tmpMethod = await call('DELETE', '/api/ProjectTrack/1.0/Facet/Project/Query', null, { Persona: 'user42' });
	checkEqual('DELETE: 405 DEMO_METHOD_NOT_ALLOWED', [ tmpMethod.Status, fCode(tmpMethod) ], [ 405, 'DEMO_METHOD_NOT_ALLOWED' ]);
	let tmpBig = await call('POST', '/api/Bookstore/1.0/Facet/Book/Query', JSON.stringify({ Pad: 'x'.repeat(300 * 1024) }), { Persona: 'user42' });
	checkEqual('a 300 KiB body: 413 DEMO_BODY_TOO_LARGE', [ tmpBig.Status, fCode(tmpBig) ], [ 413, 'DEMO_BODY_TOO_LARGE' ]);
	let tmpAPI = await call('GET', '/api/Somewhere', null, {});
	checkEqual('anything else under /api/: 404 DEMO_NOT_FOUND', [ tmpAPI.Status, fCode(tmpAPI) ], [ 404, 'DEMO_NOT_FOUND' ]);
	let tmpPost = await call('POST', '/api/Demo/Principals', {}, {});
	checkEqual('POST /api/Demo/Principals: 405', tmpPost.Status, 405);
	let tmpHost = await rawCall({ host: '127.0.0.1', port: SMOKE_PORT, path: '/api/Demo/Principals', headers: { 'Host': 'rebind.example:19301' } });
	checkEqual('a foreign Host header: 421 DEMO_HOST_NOT_ALLOWED', [ tmpHost.Status, (tmpHost.Body && tmpHost.Body.Error) ? tmpHost.Body.Error.Code : null ], [ 421, 'DEMO_HOST_NOT_ALLOWED' ]);
	let tmpLocalhost = await rawCall({ host: '127.0.0.1', port: SMOKE_PORT, path: '/api/Demo/Principals', headers: { 'Host': 'localhost:19301' } });
	checkEqual('Host localhost: 200', tmpLocalhost.Status, 200);
	let tmpShape = [ tmpUnknown, tmpRoute, tmpMethod, tmpBig ].every((pResponse) => { return pResponse.Body && pResponse.Body.Error && (typeof(pResponse.Body.Error.Code) === 'string') && (pResponse.Body.Error.Status === pResponse.Status) && (typeof(pResponse.Body.Error.Message) === 'string'); });
	check('demo errors use the service shape { Error: { Code, Status, Message } }', tmpShape);
};

const checkUpstreamDown = async () =>
{
	section('+ a domain goes away (runs last: it stops Bookstore)');
	await new Promise((fResolve) => { _Demo.Domains.Bookstore.stop(() => { fResolve(); }); });
	let tmpResponse = await query(groupState('Books'), 'user42');
	checkEqual('Books after its domain stopped: 502 DEMO_UPSTREAM_UNAVAILABLE', [ tmpResponse.Status, (tmpResponse.Body && tmpResponse.Body.Error) ? tmpResponse.Body.Error.Code : null ], [ 502, 'DEMO_UPSTREAM_UNAVAILABLE' ]);
	let tmpOther = await query(groupState('Documents'), 'user42');
	checkEqual('the other domains keep answering', tmpOther.Status, 200);
};

// ------------------------------------------------------------------------------------------------ run

/**
 * Stop the demo and exit with the result.
 *
 * @param {number} pCode
 */
const finish = (pCode) =>
{
	let fExit = () => { process.exit(pCode); };
	setTimeout(fExit, 10000).unref();
	if (_Demo)
	{
		return _Demo.stop(fExit);
	}
	return fExit();
};

/**
 * Boot, run every check, report, exit.
 */
const run = () =>
{
	libServer.quietKnownWarnings();
	let tmpStarted = Date.now();
	// DEMO_PG=1 runs the same checks on PostgreSQL (rfs-test-postgres; needs TZ=UTC): the answers are identical.
	_Provider = (process.env.DEMO_PG === '1') ? 'PostgreSQL' : 'SQLite';
	console.log(`Faceting-Demo-Smoke: booting the demo on 127.0.0.1:${SMOKE_PORT} (${_Provider}, Small) ...`);
	libServer.startDemo({ Port: SMOKE_PORT, Host: '127.0.0.1', Scale: 'Small', Provider: _Provider, LogLevel: 'fatal' },
		(pError, pDemo) =>
		{
			if (pError)
			{
				let tmpHint = (pError.code === 'EADDRINUSE') ? ` (the smoke always uses ${SMOKE_PORT}: is another smoke run, or a DEMO_PORT=${SMOKE_PORT} demo, still up?)` : '';
				console.error(`Faceting-Demo-Smoke: the demo did not start: ${pError.message}${tmpHint}`);
				return finish(1);
			}
			_Demo = pDemo;
			console.log(`  booted in ${Date.now() - tmpStarted} ms: ${pDemo.URL}`);
			(async () =>
			{
				await checkStatic();
				await checkDemoEndpoints();
				await checkDescribe();
				let tmpUser42 = await checkInitialTotals();
				await checkNotModified(tmpUser42);
				await checkRecords(tmpUser42);
				await checkWriteBack(tmpUser42);
				await checkForgedHeaders();
				await checkIntervalError();
				await checkLoopbackGuard();
				await checkClientLogic();
				await checkHostErrors();
				await checkUpstreamDown();
			})().then(
				() =>
				{
					console.log('');
					_Skipped.forEach((pSkip) => { console.log(`  skipped: ${pSkip}`); });
					if (_Failures.length > 0)
					{
						console.log(`Faceting-Demo-Smoke: ${_Failures.length} of ${_Checks} checks FAILED (${Date.now() - tmpStarted} ms):`);
						_Failures.forEach((pFailure) => { console.log(`  [${pFailure.Section}] ${pFailure.Name}${(typeof(pFailure.Detail) !== 'undefined') ? `  ${JSON.stringify(pFailure.Detail)}` : ''}`); });
						return finish(1);
					}
					console.log(`Faceting-Demo-Smoke: all ${_Checks} checks passed (${Date.now() - tmpStarted} ms).`);
					return finish(0);
				},
				(pRunError) =>
				{
					console.error(`Faceting-Demo-Smoke: the run broke off: ${pRunError && pRunError.stack ? pRunError.stack : pRunError}`);
					return finish(1);
				});
		});
};

if (require.main === module)
{
	run();
}

module.exports = { SMOKE_PORT: SMOKE_PORT, run: run };
