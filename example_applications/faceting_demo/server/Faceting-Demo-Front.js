/**
 * Faceting-Demo-Front -- the ONE user-facing server (DEMO-SPEC §2.4): plain node:http on DEMO_HOST:DEMO_PORT
 * (127.0.0.1:19300) serving
 *
 *   GET  /, /<file>                           dist/ (index.html; MIME by extension; no path escapes dist/;
 *                                             /pict.min.js falls back to require.resolve('pict/dist/pict.min.js');
 *                                             dist/ missing -> a small "run npm run build" page, 503)
 *   GET  /api/Demo/Principals                 Faceting-Demo-Personas.publicList()
 *   GET  /api/Demo/Status                     { Provider, Scale, StartedAt, Domains: { <Domain>: { Fixture, Entities, LiveCounts, Definitions, … } } }
 *   GET|POST /api/<Domain>/1.0/Facet/<rest>   proxied to <harness.baseURL>/1.0/Facet/<rest> (+ query string)
 *   anything else under /api/                 404 { Error: { Code: 'DEMO_NOT_FOUND' } }
 *
 * Proxy rules: forward ONLY content-type, accept, if-none-match (and the body, ≤ 256 KiB, else 413
 * DEMO_BODY_TOO_LARGE); resolve X-Retold-Facet-Demo-Principal through personaFor(): a persona with a Tenant
 * adds x-facet-test-tenant / x-facet-test-user upstream, anything else forwards no session (anonymous).
 * Browser-supplied x-facet-test-* headers are never forwarded.  The response keeps status, body,
 * content-type, etag, cache-control, vary, x-retold-facet-* and adds X-Retold-Facet-Demo-Upstream
 * ('<METHOD> /1.0/Facet/…'), X-Retold-Facet-Demo-Session ('tenant=7; user=42' | 'anonymous') and
 * Server-Timing: upstream;dur=<ms>.  Upstream unreachable -> 502 { Error: { Code: 'DEMO_UPSTREAM_UNAVAILABLE' } }.
 *
 * Every JSON error this host produces has the service's error shape { Error: { Code, Status, Message, Detail? } },
 * so the client renders demo and service errors the same way.  No CORS: the browser only talks to this origin.
 * When bound to loopback (the default) the Host header must name a loopback host too (DNS-rebinding guard:
 * a page on another origin cannot point a hostname at 127.0.0.1 and drive the DEMO principal header).
 *
 * DEMO ONLY: the principal is chosen by a request header this host resolves to the harness's test session.
 * A real host resolves the principal from its own session.  Never deploy this.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libHttp = require('node:http');
const libFS = require('node:fs');
const libPath = require('node:path');

const libPersonas = require('./Faceting-Demo-Personas.js');

const MAX_BODY_BYTES = 256 * 1024;

// Upstream requests that take longer than this answer 504 DEMO_UPSTREAM_TIMEOUT (a Medium-scale query takes well under 1 s).
const UPSTREAM_TIMEOUT_MS = 60000;

const DOMAIN_NAMES = [ 'ProjectTrack', 'LabTrack', 'Bookstore' ];

// Request headers the proxy forwards (lower case); everything else the browser sends stays here.
const FORWARD_REQUEST_HEADERS = [ 'content-type', 'accept', 'if-none-match' ];

// Response headers the proxy keeps (plus every x-retold-facet-*).
const KEEP_RESPONSE_HEADERS = [ 'content-type', 'etag', 'cache-control', 'vary' ];

const UPSTREAM_TENANT_HEADER = 'x-facet-test-tenant';
const UPSTREAM_USER_HEADER = 'x-facet-test-user';

const DEMO_HEADER_LOWER = libPersonas.HEADER.toLowerCase();

const MIME_TYPES =
{
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon'
};

const LOOPBACK_HOSTNAMES = [ '127.0.0.1', 'localhost', '[::1]', '::1' ];

/**
 * Send a JSON answer.
 *
 * @param {import('node:http').ServerResponse} pResponse
 * @param {number} pStatus
 * @param {any} pPayload
 * @param {Record<string, string>} [pHeaders]
 */
const sendJSON = (pResponse, pStatus, pPayload, pHeaders) =>
{
	let tmpBody = JSON.stringify(pPayload);
	pResponse.writeHead(pStatus, Object.assign(
		{
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(tmpBody),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff'
		}, pHeaders || {}));
	pResponse.end(tmpBody);
};

