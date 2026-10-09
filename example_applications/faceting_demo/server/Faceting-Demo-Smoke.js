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
 *   12. (M4) the client's live-change contract without a server: the SSE parser (chunk splits, CR / LF / CRLF,
 *       comments, retry, ids), refetch selection by DependsOn, Seqs, backoff, Freshness (never key material), the
 *       write allowlist (matchWrite / checkBody), and the stream proxy against a stub upstream (streamed, persona
 *       resolved, headers filtered, upstream aborted when the browser leaves, refusals relayed)
 *   13. (M4) writes: off-allowlist 404s, 401 without a persona, 400 / 413 bodies, the domains' write guards (403
 *       for another tenant's rows and foreign keys, a colleague's document, a project the persona is not a member of;
 *       across tenants and owners, also straight at a domain server), nothing refused ever happened
 *   14. (M4) every "Make a change" write as user42 through the proxy: the write's 2xx; a generation event on user42's
 *       stream within 2 s and none on user81's; the dependent refetch with its pre-write ETag (200, the exact delta,
 *       Miss, Exact by MinSeq, Seq and DependsOn); a repeat Hit; an unaffected group's 304 NotModified; user43's
 *       shared E2 answer Stale right after a write, then fresh; undo restores every count.  The event / cache checks
 *       need the M4 service (Describe.Changes.Stream); without it they are skipped (DEMO_REQUIRE_LIVE=1 fails
 *       instead) and the writes, deltas and undo still run
 *   15. (M4) the browser's provider (Pict-Provider-Facet) run in node against the demo: Freshness on every Query,
 *       one stream per domain, a write refetches the dependent group by itself (If-None-Match + MinSeq, trigger
 *       logged), a group off screen is marked and refetched when shown, a 401 stream stops, closeChanges; with the
 *       cache, a Stale answer is followed up until fresh
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
const libChanges = require('../source/providers/Facet-Changes.js');
const libWrites = require('./Faceting-Demo-Writes.js');
const libFront = require('./Faceting-Demo-Front.js');

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
	// Byte-for-byte the browser's body: the provider adds DEFAULT_FRESHNESS (Bounded, 5 s) to every Query (M4).
	return call('POST', browserPath(pState, libSelection.KIND_QUERY), libSelection.buildQueryBody(pState, { Freshness: libSelection.DEFAULT_FRESHNESS }), { Persona: pPersona, Headers: pHeaders });
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

// ------------------------------------------------------------------------------------------------ M4: live changes

/**
 * Wait until a condition holds (polled every 20 ms), at most pTimeoutMS.
 *
 * @param {() => boolean} fCondition
 * @param {number} pTimeoutMS
 * @return {Promise<boolean>}
 */
const waitFor = async (fCondition, pTimeoutMS) =>
{
	let tmpUntil = Date.now() + pTimeoutMS;
	while (Date.now() < tmpUntil)
	{
		if (fCondition())
		{
			return true;
		}
		await new Promise((fResolve) => { setTimeout(fResolve, 20); });
	}
	return !!fCondition();
};

const sleep = (pMS) => { return new Promise((fResolve) => { setTimeout(fResolve, pMS); }); };

/**
 * Open a change stream the way the browser provider does (fetch + Facet-Changes.createParser), through a front
 * server.  Returns at once; Events fill in as they arrive.
 *
 * @param {number} pPort - the front server's port
 * @param {string} pDomain
 * @param {string|null} pPersona
 * @param {Record<string, string>} [pHeaders]
 * @return {Record<string, any>} { Events, Status, Headers, Body, Ended, Error, close() }
 */
const openStream = (pPort, pDomain, pPersona, pHeaders) =>
{
	let tmpController = new AbortController();
	let tmpStream = { Domain: pDomain, Persona: pPersona, Events: [], Status: null, Headers: {}, Body: null, Ended: false, Error: null, Chunks: 0 };
	let tmpParser = libChanges.createParser((pEvent) => { pEvent.At = Date.now(); tmpStream.Events.push(pEvent); });
	let tmpHeaders = Object.assign({ 'Accept': 'text/event-stream' }, pHeaders || {});
	if (typeof(pPersona) === 'string')
	{
		tmpHeaders[libPersonas.HEADER] = pPersona;
	}
	tmpStream.close = () => { try { tmpController.abort(); } catch (pError) { /* settled */ } };
	fetch(`http://127.0.0.1:${pPort}/api/${pDomain}${libFront.CHANGES_PATH}`, { headers: tmpHeaders, signal: tmpController.signal })
		.then(
			async (pResponse) =>
			{
				tmpStream.Status = pResponse.status;
				pResponse.headers.forEach((pValue, pKey) => { tmpStream.Headers[pKey] = pValue; });
				if (!/text\/event-stream/.test(pResponse.headers.get('content-type') || ''))
				{
					let tmpText = await pResponse.text();
					try
					{
						tmpStream.Body = JSON.parse(tmpText);
					}
					catch (pError)
					{
						tmpStream.Body = tmpText;
					}
					tmpStream.Ended = true;
					return;
				}
				let tmpReader = pResponse.body.getReader();
				let tmpDecoder = new TextDecoder('utf-8');
				for (;;)
				{
					let tmpChunk = await tmpReader.read();
					if (tmpChunk.done)
					{
						tmpParser.feed(tmpDecoder.decode());
						tmpParser.flush();
						break;
					}
					tmpStream.Chunks++;
					tmpParser.feed(tmpDecoder.decode(tmpChunk.value, { stream: true }));
				}
				tmpStream.Ended = true;
			})
		.catch(
			(pError) =>
			{
				tmpStream.Ended = true;
				if (!pError || (pError.name !== 'AbortError'))
				{
					tmpStream.Error = pError;
				}
			});
	return tmpStream;
};

/**
 * The generation events of a stream for an entity, after a mark (an index into Events).
 */
const generationsSince = (pStream, pMark, pEntity) =>
{
	return pStream.Events.slice(pMark || 0).filter((pEvent) => { return (pEvent.Event === 'generation') && pEvent.Data && (pEvent.Data.Entity === pEntity); });
};

/**
 * A listen()ed throwaway http server on an ephemeral loopback port.
 */
const listenEphemeral = (pServer) =>
{
	return new Promise((fResolve, fReject) => { pServer.once('error', fReject); pServer.listen(0, '127.0.0.1', () => { fResolve(pServer.address().port); }); });
};

const closeServer = (pServer) =>
{
	return new Promise((fResolve) => { if (typeof(pServer.closeAllConnections) === 'function') { pServer.closeAllConnections(); } pServer.close(() => { fResolve(); }); setTimeout(fResolve, 2000).unref(); });
};

