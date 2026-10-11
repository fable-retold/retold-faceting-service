/**
 * Retold Faceting - SSE (change notifications to browsers)
 *
 *   GET /1.0/Facet/Changes   (text/event-stream; design 02 §10, 09 §4.20)
 *
 * Mounted when SSE.Enabled is true, or 'Auto' (the default) on a host with a scope policy: without
 * one the service cannot tell tenants apart, so every write would reach every stream (an explicit
 * true is the operator's statement that the host is single-tenant).  Authenticated principals only
 * (an anonymous principal is 401 before the stream opens); a cross-origin page (an Origin header
 * that is neither this host nor in SSE.AllowedOrigins) is 403.  Events:
 *
 *   ready        { NodeEpoch, Seq?, CoalesceMS, HeartbeatMS, Reset }
 *   generation   { Entity, Generation, Seq? }     ONLY these fields: no tenant, owner, column, id, count
 *                                                 or row data; Generation is opaque per principal
 *   model        { ModelVersion }                 after a model reload
 *   closed       { Reason }                       Shutdown | Revalidate
 *   ': hb'       heartbeat comment
 *
 * Seq (the node-wide change counter) is included only when SSE.IncludeSeq is true, or 'Auto' (the
 * default) on a host WITHOUT a scope policy: on a multi-tenant host consecutive Seqs would reveal
 * other tenants' write volume.  No 'id:' line is written (events are never replayed).
 *
 * A Generations bump of entity E reaches a connection only when the principal can facet E and one of
 * the bump's tenant keys is the principal's own (its tenant; for a PersonalScopes entity its own
 * owner key, never a colleague's); '*' bumps are folded into a periodic global tick under a policy;
 * '#any' is never forwarded.
 *
 * The write path pays O(tenant keys of the bump) per record (onBump only records the entity's
 * pending { MaxTick, Seq, Keys } and arms ONE shared flush timer); every SSE.CoalesceMS the shared
 * flush filters candidate connections (bucketed by tenant Part) and writes at most one event per
 * (connection, entity).  One shared housekeeping timer sends heartbeats, closes streams blocked longer
 * than 2 × HeartbeatMS (a stuck consumer never holds its slot), and ends each stream at its
 * revalidation time (SSE.RevalidateMS, jittered ±10 %) with closed { Reason: 'Revalidate' }: the
 * client reconnects through the host's full authentication, so a logout, a tenant switch or a role
 * change takes effect without the stream trusting the session snapshot it opened with.  A host that
 * can re-read a session from its store implements Host.revalidatePrincipal(pRequest, fCallback) and
 * keeps streams open instead; such a host may also call revalidateAll() when something a principal's
 * rights depend on changed (the RAFS host does on every role-table write), so a revocation reaches
 * open streams at once instead of at their next revalidation time.
 *
 * Limits: SSE.MaxPerPrincipal (refuse new, 429), a per-tenant fair share
 * min(MaxPerTenant, MaxConnections / active tenants) under a policy (none without one: a single
 * bucket is not a tenant), SSE.MaxConnections in total.
 *
 * Restify discipline: handleChanges never returns a promise and calls fNext exactly once — fNext(false)
 * when the stream ends (client close, closeAll, revalidation, a stalled consumer), or right after a
 * refusal (401 / 403 / 429 / 500, sent as the JSON facet error with the standard headers).  Nothing
 * else writes to an open stream's response.  A server-initiated close also ends the TCP connection.
 *
 * Contract: internal-contracts §46.  Owner: builder C (M4; review fixes §51.58–§51.63).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The event types of the stream (internal-contracts §46.2).
const EVENT_TYPES = Object.freeze([ 'ready', 'generation', 'model', 'closed' ]);

// Close reasons a 'closed' event carries.
const CLOSE_REASONS = Object.freeze([ 'Shutdown', 'Revalidate' ]);

// Pseudo tenant keys (internal-contracts §41.1; Generations owns the grammar).
const GLOBAL_KEY = '*';
const ANY_KEY = '#any';
const NO_TENANT_PART = '#none';

// The connection-limit names a 429 Detail carries (internal-contracts §46.1).
const LIMIT_PRINCIPAL = 'SSE.MaxPerPrincipal';
const LIMIT_TENANT = 'SSE.MaxPerTenant';
const LIMIT_TOTAL = 'SSE.MaxConnections';

// After a server-initiated close the socket is ended; a peer that never reads is destroyed after this.
const SOCKET_DESTROY_GRACE_MS = 1000;

// The shortest global tick / housekeeping period (a 0 setting would otherwise spin).
const MIN_GLOBAL_TICK_MS = 10;
const MIN_HOUSEKEEPING_MS = 10;

// A stream blocked (write() returned false) longer than this many heartbeats is closed.
const STALL_HEARTBEATS = 2;

// Revalidation jitter (± fraction of RevalidateMS) and retry jitter (+ fraction of RetryMS): streams
// opened together do not all reconnect together.
const REVALIDATE_JITTER = 0.1;
const RETRY_JITTER = 0.5;

class RetoldFacetingSSE extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingSSE';

		this._Connected = false;
		// Open connections
		this._Connections = new Set();
		// principal key → Set<connection>
		this._ByPrincipal = new Map();
		// tenant Part ('*' without a policy column) → Set<connection>
		this._ByTenant = new Map();
		// Entity → { MaxTick, Seq, N, Keys: Set<tenant key>, All } waiting for the shared flush
		this._Pending = new Map();
		this._FlushTimer = null;
		// Entity → { MaxTick, Seq, N }: '*' bumps waiting for the global tick
		this._GlobalQueue = new Map();
		this._GlobalTimer = null;
		// The shared heartbeat / stall / revalidation timer (while any stream is open)
		this._HousekeepingTimer = null;
		// Socket-destroy fallbacks still pending (timers)
		this._SocketTimers = new Set();
		// The pending revalidateAll() pass (one setImmediate for a burst of calls)
		this._RevalidateSoon = null;
		this._ConnectionCounter = 0;
		this._Stats = { Opened: 0, Refused: {}, Sent: 0, Coalesced: 0, Heartbeats: 0, Closed: 0, Revalidated: 0, Stalled: 0 };
	}

	// ---------------------------------------------------------------- settings and siblings

	/**
	 * A numeric SSE setting (non-negative), falling back to the default when unset or invalid.
	 * Read at use time, so a host (or a test) may tune them on the live options object.
	 *
	 * @param {string} pName - e.g. 'CoalesceMS'
	 * @return {number}
	 */
	setting(pName)
	{
		let tmpSSE = (this.options && libRetoldFacetingUtil.isPlainObject(this.options.SSE)) ? this.options.SSE : {};
		let tmpValue = Number(tmpSSE[pName]);
		if (Number.isFinite(tmpValue) && (tmpValue >= 0))
		{
			return tmpValue;
		}
		return libOptions.DEFAULTS.SSE[pName];
	}

	/**
	 * A true | false | 'Auto' SSE switch: 'Auto' (or anything else) follows pAuto.
	 *
	 * @param {string} pName
	 * @param {boolean} pAuto
	 * @return {boolean}
	 */
	switchSetting(pName, pAuto)
	{
		let tmpSSE = (this.options && libRetoldFacetingUtil.isPlainObject(this.options.SSE)) ? this.options.SSE : {};
		if (tmpSSE[pName] === true)
		{
			return true;
		}
		if (tmpSSE[pName] === false)
		{
			return false;
		}
		return pAuto;
	}

	/**
	 * SSE.Enabled: true, false, or 'Auto' (the default) = only on a host with a scope policy.
	 *
	 * @return {boolean}
	 */
	enabled()
	{
		return this.switchSetting('Enabled', this.hasPolicy());
	}

	/**
	 * SSE.IncludeSeq: true, false, or 'Auto' (the default) = only on a host WITHOUT a scope policy.
	 *
	 * @return {boolean}
	 */
	includeSeq()
	{
		return this.switchSetting('IncludeSeq', !this.hasPolicy());
	}

	/**
	 * The attached host adapter, or null.
	 *
	 * @return {any|null}
	 */
	host()
	{
		let tmpService = this.fable.RetoldFacetingService;
		return (tmpService && tmpService.Host) ? tmpService.Host : null;
	}

	/**
	 * The host's scope policy, or null.
	 *
	 * @return {Record<string, any>|null}
	 */
	policy()
	{
		let tmpHost = this.host();
		if (!tmpHost || (typeof(tmpHost.getScopePolicy) !== 'function'))
		{
			return null;
		}
		try
		{
			return tmpHost.getScopePolicy();
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * @return {boolean} the host runs a scope policy (Kind 'Policy')
	 */
	hasPolicy()
	{
		let tmpPolicy = this.policy();
		return !!tmpPolicy && (tmpPolicy.Kind === 'Policy');
	}

	/**
	 * The tenant Part of a principal: Generations.tenantKey(ScopeValues[Policy.Column]); '*' without a
	 * policy column (one bucket).
	 *
	 * @param {Record<string, any>} pPrincipal
	 * @return {string}
	 */
	tenantPart(pPrincipal)
	{
		let tmpPolicy = this.policy();
		if (!tmpPolicy || (tmpPolicy.Kind !== 'Policy') || (typeof(tmpPolicy.Column) !== 'string') || (tmpPolicy.Column.length < 1))
		{
			return GLOBAL_KEY;
		}
		let tmpScopeValues = (pPrincipal && libRetoldFacetingUtil.isPlainObject(pPrincipal.ScopeValues)) ? pPrincipal.ScopeValues : {};
		let tmpValue = libRetoldFacetingUtil.hasOwn(tmpScopeValues, tmpPolicy.Column) ? tmpScopeValues[tmpPolicy.Column] : null;
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		if (tmpGenerations && (typeof(tmpGenerations.tenantKey) === 'function'))
		{
			return tmpGenerations.tenantKey(tmpValue);
		}
		return libRetoldFacetingUtil.isUnsetScopeValue(tmpValue, this.options.Scope.UnsetValues) ? GLOBAL_KEY
			: encodeURIComponent(String(libRetoldFacetingUtil.normalizeScopeValue(tmpValue))).replace(/\*/g, '%2A');
	}

	/**
	 * The node's current Seq (ChangeIntake), or null without an intake.
	 *
	 * @return {string|null}
	 */
	currentSeq()
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		if (tmpIntake && (typeof(tmpIntake.currentSeq) === 'function'))
		{
			try
			{
				return tmpIntake.currentSeq();
			}
			catch (pError)
			{
				return null;
			}
		}
		return null;
	}

	/**
	 * The later of two Seqs: within one epoch the larger counter; across epochs (or unparsable) the
	 * newer arrival (pNext).
	 *
	 * @param {string|null} pCurrent
	 * @param {string|null} pNext
	 * @return {string|null}
	 */
	laterSeq(pCurrent, pNext)
	{
		if (!pNext)
		{
			return pCurrent || null;
		}
		if (!pCurrent)
		{
			return pNext;
		}
		let tmpCurrent = libRetoldFacetingUtil.parseSeq(pCurrent);
		let tmpNext = libRetoldFacetingUtil.parseSeq(pNext);
		if (tmpCurrent && tmpNext && (tmpCurrent.Epoch === tmpNext.Epoch))
		{
			return (tmpNext.N >= tmpCurrent.N) ? pNext : pCurrent;
		}
		return pNext;
	}

	// ---------------------------------------------------------------- mounting and the route

	/**
	 * Mount GET <RoutePrefix>/Changes (idempotent; only when enabled()).
	 *
	 * @param {any} pServiceServer - fable.OratorServiceServer
	 * @return {boolean} true when mounted
	 */
	connect(pServiceServer)
	{
		if (this._Connected)
		{
			return true;
		}
		if (!pServiceServer || (typeof(pServiceServer.get) !== 'function'))
		{
			return false;
		}
		if (!this.enabled())
		{
			return false;
		}
		pServiceServer.get(`${this.options.RoutePrefix}/Changes`, this.handleChanges.bind(this));
		this._Connected = true;
		return true;
	}

	/**
	 * A fresh request context for principal resolution and per-entity authorization (the M1 401 rules
	 * with Entity '').
	 *
	 * @param {any} pRequest
	 * @return {Record<string, any>}
	 */
	newContext(pRequest)
	{
		this._ConnectionCounter++;
		return (
			{
				RequestID: `rfs-${String(this._ConnectionCounter).padStart(6, '0')}`,
				Entity: '',
				Request: pRequest,
				Host: this.host(),
				Options: this.options,
				Principal: null
			});
	}

	/**
	 * The standard facet response headers (02 §8): Routes owns them.
	 *
	 * @param {any} pResponse
	 */
	setStandardHeaders(pResponse)
	{
		let tmpRoutes = this.fable.RetoldFacetingRoutes;
		if (tmpRoutes && (typeof(tmpRoutes.setStandardHeaders) === 'function'))
		{
			tmpRoutes.setStandardHeaders(pResponse);
			return;
		}
		pResponse.header('Cache-Control', 'private, no-cache');
		pResponse.header('Vary', 'Cookie, Authorization');
		pResponse.header('X-Retold-Facet-Contract', String(libFacetRequest.CONTRACT_VERSION));
	}

	/**
	 * Refuse the stream with a JSON facet error (nothing was opened), then end the chain.
	 *
	 * @param {any} pResponse
	 * @param {any} pError
	 * @param {Function} fFinish - calls fNext(false) once
	 */
	refuse(pResponse, pError, fFinish)
	{
		try
		{
			if (!libFacetErrors.isFacetError(pError))
			{
				this.fable.log.error(`RetoldFaceting SSE: ${(pError && pError.message) ? pError.message : pError}`);
			}
			let tmpResponse = libFacetErrors.toResponse(pError);
			if (!pResponse.headersSent)
			{
				this.setStandardHeaders(pResponse);
				pResponse.send(tmpResponse.Status, tmpResponse.Body);
			}
		}
		catch (pSendError)
		{
			this.fable.log.error(`RetoldFaceting SSE: the refusal could not be sent: ${pSendError.message}`);
		}
		return fFinish();
	}

	/**
	 * May a request with this Origin open a stream (S7)?  No Origin (a same-origin GET, a non-browser
	 * client) or the request's own host: yes; otherwise only an origin listed in SSE.AllowedOrigins
	 * (or '*').  A cross-site page can then neither read a victim's stream nor hold the victim's
	 * connection slots.
	 *
	 * @param {any} pRequest
	 * @return {boolean}
	 */
	originAllowed(pRequest)
	{
		let tmpHeaders = (pRequest && pRequest.headers && (typeof(pRequest.headers) === 'object')) ? pRequest.headers : {};
		let tmpOrigin = tmpHeaders.origin;
		if ((typeof(tmpOrigin) !== 'string') || (tmpOrigin.length < 1))
		{
			return true;
		}
		let tmpAllowed = (this.options.SSE && (Array.isArray(this.options.SSE.AllowedOrigins) || (typeof(this.options.SSE.AllowedOrigins) === 'string'))) ? this.options.SSE.AllowedOrigins : [];
		if ((tmpAllowed === '*') || (Array.isArray(tmpAllowed) && ((tmpAllowed.indexOf('*') >= 0) || (tmpAllowed.indexOf(tmpOrigin) >= 0))))
		{
			return true;
		}
		let tmpHost = (typeof(tmpHeaders.host) === 'string') ? tmpHeaders.host.toLowerCase() : null;
		try
		{
			return !!tmpHost && (new URL(tmpOrigin).host.toLowerCase() === tmpHost);
		}
		catch (pParseError)
		{
			// 'null' (a sandboxed frame, a file: page) or garbage: not this origin.
			return false;
		}
	}

	/**
	 * The route handler (internal-contracts §46.1).  Never returns a promise; calls fNext once, when
	 * the stream ends (or right after a refusal).
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Function} fNext
	 */
	handleChanges(pRequest, pResponse, fNext)
	{
		let tmpFinished = false;
		let fFinish = () =>
		{
			if (tmpFinished)
			{
				return;
			}
			tmpFinished = true;
			if (typeof(fNext) === 'function')
			{
				fNext(false);
			}
		};
		try
		{
			if (!this.originAllowed(pRequest))
			{
				this._Stats.Refused.Origin = (this._Stats.Refused.Origin || 0) + 1;
				this.refuse(pResponse, libFacetErrors.create('FACET_FORBIDDEN', 'Change streams are not served to other origins.', { Reason: 'Origin' }), fFinish);
				return;
			}
			let tmpResolver = this.fable.RetoldFacetingPrincipalResolver;
			let tmpContext = this.newContext(pRequest);
			if (!tmpContext.Host || !tmpResolver)
			{
				this.refuse(pResponse, libFacetErrors.create('FACET_INTERNAL', 'The faceting service is not attached to a host.'), fFinish);
				return;
			}
			tmpResolver.resolve(tmpContext,
				(pError, pPrincipal) =>
				{
					try
					{
						if (pError)
						{
							return this.refuse(pResponse, pError, fFinish);
						}
						if (!pPrincipal || (pPrincipal.Kind !== 'User'))
						{
							return this.refuse(pResponse, libFacetErrors.create('FACET_UNAUTHENTICATED'), fFinish);
						}
						tmpContext.Principal = pPrincipal;
						return this.open(pRequest, pResponse, tmpContext, fFinish);
					}
					catch (pOpenError)
					{
						return this.refuse(pResponse, pOpenError, fFinish);
					}
				});
		}
		catch (pHandlerError)
		{
			this.refuse(pResponse, pHandlerError, fFinish);
		}
	}

	/**
	 * The per-tenant cap of a new stream of pTenantPart (S7): min(MaxPerTenant, MaxConnections /
	 * active tenants), at least 1; no cap without a policy (one bucket is not a tenant).  Every stream
	 * ends at its revalidation time and reconnects, so the shares rebalance as tenants come and go.
	 *
	 * @param {string} pTenantPart
	 * @return {number}
	 */
	tenantCap(pTenantPart)
	{
		if (!this.hasPolicy())
		{
			return Infinity;
		}
		let tmpTenants = this._ByTenant.size + (this._ByTenant.has(pTenantPart) ? 0 : 1);
		let tmpShare = Math.max(1, Math.floor(this.setting('MaxConnections') / Math.max(1, tmpTenants)));
		return Math.min(this.setting('MaxPerTenant'), tmpShare);
	}

	/**
	 * Which connection limit (if any) a new stream of this principal would exceed.
	 *
	 * @param {string} pPrincipalKey
	 * @param {string} pTenantPart
	 * @return {string|null} the Limit name of the 429 Detail
	 */
	limitExceeded(pPrincipalKey, pTenantPart)
	{
		let tmpPrincipalSet = this._ByPrincipal.get(pPrincipalKey);
		if ((tmpPrincipalSet ? tmpPrincipalSet.size : 0) >= this.setting('MaxPerPrincipal'))
		{
			return LIMIT_PRINCIPAL;
		}
		let tmpTenantSet = this._ByTenant.get(pTenantPart);
		if ((tmpTenantSet ? tmpTenantSet.size : 0) >= this.tenantCap(pTenantPart))
		{
			return LIMIT_TENANT;
		}
		if (this._Connections.size >= this.setting('MaxConnections'))
		{
			return LIMIT_TOTAL;
		}
		return null;
	}

	/**
	 * Open the stream for a resolved User principal (internal-contracts §46.1 steps 2–3).
	 *
	 * @param {any} pRequest
	 * @param {any} pResponse
	 * @param {Record<string, any>} pContext - with Principal
	 * @param {Function} fFinish
	 */
	open(pRequest, pResponse, pContext, fFinish)
	{
		let tmpPrincipalKey = libRetoldFacetingUtil.principalKey(pContext.Principal);
		let tmpTenantPart = this.tenantPart(pContext.Principal);
		let tmpLimit = this.limitExceeded(tmpPrincipalKey, tmpTenantPart);
		if (tmpLimit)
		{
			this._Stats.Refused[tmpLimit] = (this._Stats.Refused[tmpLimit] || 0) + 1;
			this.fable.log.info(`RetoldFaceting SSE: refused a stream (${tmpLimit}).`);
			return this.refuse(pResponse, libFacetErrors.create('FACET_RATE_LIMITED', 'Too many open change streams.', { Limit: tmpLimit }), fFinish);
		}
		let tmpSocket = pResponse.socket || (pRequest ? pRequest.socket : null) || null;
		if (pResponse.headersSent || pResponse.writableEnded || pResponse.destroyed || (tmpSocket && tmpSocket.destroyed))
		{
			// Something upstream already answered, or the client left while the principal resolved:
			// nothing to stream into (and nothing indexed that no 'close' would ever remove).
			return fFinish();
		}

		let tmpNow = Date.now();
		let tmpRevalidateMS = this.setting('RevalidateMS');
		let tmpConnection = (
			{
				ID: pContext.RequestID,
				Request: pRequest,
				Response: pResponse,
				Socket: tmpSocket,
				Context: pContext,
				Principal: pContext.Principal,
				PrincipalKey: tmpPrincipalKey,
				TenantPart: tmpTenantPart,
				OpenedAt: tmpNow,
				Sent: 0,
				// Entity → boolean / Array<string> (until revalidation or a model reload)
				CanFacet: new Map(),
				VisibleKeys: new Map(),
				// Entity → { MaxTick, Seq } held while the stream is blocked
				Pending: new Map(),
				// Entity → the largest tick forwarded (the opaque Generation)
				Forwarded: new Map(),
				Blocked: false,
				BlockedSince: null,
				Revalidating: false,
				// revalidateAll() arrived while a revalidation was in flight: run it once more after
				RevalidateAgain: false,
				NextHeartbeatAt: tmpNow + this.setting('HeartbeatMS'),
				RevalidateAt: (tmpRevalidateMS > 0) ? (tmpNow + Math.round(tmpRevalidateMS * (1 - REVALIDATE_JITTER + (Math.random() * 2 * REVALIDATE_JITTER)))) : null,
				Closed: false,
				Finish: fFinish
			});

		pResponse.writeHead(200,
			{
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache, no-transform',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no',
				'Vary': 'Cookie, Authorization',
				'X-Retold-Facet-Contract': String(libFacetRequest.CONTRACT_VERSION)
			});
		if (tmpConnection.Socket)
		{
			if (typeof(tmpConnection.Socket.setTimeout) === 'function')
			{
				tmpConnection.Socket.setTimeout(0);
			}
			if (typeof(tmpConnection.Socket.setNoDelay) === 'function')
			{
				tmpConnection.Socket.setNoDelay(true);
			}
		}

		this.index(tmpConnection);
		this._Stats.Opened++;

		if (typeof(pResponse.on) === 'function')
		{
			pResponse.on('close', () => { this.close(tmpConnection, null); });
			pResponse.on('error', () => { this.close(tmpConnection, null); });
			pResponse.on('drain', () => { this.drain(tmpConnection); });
		}

		let tmpHeaders = (pRequest && libRetoldFacetingUtil.isPlainObject(pRequest.headers)) ? pRequest.headers : ((pRequest && pRequest.headers) || {});
		let tmpLastEventID = tmpHeaders['last-event-id'];
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		let tmpReady = { NodeEpoch: (tmpIntake && (typeof(tmpIntake.NodeEpoch) === 'string')) ? tmpIntake.NodeEpoch : null };
		if (this.includeSeq())
		{
			tmpReady.Seq = this.currentSeq();
		}
		tmpReady.CoalesceMS = this.setting('CoalesceMS');
		tmpReady.HeartbeatMS = this.setting('HeartbeatMS');
		tmpReady.Reset = (typeof(tmpLastEventID) === 'string') && (tmpLastEventID.length > 0);

		// A jittered retry: streams cut together (a deploy) do not all come back together.
		this.write(tmpConnection, `retry: ${Math.round(this.setting('RetryMS') * (1 + (Math.random() * RETRY_JITTER)))}\n\n`, false);
		this.writeEvent(tmpConnection, 'ready', tmpReady);
		this.armHousekeeping();
	}

	// ---------------------------------------------------------------- the connection index

	/**
	 * Add a connection to the indexes.
	 *
	 * @param {Record<string, any>} pConnection
	 */
	index(pConnection)
	{
		this._Connections.add(pConnection);
		let fAdd = (pMap, pKey) =>
		{
			let tmpSet = pMap.get(pKey);
			if (!tmpSet)
			{
				tmpSet = new Set();
				pMap.set(pKey, tmpSet);
			}
			tmpSet.add(pConnection);
		};
		fAdd(this._ByPrincipal, pConnection.PrincipalKey);
		fAdd(this._ByTenant, pConnection.TenantPart);
	}

	/**
	 * Remove a connection from the indexes.
	 *
	 * @param {Record<string, any>} pConnection
	 */
	unindex(pConnection)
	{
		this._Connections.delete(pConnection);
		let fRemove = (pMap, pKey) =>
		{
			let tmpSet = pMap.get(pKey);
			if (tmpSet)
			{
				tmpSet.delete(pConnection);
				if (tmpSet.size < 1)
				{
					pMap.delete(pKey);
				}
			}
		};
		fRemove(this._ByPrincipal, pConnection.PrincipalKey);
		fRemove(this._ByTenant, pConnection.TenantPart);
	}

	// ---------------------------------------------------------------- writing

	/**
	 * Write raw text to a stream.  A false return holds further events until 'drain'.
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pText
	 * @param {boolean} pIsEvent - count it in Sent
	 * @return {boolean} false when the connection is closed or now blocked
	 */
	write(pConnection, pText, pIsEvent)
	{
		if (pConnection.Closed)
		{
			return false;
		}
		try
		{
			let tmpWritten = pConnection.Response.write(pText);
			if (pIsEvent)
			{
				pConnection.Sent++;
				this._Stats.Sent++;
			}
			if (tmpWritten === false)
			{
				pConnection.Blocked = true;
				if (pConnection.BlockedSince === null)
				{
					pConnection.BlockedSince = Date.now();
				}
			}
			return (tmpWritten !== false);
		}
		catch (pError)
		{
			this.close(pConnection, null);
			return false;
		}
	}

	/**
	 * Write one event (internal-contracts §46.2): an event line and one JSON data line (never an
	 * 'id:' line: events are not replayed, and an id would carry the node's Seq).
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pType - one of EVENT_TYPES
	 * @param {Record<string, any>} pData
	 * @return {boolean}
	 */
	writeEvent(pConnection, pType, pData)
	{
		return this.write(pConnection, `event: ${pType}\ndata: ${JSON.stringify(pData)}\n\n`, true);
	}

	/**
	 * The opaque Generation of an entity for one connection (internal-contracts §46.2): it changes
	 * when the data visible to this principal changed and reveals nothing else.
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pEntity
	 * @param {number} pMaxTick
	 * @return {string} 'g:' + 12 hex
	 */
	generation(pConnection, pEntity, pMaxTick)
	{
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		let tmpBootEpoch = (tmpGenerations && (typeof(tmpGenerations.BootEpoch) === 'string')) ? tmpGenerations.BootEpoch : '';
		return `g:${libCrypto.createHash('sha256').update(`${tmpBootEpoch}|${pConnection.PrincipalKey}|${pEntity}|${pMaxTick}`, 'utf8').digest('hex').slice(0, 12)}`;
	}

	/**
	 * Deliver one (already coalesced) entity change to a connection: written now, or held (merged
	 * per entity) while the stream is blocked.
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pEntity
	 * @param {number} pTick
	 * @param {string|null} pSeq
	 */
	deliver(pConnection, pEntity, pTick, pSeq)
	{
		if (pConnection.Closed)
		{
			return;
		}
		if (pConnection.Blocked)
		{
			let tmpHeld = pConnection.Pending.get(pEntity);
			if (tmpHeld)
			{
				tmpHeld.MaxTick = Math.max(tmpHeld.MaxTick, pTick);
				tmpHeld.Seq = this.laterSeq(tmpHeld.Seq, pSeq);
				this._Stats.Coalesced++;
			}
			else
			{
				pConnection.Pending.set(pEntity, { MaxTick: pTick, Seq: pSeq });
			}
			return;
		}
		let tmpMaxTick = Math.max(pConnection.Forwarded.get(pEntity) || 0, pTick);
		pConnection.Forwarded.set(pEntity, tmpMaxTick);
		let tmpData = { Entity: pEntity, Generation: this.generation(pConnection, pEntity, tmpMaxTick) };
		if (pSeq && this.includeSeq())
		{
			tmpData.Seq = pSeq;
		}
		this.writeEvent(pConnection, 'generation', tmpData);
	}

	/**
	 * 'drain': the stream accepts writes again; write every held entity (in arrival order).
	 *
	 * @param {Record<string, any>} pConnection
	 */
	drain(pConnection)
	{
		if (pConnection.Closed)
		{
			return;
		}
		pConnection.Blocked = false;
		pConnection.BlockedSince = null;
		let tmpHeld = Array.from(pConnection.Pending.entries());
		pConnection.Pending.clear();
		for (let i = 0; i < tmpHeld.length; i++)
		{
			if (pConnection.Closed)
			{
				return;
			}
			// deliver() holds it again if this write blocks.
			this.deliver(pConnection, tmpHeld[i][0], tmpHeld[i][1].MaxTick, tmpHeld[i][1].Seq);
		}
	}

	// ---------------------------------------------------------------- authorization of bumps

	/**
	 * Can this connection's principal facet the entity (cached until revalidation / model reload)?
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	canFacet(pConnection, pEntity)
	{
		if (pConnection.CanFacet.has(pEntity))
		{
			return pConnection.CanFacet.get(pEntity);
		}
		let tmpAllowed = false;
		let tmpAuthorizer = this.fable.RetoldFacetingAuthorizer;
		try
		{
			tmpAllowed = !!tmpAuthorizer && (tmpAuthorizer.canFacet(pConnection.Context, pEntity) === true);
		}
		catch (pError)
		{
			tmpAllowed = false;
		}
		pConnection.CanFacet.set(pEntity, tmpAllowed);
		return tmpAllowed;
	}

	/**
	 * The tenant keys of an entity whose bumps this connection may hear about
	 * (Generations.principalTenantKeys; cached until revalidation / model reload).
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string} pEntity
	 * @return {Array<string>}
	 */
	visibleKeys(pConnection, pEntity)
	{
		if (pConnection.VisibleKeys.has(pEntity))
		{
			return pConnection.VisibleKeys.get(pEntity);
		}
		let tmpKeys = [];
		let tmpGenerations = this.fable.RetoldFacetingGenerations;
		try
		{
			let tmpResult = (tmpGenerations && (typeof(tmpGenerations.principalTenantKeys) === 'function')) ? tmpGenerations.principalTenantKeys(pConnection.Principal, pEntity) : [];
			tmpKeys = Array.isArray(tmpResult) ? tmpResult.filter((pKey) => { return (typeof(pKey) === 'string') && (pKey !== ANY_KEY); }) : [];
		}
		catch (pError)
		{
			tmpKeys = [];
		}
		pConnection.VisibleKeys.set(pEntity, tmpKeys);
		return tmpKeys;
	}

	/**
	 * The Seq a bump carries (its ChangeEvent's), else the node's current Seq.
	 *
	 * @param {Record<string, any>} pBump
	 * @return {string|null}
	 */
	bumpSeq(pBump)
	{
		if ((typeof(pBump.Seq) === 'string') && libRetoldFacetingUtil.SEQ_PATTERN.test(pBump.Seq))
		{
			return pBump.Seq;
		}
		return this.currentSeq();
	}

	/**
	 * Merge a bump's tick and Seq into a pending record (Seq compared numerically within an epoch,
	 * parsed once per bump).
	 *
	 * @param {Record<string, any>} pRecord - { MaxTick, Seq, N, Epoch }
	 * @param {number} pTick
	 * @param {string|null} pSeq
	 * @param {{ Epoch: string, N: number }|null} pParsed
	 */
	mergeTick(pRecord, pTick, pSeq, pParsed)
	{
		if (pTick > pRecord.MaxTick)
		{
			pRecord.MaxTick = pTick;
		}
		if (!pSeq)
		{
			return;
		}
		if (!pRecord.Seq || !pParsed || (pRecord.Epoch !== pParsed.Epoch) || (pParsed.N >= pRecord.N))
		{
			pRecord.Seq = pSeq;
			pRecord.Epoch = pParsed ? pParsed.Epoch : null;
			pRecord.N = pParsed ? pParsed.N : 0;
		}
	}

	/**
	 * A Generations bump listener (internal-contracts §46.4).  Runs inside every write, so it only
	 * records the entity's pending change and arms the shared flush (O(tenant keys)); the
	 * per-connection work happens in flush().  Never throws.
	 *
	 * @param {Record<string, any>} pBump - internal-contracts §41.3
	 */
	onBump(pBump)
	{
		try
		{
			if (!pBump || (typeof(pBump) !== 'object') || (typeof(pBump.Entity) !== 'string') || (pBump.Entity.length < 1))
			{
				return;
			}
			if (this._Connections.size < 1)
			{
				return;
			}
			let tmpEntity = pBump.Entity;
			let tmpKeys = Array.isArray(pBump.TenantKeys) ? pBump.TenantKeys : [];
			let tmpTick = (Number.isFinite(pBump.Tick) && (pBump.Tick > 0)) ? pBump.Tick : 0;
			let tmpSeq = this.bumpSeq(pBump);
			let tmpParsed = tmpSeq ? libRetoldFacetingUtil.parseSeq(tmpSeq) : null;
			let tmpPolicy = this.hasPolicy();
			let tmpPending = null;
			let tmpGlobal = false;
			for (let i = 0; i < tmpKeys.length; i++)
			{
				let tmpKey = tmpKeys[i];
				if ((typeof(tmpKey) !== 'string') || (tmpKey.length < 1) || (tmpKey === ANY_KEY))
				{
					continue;
				}
				if ((tmpKey === GLOBAL_KEY) && tmpPolicy)
				{
					// Folded into the periodic global tick (06 §11).
					tmpGlobal = true;
					continue;
				}
				if (!tmpPending)
				{
					tmpPending = this._Pending.get(tmpEntity);
					if (tmpPending)
					{
						this._Stats.Coalesced++;
					}
					else
					{
						tmpPending = { MaxTick: 0, Seq: null, Epoch: null, N: 0, Keys: new Set(), All: false };
						this._Pending.set(tmpEntity, tmpPending);
					}
					this.mergeTick(tmpPending, tmpTick, tmpSeq, tmpParsed);
				}
				tmpPending.Keys.add(tmpKey);
				if ((tmpKey === GLOBAL_KEY) || (tmpKey.split('/')[0] === NO_TENANT_PART))
				{
					// No policy ('*'), or a Personal entity without a tenant column: every bucket.
					tmpPending.All = true;
				}
			}
			if (tmpPending)
			{
				this.armFlush();
			}
			if (tmpGlobal)
			{
				let tmpQueued = this._GlobalQueue.get(tmpEntity);
				if (!tmpQueued)
				{
					tmpQueued = { MaxTick: 0, Seq: null, Epoch: null, N: 0 };
					this._GlobalQueue.set(tmpEntity, tmpQueued);
				}
				this.mergeTick(tmpQueued, tmpTick, tmpSeq, tmpParsed);
				this.armGlobalTick();
			}
		}
		catch (pError)
		{
			this.fable.log.warn(`RetoldFaceting SSE: a bump could not be recorded: ${pError.message}`);
		}
	}

	/**
	 * Arm the shared coalescing flush (one timer for every connection and entity).
	 */
	armFlush()
	{
		if (this._FlushTimer)
		{
			return;
		}
		this._FlushTimer = setTimeout(() => { this._FlushTimer = null; this.flush(); }, this.setting('CoalesceMS'));
		this._FlushTimer.unref();
	}

	/**
	 * The shared flush: every pending entity goes to each candidate connection (its tenant buckets, or
	 * every connection for an 'All' entity) that can facet it and sees one of its tenant keys — one
	 * event per (connection, entity) per window.  Never throws.
	 */
	flush()
	{
		try
		{
			if (this._Pending.size < 1)
			{
				return;
			}
			let tmpPending = Array.from(this._Pending.entries());
			this._Pending.clear();
			for (let i = 0; i < tmpPending.length; i++)
			{
				let tmpEntity = tmpPending[i][0];
				let tmpRecord = tmpPending[i][1];
				let tmpCandidates;
				if (tmpRecord.All)
				{
					tmpCandidates = this._Connections;
				}
				else
				{
					tmpCandidates = new Set();
					tmpRecord.Keys.forEach(
						(pKey) =>
						{
							let tmpBucket = this._ByTenant.get(pKey.split('/')[0]);
							if (tmpBucket)
							{
								tmpBucket.forEach((pConnection) => { tmpCandidates.add(pConnection); });
							}
						});
				}
				tmpCandidates.forEach(
					(pConnection) =>
					{
						if (pConnection.Closed || !this.canFacet(pConnection, tmpEntity))
						{
							return;
						}
						let tmpVisible = this.visibleKeys(pConnection, tmpEntity);
						for (let j = 0; j < tmpVisible.length; j++)
						{
							if (tmpRecord.Keys.has(tmpVisible[j]))
							{
								this.deliver(pConnection, tmpEntity, tmpRecord.MaxTick, tmpRecord.Seq);
								return;
							}
						}
					});
			}
		}
		catch (pError)
		{
			this.fable.log.warn(`RetoldFaceting SSE: the change flush failed: ${pError.message}`);
		}
	}

	/**
	 * Start the periodic global tick (once; stopped when the last stream closes).
	 */
	armGlobalTick()
	{
		if (this._GlobalTimer)
		{
			return;
		}
		// Clamped: a zero tick must not become a hot loop.
		let tmpTickMS = Math.max(MIN_GLOBAL_TICK_MS, this.setting('GlobalTickMS'));
		this._GlobalTimer = setInterval(() => { this.flushGlobal(); }, tmpTickMS);
		this._GlobalTimer.unref();
	}

	/**
	 * Stop the global tick and drop what it held.
	 */
	stopGlobalTick()
	{
		if (this._GlobalTimer)
		{
			clearInterval(this._GlobalTimer);
			this._GlobalTimer = null;
		}
		this._GlobalQueue.clear();
	}

	/**
	 * The global tick: every queued '*' entity goes to every connection that can facet it
	 * (internal-contracts §46.4 rule 3).  Never throws.
	 */
	flushGlobal()
	{
		try
		{
			if (this._GlobalQueue.size < 1)
			{
				return;
			}
			let tmpQueue = Array.from(this._GlobalQueue.entries());
			this._GlobalQueue.clear();
			this._Connections.forEach(
				(pConnection) =>
				{
					for (let i = 0; i < tmpQueue.length; i++)
					{
						if (!pConnection.Closed && this.canFacet(pConnection, tmpQueue[i][0]))
						{
							this.deliver(pConnection, tmpQueue[i][0], tmpQueue[i][1].MaxTick, tmpQueue[i][1].Seq);
						}
					}
				});
		}
		catch (pError)
		{
			this.fable.log.warn(`RetoldFaceting SSE: the global tick failed: ${pError.message}`);
		}
	}

	// ---------------------------------------------------------------- housekeeping

	/**
	 * The shared housekeeping period: the heartbeat, or a quarter of RevalidateMS when that is
	 * shorter (clamped); 0 when both are off.
	 *
	 * @return {number}
	 */
	housekeepingMS()
	{
		let tmpHeartbeatMS = this.setting('HeartbeatMS');
		let tmpRevalidateMS = this.setting('RevalidateMS');
		let tmpPeriods = [];
		if (tmpHeartbeatMS > 0)
		{
			tmpPeriods.push(tmpHeartbeatMS);
		}
		if (tmpRevalidateMS > 0)
		{
			tmpPeriods.push(tmpRevalidateMS / 4);
		}
		return (tmpPeriods.length > 0) ? Math.max(MIN_HOUSEKEEPING_MS, Math.round(Math.min(...tmpPeriods))) : 0;
	}

	/**
	 * Start the shared housekeeping timer (once; stopped when the last stream closes).
	 */
	armHousekeeping()
	{
		if (this._HousekeepingTimer)
		{
			return;
		}
		let tmpPeriodMS = this.housekeepingMS();
		if (tmpPeriodMS <= 0)
		{
			return;
		}
		this._HousekeepingTimer = setInterval(() => { this.housekeeping(); }, tmpPeriodMS);
		this._HousekeepingTimer.unref();
	}

	/**
	 * Stop the shared housekeeping timer.
	 */
	stopHousekeeping()
	{
		if (this._HousekeepingTimer)
		{
			clearInterval(this._HousekeepingTimer);
			this._HousekeepingTimer = null;
		}
	}

	/**
	 * One housekeeping pass over every stream: due heartbeats (skipped while blocked), streams blocked
	 * longer than STALL_HEARTBEATS × HeartbeatMS closed (P10), due revalidations.  Never throws.
	 */
	housekeeping()
	{
		try
		{
			let tmpNow = Date.now();
			let tmpHeartbeatMS = this.setting('HeartbeatMS');
			Array.from(this._Connections).forEach(
				(pConnection) =>
				{
					if (pConnection.Closed)
					{
						return;
					}
					if (pConnection.Blocked)
					{
						if ((tmpHeartbeatMS > 0) && (pConnection.BlockedSince !== null) && ((tmpNow - pConnection.BlockedSince) > (STALL_HEARTBEATS * tmpHeartbeatMS)))
						{
							this._Stats.Stalled++;
							this.fable.log.info(`RetoldFaceting SSE: stream ${pConnection.ID} closed (its consumer stopped reading).`);
							this.close(pConnection, null);
							this.destroySocket(pConnection.Socket);
						}
						return;
					}
					if ((tmpHeartbeatMS > 0) && (tmpNow >= pConnection.NextHeartbeatAt))
					{
						pConnection.NextHeartbeatAt = tmpNow + tmpHeartbeatMS;
						if (this.write(pConnection, ': hb\n\n', false))
						{
							this._Stats.Heartbeats++;
						}
					}
					if ((pConnection.RevalidateAt !== null) && (tmpNow >= pConnection.RevalidateAt) && !pConnection.Closed)
					{
						this.revalidate(pConnection);
					}
				});
		}
		catch (pError)
		{
			this.fable.log.warn(`RetoldFaceting SSE: housekeeping failed: ${pError.message}`);
		}
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Revalidate a stream at its revalidation time (S2).  The session the stream opened with is a
	 * snapshot (the session layer resolved it once for this request), so it cannot be re-read from the
	 * request: without a host hook the stream ends with closed { Reason: 'Revalidate' } and the client
	 * reconnects through the host's full authentication.  A host whose sessions live in a store
	 * implements Host.revalidatePrincipal(pRequest, fCallback(pError, pPrincipal)); an error, a
	 * non-User principal or a different principal key then closes the stream, anything else keeps it
	 * (caches refreshed, next revalidation scheduled).
	 *
	 * @param {Record<string, any>} pConnection
	 */
	revalidate(pConnection)
	{
		if (pConnection.Closed || pConnection.Revalidating)
		{
			return;
		}
		let tmpHost = this.host();
		if (!tmpHost || (typeof(tmpHost.revalidatePrincipal) !== 'function'))
		{
			this._Stats.Revalidated++;
			return this.close(pConnection, 'Revalidate');
		}
		pConnection.Revalidating = true;
		let tmpCalledBack = false;
		let fDone = (pError, pPrincipal) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			pConnection.Revalidating = false;
			if (pConnection.Closed)
			{
				return;
			}
			this._Stats.Revalidated++;
			if (pError || !pPrincipal || (pPrincipal.Kind !== 'User') || (libRetoldFacetingUtil.principalKey(pPrincipal) !== pConnection.PrincipalKey))
			{
				this.fable.log.info(`RetoldFaceting SSE: stream ${pConnection.ID} closed on revalidation.`);
				return this.close(pConnection, 'Revalidate');
			}
			let tmpContext = this.newContext(pConnection.Request);
			tmpContext.Principal = pPrincipal;
			pConnection.Context = tmpContext;
			pConnection.Principal = pPrincipal;
			pConnection.CanFacet.clear();
			pConnection.VisibleKeys.clear();
			let tmpRevalidateMS = this.setting('RevalidateMS');
			pConnection.RevalidateAt = (tmpRevalidateMS > 0) ? (Date.now() + tmpRevalidateMS) : null;
			if (pConnection.RevalidateAgain)
			{
				// revalidateAll() was called while this one ran (it may have read the old rights): once more.
				pConnection.RevalidateAgain = false;
				pConnection.RevalidateAt = 0;
				this.scheduleRevalidation();
			}
		};
		try
		{
			tmpHost.revalidatePrincipal(pConnection.Request, fDone);
		}
		catch (pError)
		{
			fDone(pError);
		}
	}

	/**
	 * Revalidate open streams now (a host calls it when something a principal's rights depend on changed;
	 * the RAFS host does on every role-table write): every stream, or only those whose tenant Part is
	 * one of pTenants (tenant values; a stream without a tenant Part — no policy column — is always
	 * included).  Each stream's per-entity caches are dropped and its revalidation runs on the next tick
	 * (one pass for a burst of calls); a stream whose revalidation is already in flight runs once more
	 * after it.  Without Host.revalidatePrincipal the streams close with { Reason: 'Revalidate' } (the
	 * client reconnects).  Never throws.
	 *
	 * @param {Array<any>|null} [pTenants] - null / omitted: every stream
	 * @return {number} the streams marked
	 */
	revalidateAll(pTenants)
	{
		let tmpParts = null;
		if (Array.isArray(pTenants) && (pTenants.length > 0))
		{
			let tmpGenerations = this.fable.RetoldFacetingGenerations;
			tmpParts = new Set();
			pTenants.forEach(
				(pTenant) =>
				{
					tmpParts.add((tmpGenerations && (typeof(tmpGenerations.tenantKey) === 'function')) ? tmpGenerations.tenantKey(pTenant)
						: encodeURIComponent(String(libRetoldFacetingUtil.normalizeScopeValue(pTenant))).replace(/\*/g, '%2A'));
				});
		}
		let tmpMarked = 0;
		this._Connections.forEach(
			(pConnection) =>
			{
				if (pConnection.Closed)
				{
					return;
				}
				if (tmpParts && (pConnection.TenantPart !== GLOBAL_KEY) && !tmpParts.has(pConnection.TenantPart))
				{
					return;
				}
				pConnection.CanFacet.clear();
				pConnection.VisibleKeys.clear();
				if (pConnection.Revalidating)
				{
					pConnection.RevalidateAgain = true;
				}
				else
				{
					pConnection.RevalidateAt = 0;
				}
				tmpMarked++;
			});
		if (tmpMarked > 0)
		{
			this.scheduleRevalidation();
		}
		return tmpMarked;
	}

	/**
	 * Run the due revalidations on the next tick (at most one pending pass).
	 */
	scheduleRevalidation()
	{
		if (this._RevalidateSoon)
		{
			return;
		}
		this._RevalidateSoon = setImmediate(
			() =>
			{
				this._RevalidateSoon = null;
				try
				{
					let tmpNow = Date.now();
					Array.from(this._Connections).forEach(
						(pConnection) =>
						{
							if (!pConnection.Closed && (pConnection.RevalidateAt !== null) && (tmpNow >= pConnection.RevalidateAt))
							{
								this.revalidate(pConnection);
							}
						});
				}
				catch (pError)
				{
					this.fable.log.warn(`RetoldFaceting SSE: the revalidation pass failed: ${pError.message}`);
				}
			});
	}

	/**
	 * End one stream: unindex it, write 'closed' { Reason } when the server is the one closing (and
	 * then end the TCP connection), and call fNext(false) once.
	 *
	 * @param {Record<string, any>} pConnection
	 * @param {string|null} pReason - 'Shutdown' | 'Revalidate'; null when the client went away (or stalled)
	 */
	close(pConnection, pReason)
	{
		if (!pConnection || pConnection.Closed)
		{
			return;
		}
		// Closed first: a 'close' / 'error' the writes below provoke must not re-enter.
		pConnection.Closed = true;
		if (pReason)
		{
			// The last frame (written past backpressure: the stream ends right after it).
			try
			{
				pConnection.Response.write(`event: closed\ndata: ${JSON.stringify({ Reason: pReason })}\n\n`);
				pConnection.Sent++;
				this._Stats.Sent++;
			}
			catch (pWriteError)
			{
				// The peer is already gone.
			}
		}
		pConnection.Pending.clear();
		this.unindex(pConnection);
		this._Stats.Closed++;

		let tmpResponse = pConnection.Response;
		try
		{
			if (tmpResponse && !tmpResponse.writableEnded && !tmpResponse.destroyed)
			{
				tmpResponse.end();
			}
		}
		catch (pEndError)
		{
			// The peer is already gone.
		}
		if (pReason)
		{
			this.endSocket(pConnection.Socket);
		}
		if (this._Connections.size < 1)
		{
			this.stopGlobalTick();
			this.stopHousekeeping();
			if (this._FlushTimer)
			{
				clearTimeout(this._FlushTimer);
				this._FlushTimer = null;
			}
			this._Pending.clear();
		}
		try
		{
			pConnection.Finish();
		}
		catch (pFinishError)
		{
			this.fable.log.warn(`RetoldFaceting SSE: the route chain could not be ended: ${pFinishError.message}`);
		}
	}

	/**
	 * Destroy a socket now (a consumer that stopped reading).
	 *
	 * @param {any} pSocket
	 */
	destroySocket(pSocket)
	{
		try
		{
			if (pSocket && !pSocket.destroyed && (typeof(pSocket.destroy) === 'function'))
			{
				pSocket.destroy();
			}
		}
		catch (pError)
		{
			// Already gone.
		}
	}

	/**
	 * End the TCP connection of a server-closed stream (after its last bytes), destroying it when the
	 * peer does not read within a short grace (the fallback timer is unref'd and cleared on close).
	 *
	 * @param {any} pSocket
	 */
	endSocket(pSocket)
	{
		if (!pSocket || pSocket.destroyed || (typeof(pSocket.end) !== 'function'))
		{
			return;
		}
		try
		{
			pSocket.end();
		}
		catch (pError)
		{
			return;
		}
		if (typeof(pSocket.destroy) !== 'function')
		{
			return;
		}
		let tmpTimer = setTimeout(
			() =>
			{
				this._SocketTimers.delete(tmpTimer);
				if (!pSocket.destroyed)
				{
					pSocket.destroy();
				}
			}, SOCKET_DESTROY_GRACE_MS);
		tmpTimer.unref();
		this._SocketTimers.add(tmpTimer);
		if (typeof(pSocket.once) === 'function')
		{
			pSocket.once('close',
				() =>
				{
					clearTimeout(tmpTimer);
					this._SocketTimers.delete(tmpTimer);
				});
		}
	}

	/**
	 * Tell every open stream the model was reloaded (event 'model'); the per-entity caches are
	 * dropped (facetability and entity kinds may have changed).  Never throws.
	 */
	broadcastModelChanged()
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		let tmpModelVersion = null;
		try
		{
			tmpModelVersion = (tmpCatalog && (typeof(tmpCatalog.modelVersion) === 'function')) ? tmpCatalog.modelVersion() : null;
		}
		catch (pError)
		{
			tmpModelVersion = null;
		}
		Array.from(this._Connections).forEach(
			(pConnection) =>
			{
				pConnection.CanFacet.clear();
				pConnection.VisibleKeys.clear();
				this.writeEvent(pConnection, 'model', { ModelVersion: tmpModelVersion });
			});
	}

	/**
	 * End every open stream with event 'closed' { Reason } and clear every timer (service shutdown).
	 *
	 * @param {string} [pReason] - 'Shutdown' by default
	 */
	closeAll(pReason)
	{
		let tmpReason = (CLOSE_REASONS.indexOf(pReason) >= 0) ? pReason : 'Shutdown';
		Array.from(this._Connections).forEach((pConnection) => { this.close(pConnection, tmpReason); });
		this.stopGlobalTick();
		this.stopHousekeeping();
		if (this._RevalidateSoon)
		{
			clearImmediate(this._RevalidateSoon);
			this._RevalidateSoon = null;
		}
		if (this._FlushTimer)
		{
			clearTimeout(this._FlushTimer);
			this._FlushTimer = null;
		}
		this._Pending.clear();
	}

	/**
	 * @return {Array<{ PrincipalKey: string, OpenedAt: number, Sent: number }>} (tests)
	 */
	connections()
	{
		return Array.from(this._Connections).map(
			(pConnection) =>
			{
				return { PrincipalKey: pConnection.PrincipalKey, OpenedAt: pConnection.OpenedAt, Sent: pConnection.Sent };
			});
	}

	/**
	 * How many timers this service holds (tests: none survive closeAll / the last close).
	 *
	 * @return {number}
	 */
	timerCount()
	{
		return (this._GlobalTimer ? 1 : 0) + (this._FlushTimer ? 1 : 0) + (this._HousekeepingTimer ? 1 : 0) + (this._RevalidateSoon ? 1 : 0) + this._SocketTimers.size;
	}

	/**
	 * @return {Record<string, any>} internal-contracts §46.5
	 */
	stats()
	{
		return Object.assign({ Connections: this._Connections.size, Principals: this._ByPrincipal.size, Tenants: this._ByTenant.size, Enabled: this.enabled() }, this._Stats, { Refused: Object.assign({}, this._Stats.Refused) });
	}
}

module.exports = RetoldFacetingSSE;
module.exports.serviceType = 'RetoldFacetingSSE';
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.CLOSE_REASONS = CLOSE_REASONS;