/**
 * Send an error in the service's shape.
 *
 * @param {import('node:http').ServerResponse} pResponse
 * @param {number} pStatus
 * @param {string} pCode
 * @param {string} pMessage
 * @param {any} [pDetail]
 * @param {Record<string, string>} [pHeaders]
 */
const sendError = (pResponse, pStatus, pCode, pMessage, pDetail, pHeaders) =>
{
	let tmpError = { Code: pCode, Status: pStatus, Message: pMessage };
	if (typeof(pDetail) !== 'undefined')
	{
		tmpError.Detail = pDetail;
	}
	return sendJSON(pResponse, pStatus, { Error: tmpError }, pHeaders);
};

/**
 * The page served when dist/ has no build yet.
 *
 * @param {import('node:http').ServerResponse} pResponse
 */
const sendNotBuilt = (pResponse) =>
{
	let tmpBody = [
		'<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>Faceting Demo - not built</title>',
		'<style>body{font:15px/1.5 system-ui,sans-serif;margin:48px auto;max-width:640px;padding:0 16px;color:#1f2430;background:#f7f8fb}',
		'code{background:#e9ecf5;padding:2px 6px;border-radius:4px}</style></head><body>',
		'<h1>The browser bundle is not built yet</h1>',
		'<p>Run <code>npm run build</code> in <code>example_applications/faceting_demo</code>, then reload. ',
		'(<code>npm start</code> builds it on the first start unless <code>DEMO_SKIP_BUILD=1</code>.)</p>',
		'<p>The facet API is already up: try <code>/api/Demo/Status</code>.</p>',
		'</body></html>'
	].join('');
	pResponse.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(tmpBody), 'Cache-Control': 'no-store' });
	pResponse.end(tmpBody);
};

/**
 * Resolve pict.min.js (or its map) from the installed pict package (the fallback when dist/ lacks it).
 *
 * @param {string} pFileName - 'pict.min.js' | 'pict.min.js.map'
 * @return {string|null}
 */
const resolvePictFile = (pFileName) =>
{
	try
	{
		let tmpPict = require.resolve('pict/dist/pict.min.js');
		let tmpFile = libPath.join(libPath.dirname(tmpPict), pFileName);
		return libFS.existsSync(tmpFile) ? tmpFile : null;
	}
	catch (pError)
	{
		return null;
	}
};

/**
 * Stream one file with its MIME type.
 *
 * @param {import('node:http').IncomingMessage} pRequest
 * @param {import('node:http').ServerResponse} pResponse
 * @param {string} pFile - absolute path
 */
const sendFile = (pRequest, pResponse, pFile) =>
{
	libFS.stat(pFile,
		(pStatError, pStat) =>
		{
			if (pStatError || !pStat.isFile())
			{
				return sendError(pResponse, 404, 'DEMO_NOT_FOUND', 'No such file.', { Path: pRequest.url });
			}
			let tmpMime = MIME_TYPES[libPath.extname(pFile).toLowerCase()] || 'application/octet-stream';
			pResponse.writeHead(200,
				{
					'Content-Type': tmpMime,
					'Content-Length': pStat.size,
					// Rebuilds show up on reload: the browser revalidates every time.
					'Cache-Control': 'no-cache',
					'X-Content-Type-Options': 'nosniff'
				});
			if (pRequest.method === 'HEAD')
			{
				return pResponse.end();
			}
			let tmpStream = libFS.createReadStream(pFile);
			tmpStream.on('error', () => { pResponse.destroy(); });
			tmpStream.pipe(pResponse);
		});
};

/**
 * Serve dist/.
 *
 * @param {Record<string, any>} pContext
 * @param {import('node:http').IncomingMessage} pRequest
 * @param {import('node:http').ServerResponse} pResponse
 * @param {string} pPathname - URL pathname (still percent-encoded)
 */
