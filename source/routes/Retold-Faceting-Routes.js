/**
 * Retold Faceting - Routes
 *
 * Public facet routes under RoutePrefix (default /1.0/Facet; D-17), self-gated by the service:
 *
 *   POST /1.0/Facet/:Entity/Query        (route-local JSON-only body reader, Limits.MaxBodyBytes)
 *   POST /1.0/Facet/:Entity/Records      (internal-contracts §28.1; body Records: { Begin, Cap, Sort })
 *   POST /1.0/Facet/:Entity/Records/:Begin/:Cap   (the pict-section-recordset FilterEndpointOverride page)
 *   POST /1.0/Facet/:Entity/Records/Count         (… and its count: { Count })
 *   POST /1.0/Facet/:Entity/Keys         ({ Entity, Keys, Count, Truncated, Version })
 *   POST /1.0/Facet/:Entity/Scope/:Scope/Query | /Records | /Records/:Begin/:Cap | /Records/Count
 *                                        (the path scope is prepended to Scopes, its parameters from
 *                                        the top-level Params)
 *   GET  /1.0/Facet/Describe
 *   GET  /1.0/Facet/Describe/:Entity     (design form, 02 §2.1)
 *   GET  /1.0/Facet/:Entity/Describe     (M1 brief form; same handler)
 *   GET  /1.0/Facet/Changes              (M4: the SSE change stream, mounted through RetoldFacetingSSE)
 *
 * The Records routes are POST only: pict-section-recordset posts { Clauses, Experience } to
 * `${FilterEndpointOverride}/${Offset}/${PageSize}` and `…/Count` (internal-contracts §36.1).
 *
 * Restify discipline: handlers never return a promise and call fNext exactly once.
 * Response headers (02 §8): ETag W/"fv1:<Version>", Cache-Control private, no-cache,
 * Vary Cookie, Authorization, X-Retold-Facet-Contract 1.
 *
 * The Query body is read by the route itself, never by restify's combined bodyParser: only an
 * application/json (or *\/*+json) Content-Type is accepted, so multipart uploads never reach a temp
 * file and an HTML form (urlencoded / text/plain, no CORS preflight) can never trigger a query with
 * a user's cookies; the body is counted while it streams and refused past Limits.MaxBodyBytes.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');

class RetoldFacetingRoutes extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingRoutes';

		this._Connected = false;
	}

	/**
	 * Mount the routes on an Orator service server.
	 *
	 * @param {any} pServiceServer - fable.OratorServiceServer
	 * @return {boolean} true when mounted (idempotent)
	 */
	connect(pServiceServer)
	{
		if (this._Connected || !pServiceServer)
		{
			return this._Connected;
		}
		let tmpPrefix = this.options.RoutePrefix;

		pServiceServer.post(`${tmpPrefix}/:Entity/Query`,
			this.bodyParser(pServiceServer),
			this.handleQuery.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Records`,
			this.bodyParser(pServiceServer),
			this.handleRecords.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Records/Count`,
			this.bodyParser(pServiceServer),
			this.handleCount.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Records/:Begin/:Cap`,
			this.bodyParser(pServiceServer),
			this.handleRecords.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Keys`,
			this.bodyParser(pServiceServer),
			this.handleKeys.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Scope/:Scope/Query`,
			this.bodyParser(pServiceServer),
			this.handleQuery.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Scope/:Scope/Records`,
			this.bodyParser(pServiceServer),
			this.handleRecords.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Scope/:Scope/Records/Count`,
			this.bodyParser(pServiceServer),
			this.handleCount.bind(this));
		pServiceServer.post(`${tmpPrefix}/:Entity/Scope/:Scope/Records/:Begin/:Cap`,
			this.bodyParser(pServiceServer),
			this.handleRecords.bind(this));
		pServiceServer.get(`${tmpPrefix}/Describe`, this.handleDescribe.bind(this));
		pServiceServer.get(`${tmpPrefix}/Describe/:Entity`, this.handleDescribe.bind(this));
		pServiceServer.get(`${tmpPrefix}/:Entity/Describe`, this.handleDescribe.bind(this));
		// M4 (internal-contracts §44.10, §46.1): GET <RoutePrefix>/Changes when SSE.Enabled.
		if (this.fable.RetoldFacetingSSE && this.options.SSE && (this.options.SSE.Enabled !== false))
		{
			this.fable.RetoldFacetingSSE.connect(pServiceServer);
		}

		this._Connected = true;
		return true;
	}

	/**
	 * Is this Content-Type JSON (application/json, or a structured '+json' type)?
	 *
	 * @param {any} pContentType
	 * @return {boolean}
	 */
	isJSONContentType(pContentType)
	{
		if (typeof(pContentType) !== 'string')
		{
			return false;
		}
		let tmpMediaType = pContentType.split(';')[0].trim().toLowerCase();
		return (tmpMediaType === 'application/json') || /^[a-z0-9!#$&^_.-]+\/[a-z0-9!#$&^_.-]+\+json$/.test(tmpMediaType);
	}

	/**
	 * The route-local JSON body reader (Limits.MaxBodyBytes), with its failures answered in the
	 * facet error shape (400 FACET_REQUEST_INVALID, internal-contracts §3, L1), never the server's
	 * own error format:
	 *
	 *   - a Content-Type other than JSON → Reason 'UnsupportedContentType' (nothing is read);
	 *   - a body over the limit (by Content-Length, or counted while streaming) → 'BodyTooLarge';
	 *   - a body that is not JSON → 'BodyNotJSON'.
	 *
	 * A body some host middleware already parsed (pRequest.body set) is used as is, after the same
	 * Content-Type check.
	 *
	 * @param {any} pServiceServer - unused (kept for the route-chain signature)
	 * @return {(pRequest: any, pResponse: any, fNext: Function) => void}
	 */
	bodyParser(pServiceServer)
	{
		let tmpMaxBytes = this.options.Limits.MaxBodyBytes;
		return (pRequest, pResponse, fNext) =>
		{
			let tmpFinished = false;
			let fRefuse = (pReason, pMessage) =>
			{
				if (tmpFinished)
				{
					return;
				}
				tmpFinished = true;
				let tmpDetail = (pReason === 'BodyTooLarge') ? { Reason: pReason, Limit: 'MaxBodyBytes', Max: tmpMaxBytes } : { Reason: pReason };
				let tmpResponse = libFacetErrors.toResponse(libFacetErrors.create('FACET_REQUEST_INVALID', pMessage, tmpDetail));
				// Discard (never store) what the client is still sending, so it can read the answer;
				// a sender that keeps going past a few limits' worth is cut off.
				if (typeof(pRequest.on) === 'function')
				{
					let tmpDrained = 0;
					pRequest.on('data',
						(pChunk) =>
						{
							tmpDrained += pChunk.length;
							if ((tmpDrained > (tmpMaxBytes * 4)) && (typeof(pRequest.destroy) === 'function'))
							{
								pRequest.destroy();
							}
						});
					if (typeof(pRequest.resume) === 'function')
					{
						pRequest.resume();
					}
				}
				this.setStandardHeaders(pResponse);
				pResponse.send(tmpResponse.Status, tmpResponse.Body);
				// Stop the chain: the query handler must not run.
				return fNext(false);
			};
			let fAccept = (pBody) =>
			{
				if (tmpFinished)
				{
					return;
				}
				tmpFinished = true;
				pRequest.body = pBody;
				return fNext();
			};

			let tmpHeaders = pRequest.headers || {};
			if (!this.isJSONContentType(tmpHeaders['content-type']))
			{
				return fRefuse('UnsupportedContentType', 'The request body must be application/json.');
			}
			if ((typeof(pRequest.body) !== 'undefined') && (pRequest.body !== null))
			{
				// Already parsed upstream.
				if ((typeof(pRequest.body) === 'string') || Buffer.isBuffer(pRequest.body))
				{
					try
					{
						return fAccept(JSON.parse(String(pRequest.body)));
					}
					catch (pParseError)
					{
						return fRefuse('BodyNotJSON', 'The request body is not valid JSON.');
					}
				}
				return fAccept(pRequest.body);
			}
			let tmpDeclared = Number(tmpHeaders['content-length']);
			if (Number.isFinite(tmpDeclared) && (tmpDeclared > tmpMaxBytes))
			{
				return fRefuse('BodyTooLarge', 'The request body is too large.');
			}
			if ((typeof(pRequest.on) !== 'function'))
			{
				return fRefuse('BodyNotJSON', 'The request body is not valid JSON.');
			}
			let tmpChunks = [];
			let tmpBytes = 0;
			pRequest.on('data',
				(pChunk) =>
				{
					if (tmpFinished)
					{
						return;
					}
					tmpBytes += pChunk.length;
					if (tmpBytes > tmpMaxBytes)
					{
						tmpChunks = [];
						return fRefuse('BodyTooLarge', 'The request body is too large.');
					}
					tmpChunks.push(pChunk);
				});
			pRequest.on('error',
				() =>
				{
					return fRefuse('BodyNotJSON', 'The request body is not valid JSON.');
				});
			pRequest.on('end',
				() =>
				{
					if (tmpFinished)
					{
						return;
					}
					let tmpBody;
					try
					{
						tmpBody = JSON.parse(Buffer.concat(tmpChunks).toString('utf8'));
					}
					catch (pParseError)
					{
						return fRefuse('BodyNotJSON', 'The request body is not valid JSON.');
					}
					return fAccept(tmpBody);
				});
		};
	}

	/**
	 * Standard response headers (02 §8).
	 *
	 * @param {any} pResponse
	 * @param {string} [pVersion]
	 */
	setStandardHeaders(pResponse, pVersion)
	{
		pResponse.header('Cache-Control', 'private, no-cache');
		pResponse.header('Vary', 'Cookie, Authorization');
		pResponse.header('X-Retold-Facet-Contract', String(libFacetRequest.CONTRACT_VERSION));
		if (typeof(pVersion) === 'string')
		{
			pResponse.header('ETag', `W/"${pVersion}"`);
		}
	}

	/**
	 * The M4 response headers (internal-contracts §44.8): X-Retold-Facet-Seq (the Seq the answer
	 * covers; Freshness.SeqHeader, 'Auto' = only on a host without a scope policy, never when no change
	 * source is installed), and — only with Cache.ExposeStatus — on a Query X-Retold-Facet-Cache
	 * (Off | Bypass | Miss | Hit | Stale | NotModified) and X-Retold-Facet-Freshness (the effective
	 * mode, '; upgraded=<why>' when read-your-writes or a MinSeq upgraded it).
	 *
	 * @param {any} pResponse
	 * @param {Record<string, any>} [pMeta]
	 * @param {boolean} pQuery - a Query answer (the Cache and Freshness headers)
	 */
	setChangeHeaders(pResponse, pMeta, pQuery)
	{
		let tmpMeta = pMeta || {};
		let tmpService = this.fable.RetoldFacetingService;
		if (tmpService && (typeof(tmpMeta.Seq) === 'string') && (tmpMeta.Seq.length > 0) && tmpService.seqHeaderEnabled())
		{
			pResponse.header('X-Retold-Facet-Seq', tmpMeta.Seq);
		}
		if (!pQuery || !tmpService || !tmpService.exposeCacheStatus())
		{
			// Cache.ExposeStatus off (the default): which answers came from an entry, and whether this
			// principal's freshness was upgraded, stay server-side (pMeta) — S9.
			return;
		}
		if (tmpMeta.Cache && (typeof(tmpMeta.Cache.Status) === 'string'))
		{
			pResponse.header('X-Retold-Facet-Cache', tmpMeta.Cache.Status);
		}
		if (tmpMeta.Freshness && (typeof(tmpMeta.Freshness.Mode) === 'string'))
		{
			pResponse.header('X-Retold-Facet-Freshness', tmpMeta.Freshness.Upgrade ? `${tmpMeta.Freshness.Mode}; upgraded=${tmpMeta.Freshness.Upgrade}` : tmpMeta.Freshness.Mode);
		}
	}

	/**
	 * X-Retold-Facet-Scope-Repaired: 1 when ScopeGuard Repair mode re-applied a missing policy
	 * predicate on any capture of the answer (06 §3.3).
	 *
	 * @param {any} pResponse
	 * @param {Record<string, any>} [pMeta]
	 */
	setRepairedHeader(pResponse, pMeta)
	{
		if (pMeta && pMeta.ScopeRepaired)
		{
			pResponse.header('X-Retold-Facet-Scope-Repaired', '1');
		}
	}

	/**
	 * Send a whole-request error.
	 *
	 * @param {any} pResponse
	 * @param {any} pError
	 * @param {Function} fNext
	 */
	sendError(pResponse, pError, fNext)
	{
		if (!libFacetErrors.isFacetError(pError))
		{
			this.fable.log.error(`Retold Faceting route error: ${(pError && pError.message) ? pError.message : pError}`);
		}
		else if ((pError.Status >= 500) && (pError.message !== libFacetErrors.CODES[pError.Code].Message))
		{
			// The client gets the generic message (06 §11); the specific one is ours to log.
			this.fable.log.error(`Retold Faceting ${pError.Code}: ${pError.message}`);
		}
		let tmpResponse = libFacetErrors.toResponse(pError);
		this.setStandardHeaders(pResponse);
		pResponse.send(tmpResponse.Status, tmpResponse.Body);
		return fNext();
	}

	/**
	 * POST /1.0/Facet/:Entity/Query
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleQuery(pRequest, pResponse, fNext)
	{
		let tmpService = this.fable.RetoldFacetingService;
		if (!tmpService)
		{
			this.sendError(pResponse, libFacetErrors.create('FACET_INTERNAL'), fNext);
			return;
		}
		let tmpEntity = this.routeEntity(pRequest);
		tmpService.query(tmpEntity, this.routeBody(pRequest, null), pRequest,
			(pError, pEnvelope, pMeta) =>
			{
				if (pError)
				{
					return this.sendError(pResponse, pError, fNext);
				}
				let tmpMeta = pMeta || {};
				if (tmpMeta.NotModified === true)
				{
					// M4 (internal-contracts §44.3 step 4): decided before anything executed.
					this.setStandardHeaders(pResponse, tmpMeta.Version);
					this.setChangeHeaders(pResponse, tmpMeta, true);
					pResponse.send(304);
					return fNext();
				}
				this.setStandardHeaders(pResponse, pEnvelope.Version);
				this.setRepairedHeader(pResponse, tmpMeta);
				this.setChangeHeaders(pResponse, tmpMeta, true);
				// A Stale answer's Version is not the current one: never a 304 (internal-contracts §51.17).
				let tmpStale = !!(tmpMeta.Cache && (tmpMeta.Cache.Status === 'Stale'));
				if (!tmpStale && this.matchesETag(pRequest, pEnvelope.Version))
				{
					pResponse.send(304);
					return fNext();
				}
				pResponse.send(200, pEnvelope);
				return fNext();
			});
	}

	/**
	 * The route :Entity.
	 *
	 * @param {any} pRequest
	 * @return {string}
	 */
	routeEntity(pRequest)
	{
		return (pRequest.params && (typeof(pRequest.params.Entity) === 'string')) ? pRequest.params.Entity : '';
	}

	/**
	 * The body as the service sees it: the /Scope/:Scope/ forms prepend the path scope (with the
	 * parameters it declares from the top-level Params); the /Records/:Begin/:Cap form sets the page
	 * (the body's Records.Sort is kept).  A path segment that is not a non-negative integer is a
	 * 400 FACET_REQUEST_INVALID { Field, Max } (the range itself is the normalizer's).
	 *
	 * @param {any} pRequest
	 * @param {string|null} pMode - 'Records' for the page form, else null
	 * @return {any}
	 */
	routeBody(pRequest, pMode)
	{
		let tmpService = this.fable.RetoldFacetingService;
		let tmpParams = pRequest.params || {};
		let tmpBody = pRequest.body;
		if ((typeof(tmpParams.Scope) === 'string') && tmpService)
		{
			tmpBody = tmpService.withPathScope(tmpParams.Scope, tmpBody);
		}
		if ((pMode === 'Records') && ((typeof(tmpParams.Begin) !== 'undefined') || (typeof(tmpParams.Cap) !== 'undefined')))
		{
			let tmpLimits = this.options.Limits;
			let fInteger = (pValue, pField, pMax) =>
			{
				if ((typeof(pValue) !== 'string') || !/^[0-9]{1,9}$/.test(pValue))
				{
					throw libFacetErrors.create('FACET_REQUEST_INVALID', `${pField} must be a non-negative integer.`, { Field: pField, Max: pMax });
				}
				return parseInt(pValue, 10);
			};
			let tmpBegin = fInteger(tmpParams.Begin, 'Begin', tmpLimits.MaxRecordsOffset);
			let tmpCap = fInteger(tmpParams.Cap, 'Cap', tmpLimits.MaxRecordsPage);
			if ((typeof(tmpBody) === 'object') && (tmpBody !== null) && !Array.isArray(tmpBody))
			{
				let tmpRecords = ((typeof(tmpBody.Records) === 'object') && (tmpBody.Records !== null) && !Array.isArray(tmpBody.Records)) ? tmpBody.Records : {};
				tmpBody = Object.assign({}, tmpBody, { Records: Object.assign({}, tmpRecords, { Begin: tmpBegin, Cap: tmpCap }) });
			}
		}
		return tmpBody;
	}

	/**
	 * POST …/Records, …/Records/:Begin/:Cap (and the /Scope/:Scope/ forms): a bare array of records.
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleRecords(pRequest, pResponse, fNext)
	{
		let tmpService = this.fable.RetoldFacetingService;
		if (!tmpService)
		{
			this.sendError(pResponse, libFacetErrors.create('FACET_INTERNAL'), fNext);
			return;
		}
		let tmpBody;
		try
		{
			tmpBody = this.routeBody(pRequest, 'Records');
		}
		catch (pBodyError)
		{
			this.sendError(pResponse, pBodyError, fNext);
			return;
		}
		tmpService.records(this.routeEntity(pRequest), tmpBody, pRequest,
			(pError, pRecords, pMeta) =>
			{
				if (pError)
				{
					return this.sendError(pResponse, pError, fNext);
				}
				let tmpMeta = pMeta || {};
				this.setStandardHeaders(pResponse, tmpMeta.Version);
				this.setRepairedHeader(pResponse, tmpMeta);
				this.setChangeHeaders(pResponse, tmpMeta, false);
				if (tmpMeta.Dropped > 0)
				{
					pResponse.header('X-Retold-Facet-Records-Dropped', String(tmpMeta.Dropped));
				}
				if (this.matchesETag(pRequest, tmpMeta.Version))
				{
					pResponse.send(304);
					return fNext();
				}
				pResponse.send(200, pRecords);
				return fNext();
			});
	}

	/**
	 * POST …/Records/Count (and the /Scope/:Scope/ form): { Count }.
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleCount(pRequest, pResponse, fNext)
	{
		let tmpService = this.fable.RetoldFacetingService;
		if (!tmpService)
		{
			this.sendError(pResponse, libFacetErrors.create('FACET_INTERNAL'), fNext);
			return;
		}
		tmpService.count(this.routeEntity(pRequest), this.routeBody(pRequest, null), pRequest,
			(pError, pResult, pMeta) =>
			{
				if (pError)
				{
					return this.sendError(pResponse, pError, fNext);
				}
				let tmpVersion = (pMeta && pMeta.Version) ? pMeta.Version : undefined;
				this.setStandardHeaders(pResponse, tmpVersion);
				this.setRepairedHeader(pResponse, pMeta);
				this.setChangeHeaders(pResponse, pMeta, false);
				if (this.matchesETag(pRequest, tmpVersion))
				{
					pResponse.send(304);
					return fNext();
				}
				pResponse.send(200, pResult);
				return fNext();
			});
	}

	/**
	 * POST …/Keys: { Entity, Keys, Count, Truncated, Version }.
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleKeys(pRequest, pResponse, fNext)
	{
		let tmpService = this.fable.RetoldFacetingService;
		if (!tmpService)
		{
			this.sendError(pResponse, libFacetErrors.create('FACET_INTERNAL'), fNext);
			return;
		}
		tmpService.keys(this.routeEntity(pRequest), this.routeBody(pRequest, null), pRequest,
			(pError, pResult, pMeta) =>
			{
				if (pError)
				{
					return this.sendError(pResponse, pError, fNext);
				}
				this.setStandardHeaders(pResponse, pResult.Version);
				this.setRepairedHeader(pResponse, pMeta);
				this.setChangeHeaders(pResponse, pMeta, false);
				if (this.matchesETag(pRequest, pResult.Version))
				{
					pResponse.send(304);
					return fNext();
				}
				pResponse.send(200, pResult);
				return fNext();
			});
	}

	/**
	 * Does the request's If-None-Match match this Version (weak comparison, 02 §8)?
	 *
	 * @param {any} pRequest
	 * @param {string} pVersion - 'fv1:…'
	 * @return {boolean}
	 */
	matchesETag(pRequest, pVersion)
	{
		let tmpHeader = (pRequest && pRequest.headers) ? pRequest.headers['if-none-match'] : null;
		if ((typeof(tmpHeader) !== 'string') || (tmpHeader.length < 1) || (typeof(pVersion) !== 'string') || (pVersion.length < 1))
		{
			return false;
		}
		let tmpTags = tmpHeader.split(',');
		for (let i = 0; i < tmpTags.length; i++)
		{
			let tmpTag = tmpTags[i].trim();
			if (tmpTag === '*')
			{
				return true;
			}
			if (tmpTag.indexOf('W/') === 0)
			{
				tmpTag = tmpTag.substring(2);
			}
			if (tmpTag === `"${pVersion}"`)
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * GET /1.0/Facet/Describe, /1.0/Facet/Describe/:Entity, /1.0/Facet/:Entity/Describe
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleDescribe(pRequest, pResponse, fNext)
	{
		let tmpService = this.fable.RetoldFacetingService;
		if (!tmpService)
		{
			this.sendError(pResponse, libFacetErrors.create('FACET_INTERNAL'), fNext);
			return;
		}
		let tmpEntity = (pRequest.params && (typeof(pRequest.params.Entity) === 'string')) ? pRequest.params.Entity : null;
		tmpService.describeRequest(tmpEntity, pRequest,
			(pError, pDescribe) =>
			{
				if (pError)
				{
					return this.sendError(pResponse, pError, fNext);
				}
				this.setStandardHeaders(pResponse);
				pResponse.send(200, pDescribe);
				return fNext();
			});
	}
}

module.exports = RetoldFacetingRoutes;
module.exports.serviceType = 'RetoldFacetingRoutes';