const checkChangesContract = async () =>
{
	section('12. live changes: the client contract, the write allowlist, the stream proxy (no M4 server needed)');
	// -- the SSE parser
	let tmpEvents = [];
	let tmpParser = libChanges.createParser((pEvent) => { tmpEvents.push(pEvent); });
	tmpParser.feed('﻿retry: 2500\n\nevent: ready\ndata: {"NodeEpoch":"e:0000abcd","Seq":"e:0000abcd:0","Reset":false}\n\n');
	checkEqual('parser: a retry-only block is no event; ready carries Retry and its JSON', tmpEvents.map((pEvent) => { return [ pEvent.Event, pEvent.Data ? pEvent.Data.NodeEpoch : null, pEvent.Retry ]; }), [ [ 'ready', 'e:0000abcd', 2500 ] ]);
	tmpParser.feed('id: e:0000abcd:5\r');
	tmpParser.feed('\nevent: generation\r\ndata: {"Entity":"Project",');
	tmpParser.feed('"Generation":"g:1","Seq":"e:0000abcd:5"}\r');
	checkEqual('parser: a CR at the end of a chunk ends the line, the event waits for its blank line', tmpEvents.length, 1);
	tmpParser.feed('\n\r\n: hb\n\nevent: model\rdata: {"ModelVersion":"m:1"}\r\r');
	checkEqual('parser: CRLF / CR line ends, a comment between events', tmpEvents.slice(1).map((pEvent) => { return [ pEvent.Event, pEvent.Data ? (pEvent.Data.Entity || pEvent.Data.ModelVersion) : null, pEvent.ID ]; }), [ [ 'generation', 'Project', 'e:0000abcd:5' ], [ 'model', 'm:1', 'e:0000abcd:5' ] ]);
	tmpParser.feed('data: line one\ndata: line two\n\ndata\n\n');
	checkEqual('parser: multi-line data joins with LF (not JSON: Data null); a bare data field is an empty event', tmpEvents.slice(3).map((pEvent) => { return [ pEvent.Event, pEvent.Raw, pEvent.Data ]; }), [ [ 'message', 'line one\nline two', null ], [ 'message', '', null ] ]);
	tmpParser.feed('event: closed\ndata: {"Reason":"Shutdown"}');
	tmpParser.flush();
	checkEqual('parser: an unterminated block is discarded at the end of the stream', tmpEvents.length, 5);
	// -- refetch selection, Seqs, backoff, freshness
	let tmpGroups =
		{
			A: { Domain: 'D', Entity: 'Project', Status: 'Ready', DependsOn: [ 'Client', 'Project' ] },
			B: { Domain: 'D', Entity: 'Document', Status: 'Ready', DependsOn: [ 'Document' ] },
			C: { Domain: 'E', Entity: 'Project', Status: 'Ready', DependsOn: [ 'Project' ] },
			Y: { Domain: 'D', Entity: 'Project', Status: 'Idle' },
			Z: { Domain: 'D', Entity: 'Project', Status: 'Ready', Envelope: {} }
		};
	checkEqual('groupsToRefetch: by DependsOn; a group without DependsOn (once it asked) for any change; one domain only', libChanges.groupsToRefetch(tmpGroups, 'D', 'Project'), [ 'A', 'Z' ]);
	checkEqual('groupsToRefetch: a label target', libChanges.groupsToRefetch(tmpGroups, 'D', 'Client'), [ 'A', 'Z' ]);
	checkEqual('groupsToRefetch: an entity nothing depends on', libChanges.groupsToRefetch(tmpGroups, 'D', 'Task'), [ 'Z' ]);
	checkEqual('laterSeq: same epoch by counter, another epoch wins, malformed never wins', [ libChanges.laterSeq('e:0000abcd:9', 'e:0000abcd:10'), libChanges.laterSeq('e:0000abcd:10', 'e:0000abcd:9'), libChanges.laterSeq('e:0000abcd:10', 'e:11112222:1'), libChanges.laterSeq('e:0000abcd:3', 'nonsense'), libChanges.laterSeq(null, null) ], [ 'e:0000abcd:10', 'e:0000abcd:10', 'e:11112222:1', 'e:0000abcd:3', null ]);
	checkEqual('triggerText / shortSeq', [ libChanges.triggerText('Project', 'e:4f0c2b9e:15'), libChanges.shortSeq('e:x') ], [ 'Live update: Project @ e:…:15', '' ]);
	checkEqual('backoffMS: the server\'s retry doubled, capped at 30 s (the full delay)', [ libChanges.backoffMS(0, undefined, 1), libChanges.backoffMS(1, undefined, 1), libChanges.backoffMS(2, 1000, 1), libChanges.backoffMS(9, undefined, 1) ], [ 3000, 6000, 4000, 30000 ]);
	checkEqual('backoffMS: jittered to between half and all of it (streams cut together never reconnect together)', [ libChanges.backoffMS(0, undefined, 0), libChanges.backoffMS(9, undefined, 0.5) ], [ 1500, 22500 ]);
	check('backoffMS: a random jitter stays within [ ½, 1 ]', [ 0, 1, 2, 3, 4, 5, 6, 7 ].every(() => { let tmpDelay = libChanges.backoffMS(1); return (tmpDelay >= 3000) && (tmpDelay <= 6000); }));
	let tmpState = groupState('Documents');
	checkEqual('buildQueryBody: no Freshness unless asked; DEFAULT_FRESHNESS is Bounded 5 s', [ Object.prototype.hasOwnProperty.call(libSelection.buildQueryBody(tmpState), 'Freshness'), libSelection.buildQueryBody(tmpState, { Freshness: libSelection.DEFAULT_FRESHNESS }).Freshness ], [ false, { Mode: 'Bounded', MaxLagMS: 5000 } ]);
	checkEqual('freshnessBody: MinSeq rides on the base mode; no Seq + exact -> Exact', [ libSelection.freshnessBody(libSelection.DEFAULT_FRESHNESS, 'e:0000abcd:7'), libSelection.freshnessBody(libSelection.DEFAULT_FRESHNESS, null, true) ], [ { Mode: 'Bounded', MaxLagMS: 5000, MinSeq: 'e:0000abcd:7' }, { Mode: 'Exact', MaxLagMS: 5000 } ]);
	let tmpBody = libSelection.buildQueryBody(tmpState);
	check('requestKey: Freshness is not key material (an SSE refetch revalidates the cached answer)', libSelection.requestKey('ProjectTrack', 'user42', 'POST', '/q', tmpBody) === libSelection.requestKey('ProjectTrack', 'user42', 'POST', '/q', Object.assign({}, tmpBody, { Freshness: { Mode: 'Exact', MinSeq: 'e:0000abcd:1' } })));
	// -- the write allowlist (pure)
	let fMatch = (pDomain, pMethod, pPath) => { let tmpRoute = libWrites.matchWrite(pDomain, pMethod, pPath); return tmpRoute ? tmpRoute.Action : null; };
	checkEqual('matchWrite: exactly the §47.4 rows', [ fMatch('ProjectTrack', 'PUT', '/1.0/Project'), fMatch('ProjectTrack', 'POST', '/1.0/Document'), fMatch('ProjectTrack', 'DELETE', '/1.0/Document/12'), fMatch('ProjectTrack', 'GET', '/1.0/Document/Undelete/12'), fMatch('LabTrack', 'PUT', '/1.0/LabForm'), fMatch('Bookstore', 'POST', '/1.0/Review'), fMatch('Bookstore', 'DELETE', '/1.0/Review/3') ], [ 'ProjectStatus', 'DocumentAdd', 'DocumentDelete', 'DocumentUndelete', 'LabFormStatus', 'ReviewAdd', 'ReviewDelete' ]);
	checkEqual('matchWrite: anything else is not a write', [ fMatch('ProjectTrack', 'GET', '/1.0/Project'), fMatch('ProjectTrack', 'PUT', '/1.0/Project/5'), fMatch('ProjectTrack', 'DELETE', '/1.0/Project/5'), fMatch('ProjectTrack', 'PUT', '/1.0/Document'), fMatch('ProjectTrack', 'DELETE', '/1.0/Document/0'), fMatch('ProjectTrack', 'DELETE', '/1.0/Document/1/2'), fMatch('ProjectTrack', 'DELETE', '/1.0/Document/%31'), fMatch('Bookstore', 'PUT', '/1.0/Project'), fMatch('LabTrack', 'POST', '/1.0/LabForm'), fMatch('ProjectTrack', 'POST', '/1.0/Documents') ], [ null, null, null, null, null, null, null, null, null, null ]);
	let fCheck = (pAction, pBody) => { let tmpError = libWrites.checkBody(libWrites.WRITE_ROUTES.find((pRoute) => { return pRoute.Action === pAction; }), pBody); return tmpError ? `${tmpError.Code}${(tmpError.Detail && tmpError.Detail.Field) ? `:${tmpError.Detail.Field}` : ''}` : null; };
	checkEqual('checkBody: permitted keys, required keys, value shapes', [ fCheck('ProjectStatus', { IDProject: 3, Status: 'OnHold' }), fCheck('ProjectStatus', { IDProject: 3, Status: 'OnHold', Name: 'x' }), fCheck('ProjectStatus', { IDProject: 3, Status: 'Cancelled' }), fCheck('ProjectStatus', { IDProject: '3', Status: 'Done' }), fCheck('ProjectStatus', { IDProject: 3 }), fCheck('ProjectStatus', [ 1 ]), fCheck('DocumentAdd', { Title: 'T', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: 2 }), fCheck('DocumentAdd', { Title: 'T', Status: 'Draft', DocumentDate: '2026-13-45', IDFormType: 4, IDProject: 2 }), fCheck('DocumentAdd', { Title: 'T', Status: 'Draft', DocumentDate: '2026-03-15', IDFormType: 4, IDProject: 2, IDCustomer: 8 }), fCheck('LabFormStatus', { IDLabForm: 9, Status: 'Pending', CompletedDate: null }), fCheck('LabFormStatus', { IDLabForm: 9, Status: 'Complete', CompletedDate: '2026-10-09 12:00:00' }), fCheck('LabFormStatus', { IDLabForm: 9, Status: 'Pending', OwnerIDUser: 43 }), fCheck('ReviewAdd', { IDBook: 1, Rating: 5, Text: 'ok' }), fCheck('ReviewAdd', { IDBook: 1, Rating: 6 }), fCheck('DocumentDelete', undefined), fCheck('DocumentDelete', {}), fCheck('DocumentDelete', { IDDocument: 4 }) ], [ null, 'DEMO_WRITE_INVALID:Name', 'DEMO_WRITE_INVALID:Status', 'DEMO_WRITE_INVALID:IDProject', 'DEMO_WRITE_INVALID:Status', 'DEMO_WRITE_INVALID', null, 'DEMO_WRITE_INVALID:DocumentDate', 'DEMO_WRITE_INVALID:IDCustomer', null, null, 'DEMO_WRITE_INVALID:OwnerIDUser', null, 'DEMO_WRITE_INVALID:Rating', null, null, 'DEMO_WRITE_INVALID' ]);

	// -- the stream proxy against a stub upstream: streamed (not buffered), persona resolved, headers filtered,
	//    the upstream aborted when the browser goes away, refusals relayed whole
	let tmpSeen = [];
	let tmpOpen = [];
	let tmpStub = libHttp.createServer(
		(pRequest, pResponse) =>
		{
			let tmpRecord = { URL: pRequest.url, Method: pRequest.method, Headers: Object.assign({}, pRequest.headers), Closed: false };
			tmpSeen.push(tmpRecord);
			pRequest.on('close', () => { tmpRecord.Closed = true; });
			if (pRequest.url !== libFront.CHANGES_PATH)
			{
				pResponse.writeHead(404, { 'Content-Type': 'application/json' });
				return pResponse.end('{"Error":{"Code":"STUB_NOT_FOUND","Status":404,"Message":"no"}}');
			}
			if (!pRequest.headers['x-facet-test-tenant'])
			{
				pResponse.writeHead(401, { 'Content-Type': 'application/json' });
				return pResponse.end(JSON.stringify({ Error: { Code: 'FACET_UNAUTHENTICATED', Status: 401, Message: 'Authentication required.' } }));
			}
			pResponse.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Retold-Facet-Contract': '1', 'Vary': 'Cookie, Authorization', 'Set-Cookie': 'leak=1' });
			pResponse.write('retry: 2500\n\nevent: ready\ndata: {"NodeEpoch":"e:0000abcd","Seq":"e:0000abcd:0","CoalesceMS":250,"HeartbeatMS":15000,"Reset":false}\n\n');
			tmpOpen.push(pResponse);
		});
	let tmpStubPort = await listenEphemeral(tmpStub);
	let tmpFront = libFront.create({ DistRoot: _Demo.Options.DistRoot, Domains: { ProjectTrack: { baseURL: `http://127.0.0.1:${tmpStubPort}` } }, Status: () => { return {}; }, LoopbackOnly: true });
	let tmpFrontPort = await listenEphemeral(tmpFront);
	try
	{
		let tmpStream = openStream(tmpFrontPort, 'ProjectTrack', 'user42', { 'x-facet-test-tenant': '8', 'x-facet-test-user': '81', 'Last-Event-ID': 'e:0000abcd:3', 'If-None-Match': 'W/"x"', 'Cookie': 'a=b' });
		let tmpReady = await waitFor(() => { return tmpStream.Events.length > 0; }, 2000);
		check('stream proxy: the ready event arrives while the upstream stream is still open (streamed, not buffered)', tmpReady && (tmpOpen.length === 1) && !tmpStream.Ended, { Events: tmpStream.Events.length, Open: tmpOpen.length });
		let tmpHeaders = tmpStream.Headers;
		checkEqual('stream proxy: 200 text/event-stream, no-cache no-transform, no proxy buffering', [ tmpStream.Status, /text\/event-stream/.test(tmpHeaders['content-type'] || ''), tmpHeaders['cache-control'], tmpHeaders['x-accel-buffering'] ], [ 200, true, 'no-cache, no-transform', 'no' ]);
		check('stream proxy: provenance headers, Vary on the DEMO header, x-retold-facet-* kept, nothing else (no Set-Cookie)', (tmpHeaders['x-retold-facet-demo-upstream'] === 'GET /1.0/Facet/Changes') && (tmpHeaders['x-retold-facet-demo-session'] === 'tenant=7; user=42') && /X-Retold-Facet-Demo-Principal/i.test(tmpHeaders['vary'] || '') && (tmpHeaders['x-retold-facet-contract'] === '1') && !tmpHeaders['set-cookie'], tmpHeaders);
		let tmpUp = tmpSeen.find((pRecord) => { return pRecord.URL === libFront.CHANGES_PATH; }) || { Headers: {} };
		checkEqual('stream proxy: upstream sees the persona\'s session (never the forged one), Accept and Last-Event-ID, and nothing else of the browser\'s', [ tmpUp.Headers['x-facet-test-tenant'], tmpUp.Headers['x-facet-test-user'], tmpUp.Headers['accept'], tmpUp.Headers['last-event-id'], tmpUp.Headers['if-none-match'] || null, tmpUp.Headers['cookie'] || null, tmpUp.Headers['x-retold-facet-demo-principal'] || null ], [ '7', '42', 'text/event-stream', 'e:0000abcd:3', null, null, null ]);
		tmpOpen[0].write('id: e:0000abcd:4\nevent: generation\ndata: {"Entity":"Project","Generation":"g:aa","Seq":"e:0000abcd:4"}\n\n');
		let tmpGot = await waitFor(() => { return tmpStream.Events.some((pEvent) => { return pEvent.Event === 'generation'; }); }, 1000);
		check('stream proxy: a later event arrives on the open stream', tmpGot);
		tmpStream.close();
		let tmpAborted = await waitFor(() => { return tmpUp.Closed === true; }, 1500);
		check('stream proxy: the browser going away aborts the upstream request', tmpAborted);
		// The upstream ends the stream: the browser's response ends too.
		let tmpSecond = openStream(tmpFrontPort, 'ProjectTrack', 'user43');
		await waitFor(() => { return tmpOpen.length === 2; }, 2000);
		tmpOpen[1].end();
		check('stream proxy: the upstream ending ends the browser\'s stream', await waitFor(() => { return tmpSecond.Ended; }, 1500));
		let tmpAnonymous = openStream(tmpFrontPort, 'ProjectTrack', 'anonymous');
		await waitFor(() => { return tmpAnonymous.Ended; }, 2000);
		checkEqual('stream proxy: an anonymous stream gets the service\'s 401 relayed whole', [ tmpAnonymous.Status, (tmpAnonymous.Body && tmpAnonymous.Body.Error) ? tmpAnonymous.Body.Error.Code : null, tmpAnonymous.Headers['x-retold-facet-demo-session'] ], [ 401, 'FACET_UNAUTHENTICATED', 'anonymous' ]);
		let tmpPost = await fetch(`http://127.0.0.1:${tmpFrontPort}/api/ProjectTrack${libFront.CHANGES_PATH}`, { method: 'POST', headers: { [libPersonas.HEADER]: 'user42' } });
		checkEqual('stream proxy: POST /1.0/Facet/Changes is 405', tmpPost.status, 405);
		await tmpPost.text();
	}
	finally
	{
		tmpOpen.forEach((pResponse) => { try { pResponse.end(); } catch (pError) { /* gone */ } });
		await closeServer(tmpFront);
		await closeServer(tmpStub);
	}
	console.log('    parser, refetch selection, Seqs, freshness, write allowlist and the stream proxy (stub upstream) checked');
};