const serveStatic = (pContext, pRequest, pResponse, pPathname) =>
{
	if ((pRequest.method !== 'GET') && (pRequest.method !== 'HEAD'))
	{
		return sendError(pResponse, 405, 'DEMO_METHOD_NOT_ALLOWED', 'Static files answer GET and HEAD only.', undefined, { 'Allow': 'GET, HEAD' });
	}
	let tmpDecoded = null;
	try
	{
		tmpDecoded = decodeURIComponent(pPathname);
	}
	catch (pError)
	{
		return sendError(pResponse, 400, 'DEMO_BAD_PATH', 'The path is not valid percent-encoding.');
	}
	if ((tmpDecoded.indexOf('\0') >= 0) || (tmpDecoded.indexOf('\\') >= 0))
	{
		return sendError(pResponse, 404, 'DEMO_NOT_FOUND', 'No such file.');
	}
	let tmpRelative = (tmpDecoded === '/') ? 'index.html' : tmpDecoded.replace(/^\/+/, '');
	let tmpDistRoot = pContext.DistRoot;
	let tmpFile = libPath.resolve(tmpDistRoot, tmpRelative);
	// Stay inside dist/ (path.resolve folds every '..').
	if ((tmpFile !== tmpDistRoot) && (tmpFile.indexOf(tmpDistRoot + libPath.sep) !== 0))
	{
		return sendError(pResponse, 404, 'DEMO_NOT_FOUND', 'No such file.');
	}
	if (libFS.existsSync(tmpFile) && libFS.statSync(tmpFile).isFile())
	{
		return sendFile(pRequest, pResponse, tmpFile);
	}
	// pict.min.js (and its map) straight from the installed package when dist/ lacks them.
	if ((tmpRelative === 'pict.min.js') || (tmpRelative === 'pict.min.js.map'))
	{
		let tmpPict = resolvePictFile(tmpRelative);
		if (tmpPict)
		{
			return sendFile(pRequest, pResponse, tmpPict);
		}
	}
	if (tmpRelative === 'favicon.ico')
	{
		// No icon; answer empty rather than 404 (keeps the browser console clean).
		pResponse.writeHead(204, { 'Cache-Control': 'max-age=86400' });
		return pResponse.end();
	}
	if (!libFS.existsSync(libPath.join(tmpDistRoot, 'index.html')))
	{
		return sendNotBuilt(pResponse);
	}
	return sendError(pResponse, 404, 'DEMO_NOT_FOUND', 'No such file.', { Path: tmpDecoded });
};

/**
 * Read the whole request body (≤ MAX_BODY_BYTES).
 *
 * @param {import('node:http').IncomingMessage} pRequest
 * @param {(pError?: Error & { TooLarge?: boolean }, pBody?: Buffer) => void} fCallback
 */
const readBody = (pRequest, fCallback) =>
{
	let tmpChunks = [];
	let tmpBytes = 0;
	let tmpDone = false;
	let fFinish = (pError, pBody) =>
	{
		if (tmpDone)
		{
			return;
		}
		tmpDone = true;
		return fCallback(pError, pBody);
	};
	let tmpDeclared = parseInt(pRequest.headers['content-length'], 10);
	if (!isNaN(tmpDeclared) && (tmpDeclared > MAX_BODY_BYTES))
	{
		let tmpError = new Error(`The request body exceeds ${MAX_BODY_BYTES} bytes.`);
		tmpError.TooLarge = true;
		// Drain (do not buffer) so the 413 can still be read by the client.
		pRequest.resume();
		return fFinish(tmpError);
	}
	pRequest.on('data',
		(pChunk) =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpBytes += pChunk.length;
			if (tmpBytes > MAX_BODY_BYTES)
			{
				let tmpError = new Error(`The request body exceeds ${MAX_BODY_BYTES} bytes.`);
				tmpError.TooLarge = true;
				tmpChunks = [];
				return fFinish(tmpError);
			}
			tmpChunks.push(pChunk);
		});
	pRequest.on('end', () => { fFinish(null, Buffer.concat(tmpChunks)); });
	pRequest.on('error', (pError) => { fFinish(pError); });
};

/**
 * The upstream session of a request: the persona the DEMO header names, or null (anonymous).
 *
 * @param {import('node:http').IncomingMessage} pRequest
 * @return {Record<string, any>|null}
 */
const sessionPersona = (pRequest) =>
{
	let tmpKey = pRequest.headers[DEMO_HEADER_LOWER];
	let tmpPersona = libPersonas.personaFor(Array.isArray(tmpKey) ? tmpKey[0] : tmpKey);
	if (!tmpPersona || (typeof(tmpPersona.Tenant) !== 'number') || (typeof(tmpPersona.User) !== 'number'))
	{
		return null;
	}
	return tmpPersona;
};

/**
 * Proxy /api/<Domain>/1.0/Facet/<rest> to the domain's harness.
 *
 * @param {Record<string, any>} pContext
 * @param {import('node:http').IncomingMessage} pRequest
 * @param {import('node:http').ServerResponse} pResponse
 * @param {string} pDomain
 * @param {string} pUpstreamPath - '/1.0/Facet/…' (percent-encoding kept)
 * @param {string} pSearch - '' or '?…'
 */
const proxyFacet = (pContext, pRequest, pResponse, pDomain, pUpstreamPath, pSearch) =>
{
	let tmpHarness = pContext.Domains[pDomain];
	if (!tmpHarness || (typeof(tmpHarness.baseURL) !== 'string'))
	{
		return sendError(pResponse, 502, 'DEMO_UPSTREAM_UNAVAILABLE', `The ${pDomain} domain is not running.`, { Domain: pDomain });
	}
	let tmpMethod = pRequest.method;
	readBody(pRequest,
		(pReadError, pBody) =>
		{
			if (pReadError)
			{
				if (pReadError.TooLarge)
				{
					return sendError(pResponse, 413, 'DEMO_BODY_TOO_LARGE', pReadError.message, { MaxBytes: MAX_BODY_BYTES }, { 'Connection': 'close' });
				}
				return sendError(pResponse, 400, 'DEMO_BAD_REQUEST', `The request body could not be read: ${pReadError.message}`);
			}
			let tmpHeaders = {};
			FORWARD_REQUEST_HEADERS.forEach(
				(pHeader) =>
				{
					if (typeof(pRequest.headers[pHeader]) === 'string')
					{
						tmpHeaders[pHeader] = pRequest.headers[pHeader];
					}
				});
			let tmpPersona = sessionPersona(pRequest);
			if (tmpPersona)
			{
				tmpHeaders[UPSTREAM_TENANT_HEADER] = String(tmpPersona.Tenant);
				tmpHeaders[UPSTREAM_USER_HEADER] = String(tmpPersona.User);
			}
			let tmpHasBody = (tmpMethod === 'POST');
			if (tmpHasBody)
			{
				tmpHeaders['content-length'] = String(pBody.length);
			}
			let tmpUpstreamURL = new URL(`${pUpstreamPath}${pSearch}`, tmpHarness.baseURL);
			let tmpStarted = process.hrtime.bigint();
			let tmpAnswered = false;
			let tmpUpstream = libHttp.request(
				{
					protocol: tmpUpstreamURL.protocol,
					hostname: tmpUpstreamURL.hostname,
					port: tmpUpstreamURL.port,
					method: tmpMethod,
					path: `${tmpUpstreamURL.pathname}${tmpUpstreamURL.search}`,
					headers: tmpHeaders,
					timeout: UPSTREAM_TIMEOUT_MS
				},
				(pUpstreamResponse) =>
				{
					let tmpChunks = [];
					pUpstreamResponse.on('data', (pChunk) => { tmpChunks.push(pChunk); });
					pUpstreamResponse.on('error',
						(pError) =>
						{
							if (tmpAnswered)
							{
								return;
							}
							tmpAnswered = true;
							return sendError(pResponse, 502, 'DEMO_UPSTREAM_UNAVAILABLE', `The ${pDomain} domain broke off its answer: ${pError.message}`, { Domain: pDomain });
						});
					pUpstreamResponse.on('end',
						() =>
						{
							if (tmpAnswered)
							{
								return;
							}
							tmpAnswered = true;
							let tmpElapsedMS = Number(process.hrtime.bigint() - tmpStarted) / 1e6;
							let tmpOut = {};
							Object.keys(pUpstreamResponse.headers).forEach(
								(pHeader) =>
								{
									let tmpLower = pHeader.toLowerCase();
									if ((KEEP_RESPONSE_HEADERS.indexOf(tmpLower) >= 0) || (tmpLower.indexOf('x-retold-facet-') === 0))
									{
										tmpOut[pHeader] = pUpstreamResponse.headers[pHeader];
									}
								});
							// The answer depends on the DEMO header too: say so, so no HTTP cache shares it across personas.
							let tmpVaryKey = Object.keys(tmpOut).find((pHeader) => { return pHeader.toLowerCase() === 'vary'; });
							let tmpVary = tmpVaryKey ? String(tmpOut[tmpVaryKey]) : '';
							if (tmpVaryKey)
							{
								delete tmpOut[tmpVaryKey];
							}
							tmpOut['Vary'] = (tmpVary.length > 0) ? `${tmpVary}, ${libPersonas.HEADER}` : libPersonas.HEADER;
							tmpOut['X-Retold-Facet-Demo-Upstream'] = `${tmpMethod} ${pUpstreamPath}`;
							tmpOut['X-Retold-Facet-Demo-Session'] = tmpPersona ? `tenant=${tmpPersona.Tenant}; user=${tmpPersona.User}` : 'anonymous';
							tmpOut['Server-Timing'] = `upstream;dur=${tmpElapsedMS.toFixed(1)}`;
							tmpOut['X-Content-Type-Options'] = 'nosniff';
							let tmpStatus = pUpstreamResponse.statusCode;
							if ((tmpStatus === 304) || (tmpStatus === 204) || (tmpMethod === 'HEAD'))
							{
								pResponse.writeHead(tmpStatus, tmpOut);
								return pResponse.end();
							}
							let tmpBody = Buffer.concat(tmpChunks);
							tmpOut['Content-Length'] = tmpBody.length;
							pResponse.writeHead(tmpStatus, tmpOut);
							return pResponse.end(tmpBody);
						});
				});
			let tmpTimedOut = false;
			tmpUpstream.on('timeout',
				() =>
				{
					tmpTimedOut = true;
					tmpUpstream.destroy(new Error(`no answer within ${UPSTREAM_TIMEOUT_MS} ms`));
				});
			tmpUpstream.on('error',
				(pError) =>
				{
					if (tmpAnswered || pResponse.headersSent)
					{
						return;
					}
					tmpAnswered = true;
					if (pResponse.destroyed)
					{
						return;
					}
					if (tmpTimedOut)
					{
						return sendError(pResponse, 504, 'DEMO_UPSTREAM_TIMEOUT', `The ${pDomain} domain did not answer within ${UPSTREAM_TIMEOUT_MS} ms.`, { Domain: pDomain });
					}
					return sendError(pResponse, 502, 'DEMO_UPSTREAM_UNAVAILABLE', `The ${pDomain} domain did not answer: ${pError.message}`, { Domain: pDomain });
				});
			// The browser gave up (AbortController on a superseded request): stop the upstream work too.
			pResponse.on('close',
				() =>
				{
					if (!pResponse.writableFinished && !tmpAnswered)
					{
						tmpAnswered = true;
						tmpUpstream.destroy();
					}
				});
			if (tmpHasBody)
			{
				tmpUpstream.end(pBody);
			}
			else
			{
				tmpUpstream.end();
			}
		});
};