/**
 * Bucket counts of a facet as { '<key>': count } (count > 0 only).
 */
const countsOf = (pEnvelope, pFacetKey) =>
{
	let tmpMap = {};
	let tmpFacet = (pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets[pFacetKey] : null;
	((tmpFacet && Array.isArray(tmpFacet.Buckets)) ? tmpFacet.Buckets : []).forEach((pBucket) => { if (pBucket.Count > 0) { tmpMap[String(pBucket.Key)] = pBucket.Count; } });
	return tmpMap;
};

/**
 * A copy of a counts map with deltas applied (zero entries dropped).
 */
const withDeltas = (pCounts, pDeltas) =>
{
	let tmpMap = Object.assign({}, pCounts);
	Object.keys(pDeltas).forEach((pKey) => { tmpMap[pKey] = (tmpMap[pKey] || 0) + pDeltas[pKey]; if (tmpMap[pKey] === 0) { delete tmpMap[pKey]; } });
	return tmpMap;
};

/**
 * Sorted entries of a counts map (for an order-free comparison).
 */
const entriesOf = (pCounts) =>
{
	return Object.keys(pCounts).sort().map((pKey) => { return [ pKey, pCounts[pKey] ]; });
};

const checkWriteGuards = async (pUser42) =>
{
	section('13. writes: the allowlist and the write guards (through the proxy, and straight at a domain server)');
	let fCode = (pResponse) => { return (pResponse.Body && pResponse.Body.Error && (typeof(pResponse.Body.Error) === 'object')) ? pResponse.Body.Error.Code : null; };
	let tmpProject = (pUser42.Projects.Body.Records || [])[0];
	let tmpDocument = (pUser42.Documents.Body.Records || [])[0];
	let tmpForms = await call('POST', '/api/LabTrack/1.0/Facet/LabForm/Records/0/1', { Clauses: [] }, { Persona: 'user42' });
	let tmpForm = Array.isArray(tmpForms.Body) ? tmpForms.Body[0] : null;
	check('fixtures for the guard checks: a tenant-7 project, document and one of user42\'s lab forms', !!tmpProject && !!tmpDocument && !!tmpForm);
	let tmpNotListed = await call('PUT', '/api/ProjectTrack/1.0/Document', { IDDocument: tmpDocument.IDDocument, Title: 'x' }, { Persona: 'user42' });
	checkEqual('a write that is not on the allowlist: 404 DEMO_NOT_FOUND', [ tmpNotListed.Status, fCode(tmpNotListed) ], [ 404, 'DEMO_NOT_FOUND' ]);
	let tmpByID = await call('PUT', `/api/ProjectTrack/1.0/Project/${tmpProject.IDProject}`, { Status: 'Done' }, { Persona: 'user42' });
	checkEqual('PUT /1.0/Project/<ID> (another route form): 404 DEMO_NOT_FOUND', [ tmpByID.Status, fCode(tmpByID) ], [ 404, 'DEMO_NOT_FOUND' ]);
	let tmpQueryString = await call('PUT', '/api/ProjectTrack/1.0/Project?x=1', { IDProject: tmpProject.IDProject, Status: 'Done' }, { Persona: 'user42' });
	checkEqual('an allowlisted write with a query string: 404 DEMO_NOT_FOUND', tmpQueryString.Status, 404);
	let tmpAnonymous = await call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpProject.IDProject, Status: 'Done' }, { Persona: 'anonymous' });
	checkEqual('a write without a persona: 401 DEMO_UNAUTHENTICATED (never forwarded)', [ tmpAnonymous.Status, fCode(tmpAnonymous) ], [ 401, 'DEMO_UNAUTHENTICATED' ]);
	let tmpExtra = await call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpProject.IDProject, Status: 'Done', IDCustomer: 8 }, { Persona: 'user42' });
	checkEqual('a body with another key: 400 DEMO_WRITE_INVALID naming it', [ tmpExtra.Status, fCode(tmpExtra), (tmpExtra.Body && tmpExtra.Body.Error && tmpExtra.Body.Error.Detail) ? tmpExtra.Body.Error.Detail.Field : null ], [ 400, 'DEMO_WRITE_INVALID', 'IDCustomer' ]);
	let tmpText = await call('PUT', '/api/ProjectTrack/1.0/Project', 'IDProject=1', { Persona: 'user42', Headers: { 'Content-Type': 'text/plain' } });
	checkEqual('a write body that is not JSON: 400 DEMO_WRITE_INVALID', [ tmpText.Status, fCode(tmpText) ], [ 400, 'DEMO_WRITE_INVALID' ]);
	let tmpBig = await call('POST', '/api/Bookstore/1.0/Review', { IDBook: 1, Rating: 5, Text: 'x'.repeat(20 * 1024) }, { Persona: 'user42' });
	checkEqual('a write body over 16 KiB: 413 DEMO_BODY_TOO_LARGE', [ tmpBig.Status, fCode(tmpBig) ], [ 413, 'DEMO_BODY_TOO_LARGE' ]);
	let tmpOther = await call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpProject.IDProject, Status: 'Done' }, { Persona: 'user81' });
	checkEqual('user81 (tenant 8) changing a tenant-7 project: 403 DEMO_WRITE_REFUSED (the domain\'s write guard)', [ tmpOther.Status, fCode(tmpOther) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	check('a refused write leaks neither the record nor the query', tmpOther.Text.indexOf('"Record"') < 0 && tmpOther.Text.indexOf('"Query"') < 0 && tmpOther.Text.indexOf(String(tmpProject.Name)) < 0, tmpOther.Text.slice(0, 200));
	let tmpColleague = await call('PUT', '/api/LabTrack/1.0/LabForm', { IDLabForm: tmpForm ? tmpForm.IDLabForm : 1, Status: 'Complete', CompletedDate: '2026-10-09 12:00:00' }, { Persona: 'user43' });
	checkEqual('user43 completing user42\'s lab form: 403 (owner-scoped)', [ tmpColleague.Status, fCode(tmpColleague) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	let tmpDelete = await call('DELETE', `/api/ProjectTrack/1.0/Document/${tmpDocument.IDDocument}`, null, { Persona: 'user81' });
	checkEqual('user81 deleting a tenant-7 document: 403', [ tmpDelete.Status, fCode(tmpDelete) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	// Rows inside the persona's tenant but outside what it may touch (the UI's "my" scope), and foreign keys into
	// another tenant's data: the guards read them (internal-contracts §47.5).
	let tmpProjectDB = _Demo.Domains.ProjectTrack.db;
	let tmpBookDB = _Demo.Domains.Bookstore.db;
	let tmpForeignProject = tmpProjectDB.prepare('SELECT IDProject FROM Project WHERE IDCustomer <> 7 AND Deleted = 0 ORDER BY IDProject LIMIT 1').get();
	let tmpForeignBook = tmpBookDB.prepare('SELECT IDBook FROM Book WHERE IDTenant <> 7 AND Deleted = 0 ORDER BY IDBook LIMIT 1').get();
	let tmpNotMine = tmpProjectDB.prepare('SELECT d.IDDocument AS IDDocument FROM Document d WHERE d.IDCustomer = 7 AND d.Deleted = 0 AND (d.CreatingIDUser IS NULL OR d.CreatingIDUser <> 42) AND NOT EXISTS (SELECT 1 FROM ProjectMembership m WHERE m.IDProject = d.IDProject AND m.IDUser = 42 AND m.Active = 1 AND m.Deleted = 0) ORDER BY d.IDDocument LIMIT 1').get();
	let tmpNotMyProject = tmpProjectDB.prepare('SELECT p.IDProject AS IDProject FROM Project p WHERE p.IDCustomer = 7 AND p.Deleted = 0 AND NOT EXISTS (SELECT 1 FROM ProjectMembership m WHERE m.IDProject = p.IDProject AND m.IDUser = 42 AND m.Active = 1 AND m.Deleted = 0) ORDER BY p.IDProject LIMIT 1').get();
	check('fixtures for the ownership checks: another tenant\'s project and book, a tenant-7 document and project that are not user42\'s', !!tmpForeignProject && !!tmpForeignBook && !!tmpNotMine && !!tmpNotMyProject);
	let tmpCrossProject = await call('POST', '/api/ProjectTrack/1.0/Document', { Title: 'Into another tenant', Status: 'Draft', DocumentDate: '2026-03-15', IDFormType: 4, IDProject: tmpForeignProject ? tmpForeignProject.IDProject : 1 }, { Persona: 'user42' });
	checkEqual('user42 adding a document to another tenant\'s project: 403 (the guard reads the referenced row)', [ tmpCrossProject.Status, fCode(tmpCrossProject) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	let tmpCrossBook = await call('POST', '/api/Bookstore/1.0/Review', { IDBook: tmpForeignBook ? tmpForeignBook.IDBook : 1, Rating: 5, Text: 'Into another tenant' }, { Persona: 'user42' });
	checkEqual('user42 reviewing another tenant\'s book: 403', [ tmpCrossBook.Status, fCode(tmpCrossBook) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	let tmpUnknownForm = await call('POST', '/api/ProjectTrack/1.0/Document', { Title: 'Unknown form', Status: 'Draft', DocumentDate: '2026-03-15', IDFormType: 999999, IDProject: tmpDocument.IDProject }, { Persona: 'user42' });
	checkEqual('user42 naming a form type that does not exist (a shared lookup): 403', [ tmpUnknownForm.Status, fCode(tmpUnknownForm) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	let tmpColleagueDocument = await call('DELETE', `/api/ProjectTrack/1.0/Document/${tmpNotMine ? tmpNotMine.IDDocument : 1}`, null, { Persona: 'user42' });
	checkEqual('user42 deleting a colleague\'s document (not its writer, not a member of its project): 403', [ tmpColleagueDocument.Status, fCode(tmpColleagueDocument) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	let tmpNotMemberProject = await call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpNotMyProject ? tmpNotMyProject.IDProject : 1, Status: 'Done' }, { Persona: 'user42' });
	checkEqual('user42 changing a tenant-7 project it is not a member of: 403', [ tmpNotMemberProject.Status, fCode(tmpNotMemberProject) ], [ 403, 'DEMO_WRITE_REFUSED' ]);
	// Straight at the domain server (the proxy bypassed, as a loopback client could): the guard still refuses a body
	// naming another tenant, and stamps the session's tenant otherwise.
	let tmpHarness = _Demo.Domains.ProjectTrack;
	let tmpDirect = await fetch(`${tmpHarness.baseURL}/1.0/Document`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-facet-test-tenant': '7', 'x-facet-test-user': '42' }, body: JSON.stringify({ Title: 'Cross-tenant', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: tmpDocument.IDProject, IDCustomer: 8 }) });
	checkEqual('straight at the domain server: a Create naming another tenant is refused (403)', tmpDirect.status, 403);
	await tmpDirect.text();
	let tmpStatus = await call('GET', '/api/Demo/Status');
	let tmpGuards = Object.keys(tmpStatus.Body.Domains || {}).map((pDomain) => { let tmpGuard = tmpStatus.Body.Domains[pDomain].WriteGuard; return [ pDomain, !!tmpGuard && tmpGuard.Installed && (tmpGuard.Entities > 0) ]; });
	checkEqual('/api/Demo/Status: every domain has its write guards', tmpGuards, [ [ 'ProjectTrack', true ], [ 'LabTrack', true ], [ 'Bookstore', true ] ]);
	check('/api/Demo/Status: the guards counted the refusals', (tmpStatus.Body.Domains.ProjectTrack.WriteGuard.Refused >= 3) && (tmpStatus.Body.Domains.LabTrack.WriteGuard.Refused >= 1), tmpStatus.Body.Domains.ProjectTrack.WriteGuard);
	checkEqual('/api/Demo/Status: the write allowlist per domain', tmpStatus.Body.Domains.ProjectTrack.Writes, [ 'PUT /1.0/Project', 'POST /1.0/Document', 'DELETE /1.0/Document/<ID>', 'GET /1.0/Document/Undelete/<ID>' ]);
	let tmpAfter = await query(groupState('Projects'), 'user42');
	checkEqual('nothing the refused writes asked for happened (Projects still 6)', tmpAfter.Body ? tmpAfter.Body.Total : null, 6);
};

/**
 * The live part of one "Make a change" action (§47.6): the write, the event on user42's stream and none on
 * user81's, the dependent refetch (pre-write ETag, MinSeq) with its delta and a Miss, a repeat Hit, an unaffected
 * group's 304 NotModified.  Returns { Event, Refetch } for the caller's own checks.
 */
const liveStep = async (pLive, pName, pDomain, pEntity, fWrite, pDependent, pUnaffected) =>
{
	let tmpMark42 = pLive.Stream ? pLive.User42[pDomain].Events.length : 0;
	let tmpMark81 = pLive.Stream ? pLive.User81[pDomain].Events.length : 0;
	let tmpWrite = await fWrite();
	check(`${pName}: the write answers 2xx through the proxy`, (tmpWrite.Status >= 200) && (tmpWrite.Status < 300), [ tmpWrite.Status, tmpWrite.Body ]);
	check(`${pName}: the write answer names the allowlisted action`, !!tmpWrite.Headers['x-retold-facet-demo-write'], tmpWrite.Headers);
	let tmpEvent = null;
	if (pLive.Stream)
	{
		let tmpStarted = Date.now();
		let tmpArrived = await waitFor(() => { return generationsSince(pLive.User42[pDomain], tmpMark42, pEntity).length > 0; }, 2000);
		let tmpEvents = generationsSince(pLive.User42[pDomain], tmpMark42, pEntity);
		tmpEvent = tmpEvents.length ? tmpEvents[tmpEvents.length - 1] : null;
		check(`${pName}: user42's stream gets a generation event for ${pEntity} within 2 s`, tmpArrived, { Events: pLive.User42[pDomain].Events.slice(tmpMark42).map((pEvent) => { return pEvent.Raw; }) });
		if (tmpEvent)
		{
			checkEqual(`${pName}: the event carries only Entity, Generation and Seq`, Object.keys(tmpEvent.Data || {}).sort(), [ 'Entity', 'Generation', 'Seq' ]);
			check(`${pName}: the event's Seq is well-formed, and no id line (events are never replayed)`, libChanges.SEQ_PATTERN.test(tmpEvent.Data.Seq) && !tmpEvent.ID && /^g:[0-9a-f]{12}$/.test(tmpEvent.Data.Generation), tmpEvent);
			console.log(`    ${pName}: ${pEntity} event after ${tmpEvent.At - tmpStarted} ms (${tmpEvent.Data.Seq})`);
		}
		await sleep(350);
		checkEqual(`${pName}: user81's stream (tenant 8) gets nothing for ${pEntity}`, generationsSince(pLive.User81[pDomain], tmpMark81, pEntity).length, 0);
	}
	let tmpSeq = (tmpEvent && tmpEvent.Data) ? tmpEvent.Data.Seq : null;
	let tmpFreshness = libSelection.freshnessBody(libSelection.DEFAULT_FRESHNESS, tmpSeq);
	let tmpRefetch = await call('POST', browserPath(pDependent.State, libSelection.KIND_QUERY), libSelection.buildQueryBody(pDependent.State, { Freshness: tmpFreshness }), { Persona: 'user42', Headers: { 'If-None-Match': pDependent.ETag } });
	checkEqual(`${pName}: the dependent ${pDependent.State.Hash} refetch (pre-write ETag) answers 200`, tmpRefetch.Status, 200);
	if (pLive.Wired)
	{
		check(`${pName}: the answer says it depends on ${pEntity}`, !!tmpRefetch.Body && Array.isArray(tmpRefetch.Body.DependsOn) && (tmpRefetch.Body.DependsOn.indexOf(pEntity) >= 0), tmpRefetch.Body ? tmpRefetch.Body.DependsOn : null);
		if (tmpSeq)
		{
			check(`${pName}: Exact because of MinSeq (X-Retold-Facet-Freshness)`, /^Exact/.test(tmpRefetch.Headers['x-retold-facet-freshness'] || '') && /MinSeq/.test(tmpRefetch.Headers['x-retold-facet-freshness'] || ''), tmpRefetch.Headers['x-retold-facet-freshness']);
			check(`${pName}: X-Retold-Facet-Seq covers the write`, !!libChanges.parseSeq(tmpRefetch.Headers['x-retold-facet-seq']) && (libChanges.laterSeq(tmpRefetch.Headers['x-retold-facet-seq'], tmpSeq) === tmpRefetch.Headers['x-retold-facet-seq']), [ tmpRefetch.Headers['x-retold-facet-seq'], tmpSeq ]);
		}
	}
	if (pLive.Cache)
	{
		checkEqual(`${pName}: the refetch is computed (Miss)`, [ tmpRefetch.Headers['x-retold-facet-cache'], tmpRefetch.Body ? tmpRefetch.Body.Cached : null ], [ 'Miss', false ]);
		let tmpRepeat = await query(pDependent.State, 'user42');
		checkEqual(`${pName}: a repeat request answers Hit (Cached: true)`, [ tmpRepeat.Status, tmpRepeat.Headers['x-retold-facet-cache'], tmpRepeat.Body ? tmpRepeat.Body.Cached : null, tmpRepeat.Body ? tmpRepeat.Body.Total : null ], [ 200, 'Hit', true, tmpRefetch.Body ? tmpRefetch.Body.Total : null ]);
		check(`${pName}: the ETag changed with the write and is stable on the repeat`, (tmpRefetch.Headers.etag !== pDependent.ETag) && (tmpRepeat.Headers.etag === tmpRefetch.Headers.etag), [ pDependent.ETag, tmpRefetch.Headers.etag, tmpRepeat.Headers.etag ]);
	}
	if (pUnaffected)
	{
		let tmpUnaffected = await call('POST', browserPath(pUnaffected.State, libSelection.KIND_QUERY), libSelection.buildQueryBody(pUnaffected.State, { Freshness: libSelection.DEFAULT_FRESHNESS }), { Persona: 'user42', Headers: { 'If-None-Match': pUnaffected.ETag } });
		checkEqual(`${pName}: the unaffected ${pUnaffected.State.Hash} with its old ETag answers 304${pLive.Cache ? ' NotModified' : ''}`, [ tmpUnaffected.Status, pLive.Cache ? tmpUnaffected.Headers['x-retold-facet-cache'] : 'NotModified' ], [ 304, 'NotModified' ]);
	}
	return { Write: tmpWrite, Event: tmpEvent, Refetch: tmpRefetch };
};

/**
 * One group's current answer as user42 (state, envelope, ETag).
 */
const snapshot = async (pGroup, pPersona) =>
{
	let tmpState = groupState(pGroup);
	let tmpResponse = await query(tmpState, pPersona || 'user42');
	return { State: tmpState, Response: tmpResponse, Envelope: tmpResponse.Body, ETag: tmpResponse.Headers.etag };
};

const checkLiveChanges = async () =>
{
	section('14. live changes (M4): every "Make a change" write as user42, its event, the refetch, the cache, undo');
	// What this service offers, probed separately: the change stream, the result cache (X-Retold-Facet-Cache), and the
	// wired pipeline (Describe's Changes block, DependsOn).  Each missing part skips its own checks with a note
	// (DEMO_REQUIRE_LIVE=1: fails them instead); the writes, deltas and undo always run.
	let tmpDescribe = await call('GET', '/api/ProjectTrack/1.0/Facet/Describe', null, { Persona: 'user42' });
	let tmpChanges = (tmpDescribe.Body && tmpDescribe.Body.Changes) ? tmpDescribe.Body.Changes : null;
	let tmpProbe = openStream(SMOKE_PORT, 'ProjectTrack', 'user42');
	await waitFor(() => { return tmpProbe.Ended || tmpProbe.Events.some((pEvent) => { return pEvent.Event === 'ready'; }); }, 2000);
	let tmpStreamUp = (tmpProbe.Status === 200) && tmpProbe.Events.some((pEvent) => { return pEvent.Event === 'ready'; });
	tmpProbe.close();
	let tmpProbeQuery = await query(groupState('Projects'), 'user42');
	let tmpCacheHeader = tmpProbeQuery.Headers['x-retold-facet-cache'] || null;
	let tmpLive = { Stream: tmpStreamUp, Cache: !!tmpCacheHeader && (tmpCacheHeader !== 'Off'), Wired: !!(tmpChanges && tmpChanges.Stream), User42: {}, User81: {} };
	let fMissing = (pWhat, pDetail) =>
	{
		if (process.env.DEMO_REQUIRE_LIVE === '1')
		{
			check(`DEMO_REQUIRE_LIVE=1: ${pWhat}`, false, pDetail);
			return;
		}
		let tmpMessage = `M4 ${pWhat} is not available yet (${pDetail}): its checks are skipped; the writes, deltas and undo still run`;
		_Skipped.push(tmpMessage);
		console.log(`    skipped: ${tmpMessage}`);
	};
	if (!tmpLive.Wired)
	{
		fMissing('Describe.Changes / DependsOn (the wired pipeline)', 'Describe has no Changes block');
	}
	else
	{
		check('Describe names the change stream and the intake', /\/Changes$/.test(tmpChanges.Stream) && (typeof(tmpChanges.Intake) === 'string') && (tmpChanges.Intake !== 'None'), tmpChanges);
		check('Describe says the cache is on (the demo opts in)', !!tmpDescribe.Body.Cache && (tmpDescribe.Body.Cache.Enabled === true), tmpDescribe.Body.Cache);
	}
	if (!tmpLive.Cache)
	{
		fMissing('the result cache', `X-Retold-Facet-Cache: ${tmpCacheHeader || 'absent'}`);
	}
	if (!tmpLive.Stream)
	{
		fMissing('the change stream', `GET /1.0/Facet/Changes answered ${tmpProbe.Status}`);
	}
	else
	{
		// Let the server drop the probe (MaxPerPrincipal), then one stream per (persona, domain).
		await sleep(150);
		libServer.Domains.DOMAINS.forEach(
			(pDomain) =>
			{
				tmpLive.User42[pDomain.Domain] = openStream(SMOKE_PORT, pDomain.Domain, 'user42');
				tmpLive.User81[pDomain.Domain] = openStream(SMOKE_PORT, pDomain.Domain, 'user81');
			});
		let tmpReady = await waitFor(() => { return [ tmpLive.User42, tmpLive.User81 ].every((pSet) => { return Object.keys(pSet).every((pDomain) => { return pSet[pDomain].Events.some((pEvent) => { return pEvent.Event === 'ready'; }); }); }); }, 3000);
		check('six streams (user42 and user81 x three domains) are open with a ready event', tmpReady, Object.keys(tmpLive.User42).map((pDomain) => { return [ pDomain, tmpLive.User42[pDomain].Status, tmpLive.User81[pDomain].Status, tmpLive.User42[pDomain].Body ]; }));
		let tmpFirstReady = tmpLive.User42.ProjectTrack.Events.find((pEvent) => { return pEvent.Event === 'ready'; });
		check('ready: { NodeEpoch, Seq, CoalesceMS, HeartbeatMS, Reset: false } and a retry', !!tmpFirstReady && /^e:[0-9a-f]{8}$/.test(tmpFirstReady.Data.NodeEpoch) && libChanges.SEQ_PATTERN.test(tmpFirstReady.Data.Seq) && (tmpFirstReady.Data.Reset === false) && (typeof(tmpFirstReady.Retry) === 'number'), tmpFirstReady);
		checkEqual('stream headers through the proxy', [ tmpLive.User42.LabTrack.Status, /text\/event-stream/.test(tmpLive.User42.LabTrack.Headers['content-type'] || ''), tmpLive.User42.LabTrack.Headers['x-retold-facet-demo-session'] ], [ 200, true, 'tenant=7; user=42' ]);
		let tmpAnonymous = openStream(SMOKE_PORT, 'Bookstore', 'anonymous');
		await waitFor(() => { return tmpAnonymous.Ended; }, 2000);
		checkEqual('an anonymous stream: 401 FACET_UNAUTHENTICATED', [ tmpAnonymous.Status, (tmpAnonymous.Body && tmpAnonymous.Body.Error) ? tmpAnonymous.Body.Error.Code : null ], [ 401, 'FACET_UNAUTHENTICATED' ]);
	}
	try
	{
		// ---- Projects for me: Active / At risk -> On hold, then Undo
		let tmpProjects = await snapshot('Projects');
		let tmpDocuments = await snapshot('Documents');
		let tmpTarget = (tmpProjects.Envelope.Records || []).find((pRecord) => { return (pRecord.Status === 'Active') || (pRecord.Status === 'AtRisk'); });
		check('Projects: a listed Active / At risk project to change', !!tmpTarget);
		let tmpStatusBefore = countsOf(tmpProjects.Envelope, 'Status');
		let tmpStep = await liveStep(tmpLive, 'Projects status -> OnHold', 'ProjectTrack', 'Project',
			() => { return call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpTarget.IDProject, Status: 'OnHold' }, { Persona: 'user42' }); },
			tmpProjects, tmpDocuments);
		checkEqual('Projects status -> OnHold: the write returns the updated row', tmpStep.Write.Body ? [ tmpStep.Write.Body.IDProject, tmpStep.Write.Body.Status ] : null, [ tmpTarget.IDProject, 'OnHold' ]);
		let tmpDelta = {};
		tmpDelta[tmpTarget.Status] = -1;
		tmpDelta.OnHold = 1;
		checkEqual('Projects status -> OnHold: Total 6 -> 5 (OnHold is not selected)', tmpStep.Refetch.Body ? tmpStep.Refetch.Body.Total : null, tmpProjects.Envelope.Total - 1);
		checkEqual(`Projects status -> OnHold: Status counts ${tmpTarget.Status} -1, OnHold +1 (the Status card ignores its own selection)`, entriesOf(countsOf(tmpStep.Refetch.Body, 'Status')), entriesOf(withDeltas(tmpStatusBefore, tmpDelta)));
		let tmpUndoProjects = await snapshot('Projects');
		let tmpUndo = await liveStep(tmpLive, 'Projects undo', 'ProjectTrack', 'Project',
			() => { return call('PUT', '/api/ProjectTrack/1.0/Project', { IDProject: tmpTarget.IDProject, Status: tmpTarget.Status }, { Persona: 'user42' }); },
			tmpUndoProjects, null);
		checkEqual('Projects undo: the totals are back (6, same Status counts)', [ tmpUndo.Refetch.Body ? tmpUndo.Refetch.Body.Total : null, entriesOf(countsOf(tmpUndo.Refetch.Body, 'Status')) ], [ tmpProjects.Envelope.Total, entriesOf(tmpStatusBefore) ]);
		console.log(`    Projects: "${tmpTarget.Name}" ${tmpTarget.Status} -> OnHold: Total ${tmpProjects.Envelope.Total} -> ${tmpStep.Refetch.Body.Total}; undo -> ${tmpUndo.Refetch.Body.Total}`);

		// ---- Documents by form type: add a Draft Form D document dated 2026-03-15; delete; undelete; delete
		tmpDocuments = await snapshot('Documents');
		tmpProjects = await snapshot('Projects');
		let tmpProjectID = ((tmpDocuments.Envelope.Records || [])[0] || {}).IDProject;
		let tmpMonthBefore = countsOf(tmpDocuments.Envelope, 'ByMonth');
		let tmpDocStatusBefore = countsOf(tmpDocuments.Envelope, 'Status');
		let tmpMarch = Object.keys(tmpMonthBefore).find((pKey) => { return /^2026-03-01/.test(pKey); }) || '2026-03-01 00:00:00';
		let tmpAdd = await liveStep(tmpLive, 'Documents add', 'ProjectTrack', 'Document',
			() => { return call('POST', '/api/ProjectTrack/1.0/Document', { Title: 'Smoke document', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: tmpProjectID }, { Persona: 'user42' }); },
			tmpDocuments, tmpProjects);
		let tmpDocumentID = tmpAdd.Write.Body ? tmpAdd.Write.Body.IDDocument : null;
		check('Documents add: the new row is in tenant 7 (stamped by the guard), Draft, Form D', !!tmpAdd.Write.Body && (tmpAdd.Write.Body.IDCustomer === 7) && (tmpAdd.Write.Body.Status === 'Draft') && (tmpAdd.Write.Body.IDFormType === 4), tmpAdd.Write.Body);
		let tmpMonthDelta = {};
		tmpMonthDelta[tmpMarch] = 1;
		checkEqual('Documents add: Total 41 -> 42, March +1, Draft +1', [ tmpAdd.Refetch.Body ? tmpAdd.Refetch.Body.Total : null, entriesOf(countsOf(tmpAdd.Refetch.Body, 'ByMonth')), entriesOf(countsOf(tmpAdd.Refetch.Body, 'Status')) ], [ tmpDocuments.Envelope.Total + 1, entriesOf(withDeltas(tmpMonthBefore, tmpMonthDelta)), entriesOf(withDeltas(tmpDocStatusBefore, { Draft: 1 })) ]);
		// Delete it; user43 asks right away (Bounded, nothing of its own written): the E2 key is shared, so the answer
		// computed for user42 a moment ago comes back Stale, then fresh once the background refresh stored it.
		let tmpAfterAdd = await snapshot('Documents');
		let tmpDelete = await call('DELETE', `/api/ProjectTrack/1.0/Document/${tmpDocumentID}`, null, { Persona: 'user42' });
		checkEqual('Documents delete: 200 { Count: 1 }', [ tmpDelete.Status, tmpDelete.Body ? tmpDelete.Body.Count : null ], [ 200, 1 ]);
		let tmpUser43 = await query(groupState('Documents'), 'user43');
		if (tmpLive.Cache)
		{
			checkEqual('user43 right after user42\'s delete (Bounded): the shared E2 answer comes back Stale', [ tmpUser43.Status, tmpUser43.Headers['x-retold-facet-cache'], tmpUser43.Body ? tmpUser43.Body.Stale : null, tmpUser43.Body ? tmpUser43.Body.Exact : null, tmpUser43.Body ? tmpUser43.Body.Total : null ], [ 200, 'Stale', true, false, tmpAfterAdd.Envelope.Total ]);
			check('user43 Stale: LagMS is the answer\'s age, within MaxLagMS', !!tmpUser43.Body && (tmpUser43.Body.LagMS > 0) && (tmpUser43.Body.LagMS <= 5000), tmpUser43.Body ? tmpUser43.Body.LagMS : null);
			let tmpFresh = null;
			await waitFor(() => { return false; }, 0);
			for (let i = 0; i < 40; i++)
			{
				await sleep(75);
				tmpFresh = await query(groupState('Documents'), 'user43');
				if (tmpFresh.Body && (tmpFresh.Body.Stale === false))
				{
					break;
				}
			}
			checkEqual('user43 a moment later: fresh (the background refresh ran), Total 41', [ tmpFresh.Body ? tmpFresh.Body.Stale : null, tmpFresh.Body ? tmpFresh.Body.Total : null, tmpFresh.Headers['x-retold-facet-cache'] ], [ false, tmpDocuments.Envelope.Total, 'Hit' ]);
		}
		else
		{
			checkEqual('user43 after user42\'s delete: Total 41', tmpUser43.Body ? tmpUser43.Body.Total : null, tmpDocuments.Envelope.Total);
		}
		let tmpUndeleteFrom = await snapshot('Documents');
		checkEqual('Documents delete: user42 (read-your-writes) sees 41', tmpUndeleteFrom.Envelope.Total, tmpDocuments.Envelope.Total);
		let tmpUndelete = await liveStep(tmpLive, 'Documents undelete', 'ProjectTrack', 'Document',
			() => { return call('GET', `/api/ProjectTrack/1.0/Document/Undelete/${tmpDocumentID}`, null, { Persona: 'user42' }); },
			tmpUndeleteFrom, null);
		checkEqual('Documents undelete: 42 again', tmpUndelete.Refetch.Body ? tmpUndelete.Refetch.Body.Total : null, tmpDocuments.Envelope.Total + 1);
		let tmpCleanup = await call('DELETE', `/api/ProjectTrack/1.0/Document/${tmpDocumentID}`, null, { Persona: 'user42' });
		checkEqual('Documents: deleted again (the smoke leaves the counts as it found them)', tmpCleanup.Status, 200);
		let tmpDocumentsAfter = await snapshot('Documents');
		checkEqual('Documents: back to 41 with the same March and Status counts', [ tmpDocumentsAfter.Envelope.Total, entriesOf(countsOf(tmpDocumentsAfter.Envelope, 'ByMonth')), entriesOf(countsOf(tmpDocumentsAfter.Envelope, 'Status')) ], [ tmpDocuments.Envelope.Total, entriesOf(tmpMonthBefore), entriesOf(tmpDocStatusBefore) ]);
		console.log(`    Documents: add #${tmpDocumentID} 41 -> ${tmpAdd.Refetch.Body.Total}; delete -> user43 ${tmpLive.Cache ? 'Stale then fresh' : tmpUser43.Body.Total}; undelete -> ${tmpUndelete.Refetch.Body.Total}; delete -> ${tmpDocumentsAfter.Envelope.Total}`);

		// ---- Lab forms (A): complete one of my started forms; re-open it
		let tmpLabA = await snapshot('LabFormsA');
		let tmpRows = await allRows(groupState('LabFormsA'), 'user42');
		let tmpFormsByIntake = await lookup('LabTrack', 'LabForm', 'IDMaterialIntake', libLookup.keysOf(tmpRows, 'IDMaterialIntake'), 'user42');
		let tmpStartedRow = tmpRows.find((pRow) => { return (tmpFormsByIntake[String(pRow.IDMaterialIntake)] || []).some((pForm) => { return libSelection.sameKey(pForm.IDLabFormType, pRow.IDLabFormType) && (pForm.Status === 'Pending'); }); });
		check('Lab forms: a Started work-list row with a Pending form of mine', !!tmpStartedRow);
		let tmpFound = await call('POST', '/api/LabTrack/1.0/Facet/LabForm/Records/0/1', { Clauses: [ libSelection.lookupClause('IDMaterialIntake', [ tmpStartedRow.IDMaterialIntake ]), libSelection.lookupClause('IDLabFormType', [ tmpStartedRow.IDLabFormType ]), libSelection.lookupClause('Status', [ 'Pending' ]) ] }, { Persona: 'user42' });
		let tmpForm = Array.isArray(tmpFound.Body) ? tmpFound.Body[0] : null;
		check('Lab forms: POST …/1.0/Facet/LabForm/Records/0/1 finds it (mine: owner-scoped)', !!tmpForm && (tmpForm.OwnerIDUser === 42) && (tmpForm.Status === 'Pending'), tmpForm);
		let tmpStartedBefore = countsOf(tmpLabA.Envelope, 'Started');
		let tmpUnaffectedLab = await snapshot('Books');
		let tmpComplete = await liveStep(tmpLive, 'Lab forms complete', 'LabTrack', 'LabForm',
			() => { return call('PUT', '/api/LabTrack/1.0/LabForm', { IDLabForm: tmpForm.IDLabForm, Status: 'Complete', CompletedDate: '2026-10-09 12:00:00' }, { Persona: 'user42' }); },
			tmpLabA, tmpUnaffectedLab);
		checkEqual('Lab forms complete: the row leaves the work list (237 -> 236), Started -1', [ tmpComplete.Refetch.Body ? tmpComplete.Refetch.Body.Total : null, entriesOf(countsOf(tmpComplete.Refetch.Body, 'Started')) ], [ tmpLabA.Envelope.Total - 1, entriesOf(withDeltas(tmpStartedBefore, { 1: -1 })) ]);
		let tmpReopenFrom = await snapshot('LabFormsA');
		let tmpReopen = await liveStep(tmpLive, 'Lab forms re-open', 'LabTrack', 'LabForm',
			() => { return call('PUT', '/api/LabTrack/1.0/LabForm', { IDLabForm: tmpForm.IDLabForm, Status: 'Pending', CompletedDate: null }, { Persona: 'user42' }); },
			tmpReopenFrom, null);
		checkEqual('Lab forms re-open: back to 237 with the same Started counts', [ tmpReopen.Refetch.Body ? tmpReopen.Refetch.Body.Total : null, entriesOf(countsOf(tmpReopen.Refetch.Body, 'Started')) ], [ tmpLabA.Envelope.Total, entriesOf(tmpStartedBefore) ]);
		console.log(`    Lab forms: complete form #${tmpForm.IDLabForm} (intake #${tmpForm.IDMaterialIntake}) ${tmpLabA.Envelope.Total} -> ${tmpComplete.Refetch.Body.Total}; re-open -> ${tmpReopen.Refetch.Body.Total}`);

		// ---- Bookstore explorer: a 5-star review on the first listed book; remove it
		let tmpBooks = await snapshot('Books');
		// The panel's rule: the first listed book that has no 5-star review yet (so the 5-star count moves).
		let tmpListed = (tmpBooks.Envelope.Records || []);
		let tmpReviews = await lookup('Bookstore', 'Review', 'IDBook', libLookup.keysOf(tmpListed, 'IDBook'), 'user42');
		let tmpBook = tmpListed.find((pRow) => { return !(tmpReviews[String(pRow.IDBook)] || []).some((pReview) => { return Number(pReview.Rating) === 5; }); }) || tmpListed[0];
		let tmpHadFive = (tmpReviews[String(tmpBook.IDBook)] || []).some((pReview) => { return Number(pReview.Rating) === 5; });
		check('Bookstore: a listed book without a 5-star review', !tmpHadFive);
		let tmpRatingBefore = countsOf(tmpBooks.Envelope, 'ReviewRating');
		let tmpFiveStarBefore = countsOf(tmpBooks.Envelope, 'HasFiveStar');
		let tmpUnaffectedBooks = await snapshot('Documents');
		let tmpReview = await liveStep(tmpLive, 'Bookstore add review', 'Bookstore', 'Review',
			() => { return call('POST', '/api/Bookstore/1.0/Review', { IDBook: tmpBook.IDBook, Rating: 5, Text: 'Five stars, from the smoke test.' }, { Persona: 'user42' }); },
			tmpBooks, tmpUnaffectedBooks);
		let tmpReviewID = tmpReview.Write.Body ? tmpReview.Write.Body.IDReview : null;
		check('Bookstore add review: the new review is in tenant 7 (stamped by the guard)', !!tmpReview.Write.Body && (tmpReview.Write.Body.IDTenant === 7) && (tmpReview.Write.Body.Rating === 5), tmpReview.Write.Body);
		let tmpFiveKeys = Object.keys(countsOf(tmpReview.Refetch.Body, 'HasFiveStar'));
		checkEqual('Bookstore add review: Total unchanged, books with a 5-star rating +1', [ tmpReview.Refetch.Body ? tmpReview.Refetch.Body.Total : null, entriesOf(countsOf(tmpReview.Refetch.Body, 'ReviewRating')) ], [ tmpBooks.Envelope.Total, entriesOf(withDeltas(tmpRatingBefore, { 5: 1 })) ]);
		check('Bookstore add review: the five-star split moved one book across', (Object.keys(tmpFiveStarBefore).length === 2) && (tmpFiveKeys.length === 2) && (JSON.stringify(entriesOf(countsOf(tmpReview.Refetch.Body, 'HasFiveStar'))) !== JSON.stringify(entriesOf(tmpFiveStarBefore))), [ tmpFiveStarBefore, countsOf(tmpReview.Refetch.Body, 'HasFiveStar') ]);
		let tmpRemoveFrom = await snapshot('Books');
		let tmpRemove = await liveStep(tmpLive, 'Bookstore remove review', 'Bookstore', 'Review',
			() => { return call('DELETE', `/api/Bookstore/1.0/Review/${tmpReviewID}`, null, { Persona: 'user42' }); },
			tmpRemoveFrom, null);
		checkEqual('Bookstore remove review: the rating and five-star counts are back', [ entriesOf(countsOf(tmpRemove.Refetch.Body, 'ReviewRating')), entriesOf(countsOf(tmpRemove.Refetch.Body, 'HasFiveStar')) ], [ entriesOf(tmpRatingBefore), entriesOf(tmpFiveStarBefore) ]);
		console.log(`    Bookstore: review #${tmpReviewID} on "${tmpBook.Title}" (had a 5-star: ${tmpHadFive}); removed`);

		if (tmpLive.Stream)
		{
			let tmpAll = [];
			[ tmpLive.User42, tmpLive.User81 ].forEach((pSet) => { Object.keys(pSet).forEach((pDomain) => { tmpAll = tmpAll.concat(pSet[pDomain].Events); }); });
			check('every stream event is ready / generation / model / closed', tmpAll.every((pEvent) => { return libChanges.EVENT_TYPES.indexOf(pEvent.Event) >= 0; }), tmpAll.map((pEvent) => { return pEvent.Event; }));
			checkEqual('user81 saw no generation of tenant 7\'s writes at all', [ 'ProjectTrack', 'LabTrack', 'Bookstore' ].map((pDomain) => { return tmpLive.User81[pDomain].Events.filter((pEvent) => { return pEvent.Event === 'generation'; }).length; }), [ 0, 0, 0 ]);
		}
		if (tmpLive.Wired)
		{
			let tmpStatus = await call('GET', '/api/Demo/Status');
			let tmpLiveStats = tmpStatus.Body.Domains.ProjectTrack.Live || {};
			check('/api/Demo/Status: each domain reports its Cache / Changes / SSE statistics', !!tmpLiveStats.Cache && (typeof(tmpLiveStats.Cache.Hits) === 'number') && (!tmpLive.Cache || (tmpLiveStats.Cache.Hits > 0)) && !!tmpLiveStats.Changes && !!tmpLiveStats.SSE, tmpLiveStats);
			console.log(`    ProjectTrack cache: ${tmpLiveStats.Cache.Hits} hits, ${tmpLiveStats.Cache.Misses} misses, ${tmpLiveStats.Cache.StaleHits} stale; ${tmpLiveStats.SSE ? tmpLiveStats.SSE.Connections : '?'} SSE connection(s)`);
		}
	}
	finally
	{
		if (tmpLive.Stream)
		{
			[ tmpLive.User42, tmpLive.User81 ].forEach((pSet) => { Object.keys(pSet).forEach((pDomain) => { pSet[pDomain].close(); }); });
			await sleep(100);
		}
	}
};

/**
 * The browser's provider (Pict-Provider-Facet), run in node against the demo: the same transport code, stream reader,
 * coalescing and Version cache as the page.
 *
 * @param {string} pPersona
 * @param {Record<string, any>} [pOptions] - provider options over the default configuration
 * @return {Record<string, any>} the provider
 */
const nodeProvider = (pPersona, pOptions) =>
{
	let libPict = require('pict');
	let libProviderFacet = require('../source/providers/Pict-Provider-Facet.js');
	let tmpPict = new libPict({ Product: `FacetingDemoSmoke-${pPersona}`, LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
	let tmpProvider = tmpPict.addProvider('Facet', Object.assign({}, libProviderFacet.default_configuration, { ChangesTransport: 'Fetch' }, pOptions || {}), libProviderFacet);
	tmpProvider.setEndpointPrefix((pDomain) => { return `http://127.0.0.1:${SMOKE_PORT}/api/${pDomain}`; });
	let tmpHeaders = {};
	if (pPersona !== 'anonymous')
	{
		tmpHeaders[libPersonas.HEADER] = pPersona;
	}
	tmpProvider.setRequestHeaders(() => { return tmpHeaders; });
	tmpProvider.setPrincipalKey(pPersona);
	Object.keys(libPages.Groups).forEach((pGroupHash) => { tmpProvider.defineGroup(libPages.Groups[pGroupHash]); });
	if (_BooksDescribed)
	{
		tmpProvider.applyDescribedFacets('Books', _BooksDescribed.Facets, _BooksDescribed.Panels, _BooksDescribed.Skipped);
	}
	return tmpProvider;
};

/**
 * provider.refresh as a promise (resolves with the group state).
 */
const providerRefresh = (pProvider, pGroupHash) =>
{
	return new Promise((fResolve) => { pProvider.refresh(pGroupHash, () => { fResolve(pProvider.group(pGroupHash)); }); });
};

const providerWrite = (pProvider, pDomain, pMethod, pPath, pBody, pGroupHash) =>
{
	return new Promise((fResolve) => { pProvider.write(pDomain, pMethod, pPath, pBody, { GroupHash: pGroupHash }, (pError, pResponse) => { fResolve(pResponse); }); });
};

const checkProviderLive = async () =>
{
	section('15. the browser provider in node (M4): Freshness, the change stream, coalesced refetch, writes, stale follow-up');
	let tmpProvider = nodeProvider('user42');
	let tmpVisible = [ 'Documents', 'Projects' ];
	tmpProvider.setGroupVisibility((pGroupHash) => { return tmpVisible.indexOf(pGroupHash) >= 0; });
	await providerRefresh(tmpProvider, 'Documents');
	await providerRefresh(tmpProvider, 'Projects');
	await providerRefresh(tmpProvider, 'LabFormsA');
	let tmpFirst = tmpProvider.exchanges().find((pExchange) => { return (pExchange.Kind === 'Query') && (pExchange.GroupHash === 'Documents'); });
	checkEqual('every Query asks for Freshness Bounded 5 s (the browser\'s body)', tmpFirst ? tmpFirst.Body.Freshness : null, { Mode: 'Bounded', MaxLagMS: 5000 });
	checkEqual('the provider answers as the page does (Documents 41, Projects 6, LabFormsA 237)', [ tmpProvider.group('Documents').Envelope.Total, tmpProvider.group('Projects').Envelope.Total, tmpProvider.group('LabFormsA').Envelope.Total ], [ 41, 6, 237 ]);
	let tmpStream = tmpProvider.subscribeChanges('ProjectTrack');
	await waitFor(() => { return [ 'Open', 'Closed' ].indexOf(tmpProvider.changeState('ProjectTrack').Status) >= 0 && ((tmpProvider.changeState('ProjectTrack').Status === 'Closed') || (tmpProvider.changeState('ProjectTrack').Events > 0)); }, 3000);
	let tmpLive = (tmpProvider.changeState('ProjectTrack').Status === 'Open');
	check('subscribeChanges keeps one stream per domain (a second call reuses it)', tmpProvider.subscribeChanges('ProjectTrack') === tmpProvider.changeState('ProjectTrack') && (tmpStream === tmpProvider.changeState('ProjectTrack')));
	if (!tmpLive)
	{
		let tmpState = tmpProvider.changeState('ProjectTrack');
		check('without a change stream the provider stops (Closed: Unavailable) instead of retrying', (tmpState.Status === 'Closed') && (tmpState.Reason === 'Unavailable'), tmpState);
	}
	else
	{
		check('the stream is Open after its ready event (fetch transport)', (tmpProvider.changeState('ProjectTrack').Transport === 'Fetch') && !!tmpProvider.changeState('ProjectTrack').NodeEpoch, tmpProvider.changeState('ProjectTrack'));
	}
	let tmpSeqBefore = tmpProvider.group('Documents').AnswerSeq;
	let tmpProjectsBefore = tmpProvider.group('Projects').AnswerSeq;
	let tmpLabBefore = tmpProvider.group('LabFormsA').AnswerSeq;
	let tmpWrite = await providerWrite(tmpProvider, 'ProjectTrack', 'POST', '/1.0/Document', { Title: 'Provider document', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: tmpProvider.group('Documents').Envelope.Records[0].IDProject }, 'Documents');
	check('provider.write: Ok, logged as a Write exchange, nothing cached', !!tmpWrite && tmpWrite.Ok && (tmpProvider.exchanges()[0].Kind === 'Write') && !tmpProvider.exchanges()[0].RequestHeaders['If-None-Match'], tmpWrite ? [ tmpWrite.Status, tmpWrite.Error ] : null);
	let tmpDocumentID = (tmpWrite && tmpWrite.Body) ? tmpWrite.Body.IDDocument : null;
	if (!tmpLive)
	{
		tmpProvider.refetchDomain('ProjectTrack', null, 'Refreshed after my write (no change stream)');
	}
	let tmpUpdated = await waitFor(() => { let tmpState = tmpProvider.group('Documents'); return (tmpState.AnswerSeq !== tmpSeqBefore) && (tmpState.Status === 'Ready'); }, 3000);
	let tmpDocuments = tmpProvider.group('Documents');
	check('the Documents group got a new answer with no request from the caller', tmpUpdated && (tmpDocuments.Envelope.Total === 42), [ tmpDocuments.AnswerSeq, tmpDocuments.Envelope ? tmpDocuments.Envelope.Total : null ]);
	let tmpRefetch = tmpProvider.exchanges().find((pExchange) => { return (pExchange.Kind === 'Query') && (pExchange.GroupHash === 'Documents') && !pExchange.Pending; });
	check('the refetch revalidated the cached answer (If-None-Match)', !!tmpRefetch && /^W\/"fv1:/.test(tmpRefetch.RequestHeaders['If-None-Match'] || ''), tmpRefetch ? tmpRefetch.RequestHeaders : null);
	if (tmpLive)
	{
		let tmpEvent = tmpProvider.exchanges().find((pExchange) => { return (pExchange.Kind === 'Change') && (pExchange.Event === 'generation') && pExchange.Summary && (pExchange.Summary.Entity === 'Document'); });
		check('the generation event is logged (Kind Change) with what it refetched', !!tmpEvent && (tmpEvent.Summary.Refetched.indexOf('Documents') >= 0), tmpEvent ? tmpEvent.Summary : null);
		checkEqual('the refetch carried MinSeq = the event\'s Seq and its trigger', [ tmpRefetch.Body.Freshness.MinSeq, tmpRefetch.Trigger ], [ tmpEvent ? tmpEvent.Summary.Seq : null, libChanges.triggerText('Document', tmpEvent ? tmpEvent.Summary.Seq : null) ]);
		checkEqual('the answer remembers the trigger and the server\'s Seq', [ tmpDocuments.LastAnswer.Trigger, !!libChanges.parseSeq(tmpDocuments.LastAnswer.Seq) || (tmpDocuments.LastAnswer.Seq === null) ], [ tmpRefetch.Trigger, true ]);
		let tmpProjects = tmpProvider.group('Projects');
		if (Array.isArray(tmpProjects.DependsOn))
		{
			check('Projects (DependsOn without Document) was not refetched', (tmpProjects.AnswerSeq === tmpProjectsBefore) && !tmpProjects.ChangedSince, [ tmpProjects.DependsOn, tmpProjects.AnswerSeq, tmpProjectsBefore ]);
		}
		else
		{
			check('Projects (no DependsOn from this server: any change may matter) was refetched', tmpProjects.AnswerSeq !== tmpProjectsBefore, [ tmpProjects.AnswerSeq, tmpProjectsBefore ]);
		}
		checkEqual('a group of another domain is untouched', tmpProvider.group('LabFormsA').AnswerSeq, tmpLabBefore);
		// A group of this domain that is not on screen is marked, then refetched when it is shown (isStale).
		tmpVisible = [ 'Projects' ];
		let tmpDocumentsSeq = tmpProvider.group('Documents').AnswerSeq;
		await providerWrite(tmpProvider, 'ProjectTrack', 'DELETE', `/1.0/Document/${tmpDocumentID}`, null, 'Documents');
		let tmpMarked = await waitFor(() => { return !!tmpProvider.group('Documents').ChangedSince; }, 2000);
		check('a change for a group that is not on screen marks it (ChangedSince) instead of refetching', tmpMarked && (tmpProvider.group('Documents').AnswerSeq === tmpDocumentsSeq) && tmpProvider.isStale('Documents'), tmpProvider.group('Documents').ChangedSince);
		tmpVisible = [ 'Documents', 'Projects' ];
		let tmpShown = await providerRefresh(tmpProvider, 'Documents');
		let tmpShownExchange = tmpProvider.exchanges().find((pExchange) => { return (pExchange.Kind === 'Query') && (pExchange.GroupHash === 'Documents'); });
		checkEqual('shown again: one refetch with the marked MinSeq, Total 41', [ tmpShown.Envelope.Total, !!libChanges.parseSeq(tmpShownExchange.Body.Freshness.MinSeq), tmpShown.ChangedSince ], [ 41, true, null ]);
	}
	else
	{
		await providerWrite(tmpProvider, 'ProjectTrack', 'DELETE', `/1.0/Document/${tmpDocumentID}`, null, 'Documents');
		let tmpBack = await providerRefresh(tmpProvider, 'Documents');
		checkEqual('Documents back to 41', tmpBack.Envelope.Total, 41);
	}
	tmpProvider.closeChanges();
	checkEqual('closeChanges: the stream is Closed by the client and forgotten', [ tmpProvider.changeState('ProjectTrack').Status, tmpProvider.changeState('ProjectTrack').Reason, Object.keys(tmpProvider._Streams).length ], [ 'Closed', tmpLive ? 'Client' : 'Client', 0 ]);

	if (tmpLive)
	{
		let tmpAnonymous = nodeProvider('anonymous');
		tmpAnonymous.subscribeChanges('Bookstore');
		await waitFor(() => { return tmpAnonymous.changeState('Bookstore').Status === 'Closed'; }, 2000);
		checkEqual('an anonymous stream stops (no reconnect) on the 401', [ tmpAnonymous.changeState('Bookstore').Status, tmpAnonymous.changeState('Bookstore').Reason, tmpAnonymous.changeState('Bookstore').Reconnects ], [ 'Closed', 'Unauthenticated', 0 ]);
		tmpAnonymous.closeChanges();
	}

	// Stale follow-up (needs the result cache): user43 reads E2 right after user42's write -> Stale, and the provider
	// asks again on its own until the answer is fresh.
	let tmpProbe = await query(groupState('Documents'), 'user42');
	if (tmpProbe.Headers['x-retold-facet-cache'] && (tmpProbe.Headers['x-retold-facet-cache'] !== 'Off'))
	{
		let tmpColleague = nodeProvider('user43', { StaleRefetchMS: 200 });
		let tmpAdded = await call('POST', '/api/ProjectTrack/1.0/Document', { Title: 'Stale probe', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: tmpDocuments.Envelope.Records[0].IDProject }, { Persona: 'user42' });
		let tmpRefreshed = await query(groupState('Documents'), 'user42');
		await call('DELETE', `/api/ProjectTrack/1.0/Document/${tmpAdded.Body.IDDocument}`, null, { Persona: 'user42' });
		let tmpStale = await providerRefresh(tmpColleague, 'Documents');
		checkEqual('user43\'s provider gets the Stale answer (and shows it as such)', [ tmpStale.LastAnswer.Stale, tmpStale.LastAnswer.CacheStatus, tmpStale.Envelope.Total ], [ true, 'Stale', tmpRefreshed.Body.Total ]);
		let tmpFresh = await waitFor(() => { let tmpState = tmpColleague.group('Documents'); return (tmpState.Status === 'Ready') && tmpState.LastAnswer && (tmpState.LastAnswer.Stale === false); }, 3000);
		let tmpFollow = tmpColleague.exchanges().find((pExchange) => { return (pExchange.Kind === 'Query') && (pExchange.GroupHash === 'Documents'); });
		check('…and asks again by itself until it is fresh (41)', tmpFresh && (tmpColleague.group('Documents').Envelope.Total === 41) && /^Stale answer/.test(tmpFollow.Trigger || ''), [ tmpColleague.group('Documents').LastAnswer, tmpFollow.Trigger ]);
	}
	else if (process.env.DEMO_REQUIRE_LIVE === '1')
	{
		check('DEMO_REQUIRE_LIVE=1: the result cache (stale follow-up)', false);
	}
	else
	{
		_Skipped.push('the provider\'s stale follow-up: the result cache is not on yet');
		console.log('    skipped: the stale follow-up (no result cache yet)');
	}
	console.log(`    provider in node: ${tmpLive ? 'stream Open, the Document write refetched Documents by itself' : 'no stream: refreshed directly'}; closed cleanly`);
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
				await checkChangesContract();
				await checkWriteGuards(tmpUser42);
				await checkLiveChanges();
				await checkProviderLive();
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