/**
 * Is the Host header acceptable?  On a loopback bind only loopback host names (any port) are.
 *
 * @param {Record<string, any>} pContext
 * @param {import('node:http').IncomingMessage} pRequest
 * @return {boolean}
 */
const hostAllowed = (pContext, pRequest) =>
{
	if (!pContext.LoopbackOnly)
	{
		return true;
	}
	let tmpHost = (typeof(pRequest.headers.host) === 'string') ? pRequest.headers.host.toLowerCase() : '';
	let tmpHostname = tmpHost.replace(/:\d+$/, '');
	return (LOOPBACK_HOSTNAMES.indexOf(tmpHostname) >= 0);
};

/**
 * Route one request (static, demo endpoints, facet proxy).
 *
 * @param {Record<string, any>} pContext
 * @param {import('node:http').IncomingMessage} pRequest
 * @param {import('node:http').ServerResponse} pResponse
 */
const route = (pContext, pRequest, pResponse) =>
{
	let tmpURL = null;
	try
	{
		tmpURL = new URL(pRequest.url, 'http://demo.invalid');
	}
	catch (pError)
	{
		return sendError(pResponse, 400, 'DEMO_BAD_PATH', 'The request URL is not valid.');
	}
	if (!hostAllowed(pContext, pRequest))
	{
		return sendError(pResponse, 421, 'DEMO_HOST_NOT_ALLOWED', 'This demo host only answers loopback host names (127.0.0.1, localhost, [::1]).', { Host: pRequest.headers.host || null });
	}
	let tmpPathname = tmpURL.pathname;
	if ((tmpPathname !== '/api') && (tmpPathname.indexOf('/api/') !== 0))
	{
		return serveStatic(pContext, pRequest, pResponse, tmpPathname);
	}

	// ---- The demo's own endpoints
	if ((tmpPathname === '/api/Demo/Principals') || (tmpPathname === '/api/Demo/Status'))
	{
		if (pRequest.method !== 'GET')
		{
			return sendError(pResponse, 405, 'DEMO_METHOD_NOT_ALLOWED', `${tmpPathname} answers GET only.`, undefined, { 'Allow': 'GET' });
		}
		if (tmpPathname === '/api/Demo/Principals')
		{
			return sendJSON(pResponse, 200, libPersonas.publicList());
		}
		let tmpStatus = null;
		try
		{
			tmpStatus = pContext.Status();
		}
		catch (pError)
		{
			return sendError(pResponse, 500, 'DEMO_STATUS_FAILED', `The demo status could not be built: ${pError.message}`);
		}
		return sendJSON(pResponse, 200, tmpStatus);
	}

	// ---- The facet proxy: /api/<Domain>/1.0/Facet[/<rest>]
	let tmpMatch = /^\/api\/([^/]+)(\/1\.0\/Facet(?:\/.*)?)$/.exec(tmpPathname);
	if (!tmpMatch)
	{
		return sendError(pResponse, 404, 'DEMO_NOT_FOUND', 'No such demo API route. The facet API is under /api/<Domain>/1.0/Facet/…', { Path: tmpPathname, Domains: DOMAIN_NAMES.slice() });
	}
	let tmpDomain = tmpMatch[1];
	let tmpUpstreamPath = tmpMatch[2];
	if (DOMAIN_NAMES.indexOf(tmpDomain) < 0)
	{
		return sendError(pResponse, 404, 'DEMO_UNKNOWN_DOMAIN', `Unknown demo domain [${tmpDomain}].`, { Domains: DOMAIN_NAMES.slice() });
	}
	// Never let a dot segment (raw or percent-encoded) walk out of /1.0/Facet/ upstream.
	let tmpSegments = tmpUpstreamPath.split('/');
	for (let i = 0; i < tmpSegments.length; i++)
	{
		let tmpSegment = null;
		try
		{
			tmpSegment = decodeURIComponent(tmpSegments[i]);
		}
		catch (pError)
		{
			return sendError(pResponse, 400, 'DEMO_BAD_PATH', 'The path is not valid percent-encoding.');
		}
		if ((tmpSegment === '.') || (tmpSegment === '..') || (tmpSegment.indexOf('/') >= 0) || (tmpSegment.indexOf('\\') >= 0))
		{
			return sendError(pResponse, 400, 'DEMO_BAD_PATH', 'Dot segments and encoded slashes are not allowed in facet paths.');
		}
	}
	if ((pRequest.method !== 'GET') && (pRequest.method !== 'POST'))
	{
		return sendError(pResponse, 405, 'DEMO_METHOD_NOT_ALLOWED', 'The facet proxy forwards GET and POST only.', undefined, { 'Allow': 'GET, POST' });
	}
	return proxyFacet(pContext, pRequest, pResponse, tmpDomain, tmpUpstreamPath, tmpURL.search || '');
};

/**
 * Create (not start) the front server.
 *
 * @param {{ DistRoot: string, Domains: Record<string, Record<string, any>>, Status: () => Record<string, any>, LoopbackOnly?: boolean }} pOptions
 *        Domains: { <Domain>: harness } (harness.baseURL is the upstream origin); LoopbackOnly (default true)
 *        enforces a loopback Host header
 * @return {import('node:http').Server}
 */
const create = (pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpContext = (
		{
			DistRoot: libPath.resolve(tmpOptions.DistRoot || libPath.resolve(__dirname, '..', 'dist')),
			Domains: tmpOptions.Domains || {},
			Status: (typeof(tmpOptions.Status) === 'function') ? tmpOptions.Status : () => { return {}; },
			LoopbackOnly: (tmpOptions.LoopbackOnly !== false)
		});
	let tmpServer = libHttp.createServer(
		(pRequest, pResponse) =>
		{
			try
			{
				return route(tmpContext, pRequest, pResponse);
			}
			catch (pError)
			{
				if (!pResponse.headersSent)
				{
					return sendError(pResponse, 500, 'DEMO_INTERNAL', `The demo host failed: ${pError.message}`);
				}
				pResponse.destroy();
			}
		});
	tmpServer.DemoContext = tmpContext;
	return tmpServer;
};

module.exports = (
	{
		MAX_BODY_BYTES: MAX_BODY_BYTES,
		UPSTREAM_TIMEOUT_MS: UPSTREAM_TIMEOUT_MS,
		DOMAIN_NAMES: DOMAIN_NAMES,
		FORWARD_REQUEST_HEADERS: FORWARD_REQUEST_HEADERS,
		KEEP_RESPONSE_HEADERS: KEEP_RESPONSE_HEADERS,
		MIME_TYPES: MIME_TYPES,
		create: create,
		Personas: libPersonas
	});
