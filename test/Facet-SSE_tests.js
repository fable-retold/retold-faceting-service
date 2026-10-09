/**
 * Facet-SSE: GET /1.0/Facet/Changes — authorization, event content, tenant / owner filtering, coalescing, heartbeat, limits and shutdown.
 *
 * Owner: builder C (M4).  Obligations: internal-contracts §46, §49.1.  Registry port: 19134 (the
 * harnesses bind ephemeral ports; 19134 names the runs).
 *
 *   - 401 for an anonymous principal (with and without a scope policy) and an unset tenant;
 *   - the SSE headers, the retry frame and the ready event (Reset on Last-Event-ID);
 *   - a bump in the principal's tenant → one 'generation' event carrying ONLY { Entity, Generation,
 *     Seq }; another tenant's bump → nothing; a move reaches both tenants; '#any' never;
 *   - Personal (LabTrack LabForm): the owner's key is forwarded, a colleague's is not; an unknown
 *     owner reaches every owner of the tenant;
 *   - '*' bumps only through the global tick under a policy; immediately without one;
 *   - non-facetable / unknown entities never;
 *   - coalescing (many bumps within CoalesceMS → one event with the latest Seq), the opaque
 *     per-principal Generation, the heartbeat, backpressure (held until 'drain');
 *   - 429 per principal / tenant / total (refuse new, never evict old);
 *   - revalidation closes a stream whose principal changed or logged out, keeps an unchanged one;
 *   - model broadcasts, IncludeSeq false;
 *   - closeAll ends every stream with 'closed' { Reason } and harness.stop completes with streams
 *     open; no timer survives.
 *
 * Bumps are injected two ways: directly through SSE.onBump (synthetic §41.3 bump records, exact
 * tenant keys) and through Generations.applyChange with the 'SSE' bump listener (the wiring's
 * subscription, §44.10), so the stream is checked against the real key derivation.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libCrypto = require('crypto');
const libEvents = require('events');
const libHttp = require('http');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libSSE = require('../source/routes/Retold-Faceting-SSE.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');

const PORT = 19134;

// Small, test-friendly SSE settings (internal-contracts §49.1: keep npm test fast).  IncludeSeq is
// explicit: the default ('Auto') omits the node-wide Seq on a policy host (§51.10); its own test
// checks that.
const SSE_TEST_OPTIONS = (
	{
		CoalesceMS: 15,
		HeartbeatMS: 60,
		GlobalTickMS: 80,
		RevalidateMS: 60000,
		RetryMS: 1500,
		MaxPerPrincipal: 2,
		MaxPerTenant: 3,
		MaxConnections: 4,
		IncludeSeq: true
	});

// How long "nothing arrives" is watched for (several coalescing windows).
const QUIET_MS = 60;

// Test-local tick / seq counters for synthetic bumps (far above anything Generations hands out here).
let _Tick = 100000;
let _SeqN = 500000;

/**
 * Poll a condition until it holds or the time runs out.
 *
 * @param {() => boolean} fCondition
 * @param {number} pTimeoutMS
 * @param {(pError?: Error) => void} fCallback
 * @param {string} [pWhat]
 */
const waitFor = (fCondition, pTimeoutMS, fCallback, pWhat) =>
{
	let tmpStart = Date.now();
	let fCheck = () =>
	{
		let tmpHolds = false;
		try
		{
			tmpHolds = fCondition();
		}
		catch (pError)
		{
			return fCallback(pError);
		}
		if (tmpHolds)
		{
			return fCallback();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fCallback(new Error(`timed out after ${pTimeoutMS} ms waiting for ${pWhat || 'a condition'}`));
		}
		setTimeout(fCheck, 5);
	};
	fCheck();
};

/**
 * Wait a fixed time (only where the property is "nothing happens").
 *
 * @param {number} pMS
 * @param {Function} fCallback
 */
const quiet = (pMS, fCallback) =>
{
	setTimeout(() => { fCallback(); }, pMS);
};

/**
 * Parse every complete SSE frame in the stream's buffer (a frame ends with a blank line).
 *
 * @param {Record<string, any>} pStream
 */
const parseFrames = (pStream) =>
{
	let tmpIndex = pStream.Buffer.indexOf('\n\n');
	while (tmpIndex >= 0)
	{
		let tmpBlock = pStream.Buffer.slice(0, tmpIndex);
		pStream.Buffer = pStream.Buffer.slice(tmpIndex + 2);
		let tmpFrame = { Event: null, Data: null, ID: null, Retry: null, Comment: null, Fields: [], Raw: tmpBlock };
		let tmpData = [];
		tmpBlock.split('\n').forEach(
			(pLine) =>
			{
				if (pLine.indexOf(':') === 0)
				{
					tmpFrame.Comment = pLine.slice(1).trim();
					return;
				}
				let tmpColon = pLine.indexOf(':');
				let tmpField = (tmpColon < 0) ? pLine : pLine.slice(0, tmpColon);
				let tmpValue = (tmpColon < 0) ? '' : pLine.slice(tmpColon + 1).replace(/^ /, '');
				tmpFrame.Fields.push(tmpField);
				if (tmpField === 'event')
				{
					tmpFrame.Event = tmpValue;
				}
				else if (tmpField === 'data')
				{
					tmpData.push(tmpValue);
				}
				else if (tmpField === 'id')
				{
					tmpFrame.ID = tmpValue;
				}
				else if (tmpField === 'retry')
				{
					tmpFrame.Retry = Number(tmpValue);
				}
			});
		if (tmpData.length > 0)
		{
			tmpFrame.Data = JSON.parse(tmpData.join('\n'));
		}
		pStream.Frames.push(tmpFrame);
		tmpIndex = pStream.Buffer.indexOf('\n\n');
	}
};

/**
 * The open client streams of the running test (closed by teardown).
 */
let _OpenStreams = [];

/**
 * Open GET /1.0/Facet/Changes as a principal.  Calls back once the answer is known: for a 200 after
 * the ready event (the server has registered the connection), else after the JSON error body.
 *
 * @param {Record<string, any>} pHarness
 * @param {{ Tenant?: number, User?: number, Headers?: Record<string, string> }} pOptions
 * @param {(pError?: Error, pStream?: Record<string, any>) => void} fCallback
 */
const openStream = (pHarness, pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	let tmpHeaders = Object.assign({ accept: 'text/event-stream' }, tmpOptions.Headers || {});
	if (typeof(tmpOptions.Tenant) === 'number')
	{
		tmpHeaders['x-facet-test-tenant'] = String(tmpOptions.Tenant);
	}
	if (typeof(tmpOptions.User) === 'number')
	{
		tmpHeaders['x-facet-test-user'] = String(tmpOptions.User);
	}
	let tmpStream = { Status: null, Headers: null, Buffer: '', Text: '', Frames: [], Body: null, Ended: false, Error: null, Request: null };
	let tmpCalledBack = false;
	let fDone = (pError) =>
	{
		if (tmpCalledBack)
		{
			return;
		}
		tmpCalledBack = true;
		setImmediate(() => { fCallback(pError, tmpStream); });
	};
	tmpStream.close = () =>
	{
		if (tmpStream.Request && !tmpStream.Request.destroyed)
		{
			tmpStream.Request.destroy();
		}
	};
	tmpStream.events = (pType) =>
	{
		return tmpStream.Frames.filter((pFrame) => { return pFrame.Event === pType; });
	};
	tmpStream.generations = (pEntity) =>
	{
		return tmpStream.events('generation').filter((pFrame) => { return !pEntity || (pFrame.Data && (pFrame.Data.Entity === pEntity)); });
	};
	tmpStream.Request = libHttp.get(
		{
			hostname: '127.0.0.1',
			port: pHarness.port,
			path: '/1.0/Facet/Changes',
			headers: tmpHeaders,
			agent: false
		},
		(pResponse) =>
		{
			tmpStream.Status = pResponse.statusCode;
			tmpStream.Headers = pResponse.headers;
			pResponse.setEncoding('utf8');
			pResponse.on('data',
				(pChunk) =>
				{
					tmpStream.Text += pChunk;
					if (tmpStream.Status === 200)
					{
						tmpStream.Buffer += pChunk;
						parseFrames(tmpStream);
						if (tmpStream.events('ready').length > 0)
						{
							fDone();
						}
					}
				});
			pResponse.on('end',
				() =>
				{
					tmpStream.Ended = true;
					if (tmpStream.Status !== 200)
					{
						try
						{
							tmpStream.Body = JSON.parse(tmpStream.Text);
						}
						catch (pParseError)
						{
							tmpStream.Body = tmpStream.Text;
						}
					}
					fDone();
				});
			pResponse.on('error', () => { tmpStream.Ended = true; });
			pResponse.on('close', () => { tmpStream.Ended = true; });
		});
	tmpStream.Request.on('error',
		(pError) =>
		{
			tmpStream.Error = pError;
			tmpStream.Ended = true;
			fDone(pError);
		});
	_OpenStreams.push(tmpStream);
};

/**
 * Open several streams in order; calls back with them all.
 *
 * @param {Record<string, any>} pHarness
 * @param {Array<Record<string, any>>} pPrincipals
 * @param {(pError?: Error, pStreams?: Array<Record<string, any>>) => void} fCallback
 */
const openStreams = (pHarness, pPrincipals, fCallback) =>
{
	let tmpStreams = [];
	let fNext = (pIndex) =>
	{
		if (pIndex >= pPrincipals.length)
		{
			return fCallback(null, tmpStreams);
		}
		openStream(pHarness, pPrincipals[pIndex],
			(pError, pStream) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				tmpStreams.push(pStream);
				return fNext(pIndex + 1);
			});
	};
	fNext(0);
};

/**
 * Close every client stream of the test and wait until the server has dropped them.
 *
 * @param {any} pSSE
 * @param {Function} fDone
 */
const closeStreams = (pSSE, fDone) =>
{
	_OpenStreams.forEach((pStream) => { pStream.close(); });
	_OpenStreams = [];
	if (!pSSE)
	{
		return fDone();
	}
	waitFor(() => { return pSSE.stats().Connections === 0; }, 2000, fDone, 'the server to drop every stream');
};

/**
 * A synthetic bump record (internal-contracts §41.3) with the given tenant keys.
 *
 * @param {any} pIntake - RetoldFacetingChangeIntake (for its NodeEpoch)
 * @param {string} pEntity
 * @param {Array<string>} pTenantKeys
 * @return {Record<string, any>}
 */
const bumpRecord = (pIntake, pEntity, pTenantKeys) =>
{
	_Tick++;
	_SeqN++;
	return (
		{
			Entity: pEntity,
			Tick: _Tick,
			At: Date.now(),
			Seq: libRetoldFacetingUtil.formatSeq(pIntake.NodeEpoch, _SeqN),
			Source: 'Interim',
			Operation: 'Update',
			TenantKeys: pTenantKeys.slice(),
			Columns: [ '#all' ],
			Keys: []
		});
};

/**
 * The principal key the server computes for a harness principal (resolved like a facet request).
 *
 * @param {Record<string, any>} pHarness
 * @param {{ Tenant?: number, User?: number }} pPrincipal
 * @param {(pError?: Error, pKey?: string) => void} fCallback
 */
const principalKeyOf = (pHarness, pPrincipal, fCallback) =>
{
	let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, SessionID: 'x', UserID: pPrincipal.User, IDUser: pPrincipal.User, IDTenant: pPrincipal.Tenant, CustomerID: pPrincipal.Tenant } };
	pHarness.faceting.Host.resolvePrincipal(tmpRequest,
		(pError, pResolved) =>
		{
			return fCallback(pError, pError ? null : libRetoldFacetingUtil.principalKey(pResolved));
		});
};

/**
 * The server-side connection object of a principal key (tests reach into the service for the
 * revalidation case, where the session behind an open stream changes).
 *
 * @param {any} pSSE
 * @param {string} pPrincipalKey
 * @return {Record<string, any>|null}
 */
const serverConnection = (pSSE, pPrincipalKey) =>
{
	return Array.from(pSSE._Connections).find((pConnection) => { return pConnection.PrincipalKey === pPrincipalKey; }) || null;
};

/**
 * A fake restify response for in-process handler tests (EventEmitter + the methods SSE uses).
 *
 * @return {Record<string, any>}
 */
const fakeResponse = () =>
{
	let tmpResponse = new libEvents.EventEmitter();
	tmpResponse.Status = null;
	tmpResponse.StatusHeaders = null;
	tmpResponse.Headers = {};
	tmpResponse.Chunks = [];
	tmpResponse.Sent = null;
	tmpResponse.WriteResult = true;
	tmpResponse.headersSent = false;
	tmpResponse.writableEnded = false;
	tmpResponse.destroyed = false;
	tmpResponse.socket = { setTimeout: () => {}, setNoDelay: () => {}, end: () => { tmpResponse.SocketEnded = true; }, destroy: () => {}, once: () => {}, destroyed: false };
	tmpResponse.header = (pName, pValue) => { tmpResponse.Headers[pName] = pValue; };
	tmpResponse.send = (pStatus, pBody) => { tmpResponse.Status = pStatus; tmpResponse.Sent = pBody; tmpResponse.headersSent = true; tmpResponse.writableEnded = true; };
	tmpResponse.writeHead = (pStatus, pHeaders) => { tmpResponse.Status = pStatus; tmpResponse.StatusHeaders = pHeaders; tmpResponse.headersSent = true; };
	tmpResponse.write = (pText) => { tmpResponse.Chunks.push(pText); return tmpResponse.WriteResult; };
	tmpResponse.end = () => { tmpResponse.writableEnded = true; };
	tmpResponse.frames = () =>
	{
		let tmpStream = { Buffer: tmpResponse.Chunks.join(''), Frames: [] };
		parseFrames(tmpStream);
		return tmpStream.Frames;
	};
	return tmpResponse;
};

suite
(
	'Facet-SSE',
	() =>
	{
		suite
		(
			'service (no host)',
			() =>
			{
				test('constructs with no connections, lists the event types, mounts nothing without a server or when disabled',
					() =>
					{
						let tmpSSE = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'));
						Expect(tmpSSE.stats()).to.deep.equal({ Connections: 0, Principals: 0, Tenants: 0, Enabled: false, Opened: 0, Refused: {}, Sent: 0, Coalesced: 0, Heartbeats: 0, Closed: 0, Revalidated: 0, Stalled: 0 });
						Expect(libSSE.EVENT_TYPES).to.deep.equal([ 'ready', 'generation', 'model', 'closed' ]);
						Expect(tmpSSE.connect(null)).to.equal(false);
						Expect(tmpSSE.connections()).to.deep.equal([]);
						Expect(tmpSSE.timerCount()).to.equal(0);

						let tmpDisabled = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'), { SSE: { Enabled: false } });
						let tmpMounted = [];
						Expect(tmpDisabled.connect({ get: (pRoute) => { tmpMounted.push(pRoute); } })).to.equal(false);
						Expect(tmpMounted).to.deep.equal([]);

						// 'Auto' (the default) mounts only on a host with a scope policy (none here); true always.
						let tmpAuto = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'));
						Expect(tmpAuto.enabled()).to.equal(false);
						Expect(tmpAuto.connect({ get: (pRoute) => { tmpMounted.push(pRoute); } })).to.equal(false);
						Expect(tmpMounted).to.deep.equal([]);
						let tmpEnabled = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'), { RoutePrefix: '/2.0/Facets', SSE: { Enabled: true } });
						let tmpServer = { get: (pRoute, fHandler) => { tmpMounted.push([ pRoute, typeof(fHandler) ]); } };
						Expect(tmpEnabled.connect(tmpServer)).to.equal(true);
						Expect(tmpEnabled.connect(tmpServer)).to.equal(true);
						Expect(tmpMounted).to.deep.equal([ [ '/2.0/Facets/Changes', 'function' ] ]);
					});

				test('without a host the route answers 500 FACET_INTERNAL, never throws and ends the chain once',
					() =>
					{
						let tmpSSE = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'));
						let tmpResponse = fakeResponse();
						let tmpNext = [];
						let tmpReturned = tmpSSE.handleChanges({ headers: {} }, tmpResponse, (pValue) => { tmpNext.push(pValue); });
						Expect(tmpReturned).to.equal(undefined);
						Expect(tmpResponse.Status).to.equal(500);
						Expect(tmpResponse.Sent.Error.Code).to.equal('FACET_INTERNAL');
						Expect(tmpResponse.Headers['X-Retold-Facet-Contract']).to.equal('1');
						Expect(tmpNext).to.deep.equal([ false ]);
					});

				test('onBump, broadcastModelChanged and closeAll are harmless without connections or with garbage',
					() =>
					{
						let tmpSSE = new libSSE(libBuilders.newFable('RetoldFacetingSSETest'));
						[ null, undefined, 7, 'x', {}, { Entity: 5 }, { Entity: '' }, { Entity: 'Project', TenantKeys: 'x' } ].forEach(
							(pBump) =>
							{
								Expect(() => { tmpSSE.onBump(pBump); }).to.not.throw();
							});
						Expect(() => { tmpSSE.broadcastModelChanged(); }).to.not.throw();
						Expect(() => { tmpSSE.closeAll(); }).to.not.throw();
						Expect(tmpSSE.stats()).to.include({ Connections: 0, Sent: 0 });
					});
			}
		);

		suite
		(
			'ProjectTrack (tenant policy)',
			() =>
			{
				let _Harness = null;
				let _SSE = null;
				let _Intake = null;
				let _Restore = [];
				let _Lead = null;
				let _Member = null;
				let _Outsider = null;
				let _OtherLead = null;

				/**
				 * Change one SSE option for the rest of the test (restored by teardown).
				 */
				let fSetOption = (pName, pValue) =>
				{
					let tmpOptions = _SSE.options.SSE;
					let tmpHad = Object.prototype.hasOwnProperty.call(tmpOptions, pName);
					let tmpOld = tmpOptions[pName];
					tmpOptions[pName] = pValue;
					_Restore.push(() => { if (tmpHad) { tmpOptions[pName] = tmpOld; } else { delete tmpOptions[pName]; } });
				};

				suiteSetup(
					(fDone) =>
					{
						_Harness = libHarness.start(
							{
								Port: PORT,
								Fixture: 'ProjectTrack',
								Faceting: { SSE: SSE_TEST_OPTIONS, Catalog: { NeverFacet: [ 'Issue' ] } }
							},
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_SSE = _Harness.fable.RetoldFacetingSSE;
								_Intake = _Harness.fable.RetoldFacetingChangeIntake;
								// The wiring mounts the route and subscribes the listener at attach; both are idempotent.
								Expect(_SSE.connect(_Harness.faceting.Host.getServiceServer())).to.equal(true);
								_Harness.fable.RetoldFacetingGenerations.subscribe('SSE', (pBump) => { _SSE.onBump(pBump); });
								_Lead = _Harness.as('Lead');
								_Member = _Harness.as('Member');
								_Outsider = _Harness.as('Outsider');
								_OtherLead = _Harness.as('OtherLead');
								return fDone();
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						closeStreams(_SSE,
							() =>
							{
								_Harness.stop(fDone);
							});
					});

				teardown(
					(fDone) =>
					{
						while (_Restore.length > 0)
						{
							_Restore.pop()();
						}
						closeStreams(_SSE, fDone);
					});

				test('an anonymous principal is 401 before any stream opens',
					(fDone) =>
					{
						let tmpOpened = _SSE.stats().Opened;
						openStream(_Harness, {},
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStream.Status).to.equal(401);
								Expect(pStream.Body.Error).to.deep.equal({ Code: 'FACET_UNAUTHENTICATED', Status: 401, Message: 'Authentication required.' });
								Expect(pStream.Headers['x-retold-facet-contract']).to.equal('1');
								Expect(pStream.Headers['content-type']).to.match(/^application\/json/);
								Expect(_SSE.stats()).to.include({ Connections: 0, Opened: tmpOpened });
								return fDone();
							});
					});

				test('a principal with an unset tenant value is 401',
					(fDone) =>
					{
						openStream(_Harness, { Tenant: 0, User: 1 },
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStream.Status).to.equal(401);
								Expect(pStream.Body.Error.Code).to.equal('FACET_UNAUTHENTICATED');
								Expect(_SSE.stats().Connections).to.equal(0);
								return fDone();
							});
					});

				test('the stream opens with the SSE headers, a retry frame and the ready event',
					(fDone) =>
					{
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStream.Status).to.equal(200);
								Expect(pStream.Headers['content-type']).to.equal('text/event-stream; charset=utf-8');
								Expect(pStream.Headers['cache-control']).to.equal('no-cache, no-transform');
								Expect(pStream.Headers['x-accel-buffering']).to.equal('no');
								Expect(pStream.Headers['vary']).to.equal('Cookie, Authorization');
								Expect(pStream.Headers['x-retold-facet-contract']).to.equal('1');
								Expect(pStream.Headers['connection']).to.equal('keep-alive');
								// First frame: retry only.
								Expect(pStream.Frames[0].Fields).to.deep.equal([ 'retry' ]);
								// Jittered up to +50 % so streams cut together do not all come back together.
								Expect(pStream.Frames[0].Retry).to.be.within(SSE_TEST_OPTIONS.RetryMS, SSE_TEST_OPTIONS.RetryMS * 1.5);
								let tmpReady = pStream.Frames[1];
								Expect(tmpReady.Event).to.equal('ready');
								Expect(tmpReady.ID).to.equal(null);
								Expect(Object.keys(tmpReady.Data)).to.deep.equal([ 'NodeEpoch', 'Seq', 'CoalesceMS', 'HeartbeatMS', 'Reset' ]);
								Expect(tmpReady.Data.NodeEpoch).to.equal(_Intake.NodeEpoch);
								Expect(tmpReady.Data.NodeEpoch).to.match(libRetoldFacetingUtil.NODE_EPOCH_PATTERN);
								Expect(tmpReady.Data.Seq).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
								Expect(libRetoldFacetingUtil.parseSeq(tmpReady.Data.Seq).Epoch).to.equal(_Intake.NodeEpoch);
								Expect(tmpReady.Data).to.include({ CoalesceMS: SSE_TEST_OPTIONS.CoalesceMS, HeartbeatMS: SSE_TEST_OPTIONS.HeartbeatMS, Reset: false });
								principalKeyOf(_Harness, _Lead,
									(pKeyError, pKey) =>
									{
										Expect(pKeyError).to.not.exist;
										Expect(_SSE.stats()).to.include({ Connections: 1, Principals: 1 });
										let tmpConnections = _SSE.connections();
										Expect(tmpConnections).to.have.length(1);
										Expect(tmpConnections[0].PrincipalKey).to.equal(pKey);
										Expect(tmpConnections[0].Sent).to.equal(1);
										Expect(tmpConnections[0].OpenedAt).to.be.a('number');
										return fDone();
									});
							});
					});

				test('a Last-Event-ID marks the ready event Reset (events are not replayed)',
					(fDone) =>
					{
						openStream(_Harness, Object.assign({ Headers: { 'last-event-id': 'e:00000000:12' } }, _Lead),
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStream.events('ready')[0].Data.Reset).to.equal(true);
								Expect(pStream.generations()).to.have.length(0);
								return fDone();
							});
					});

				test('a bump in the principal\'s tenant sends ONE generation event with only Entity, Generation and Seq; another tenant hears nothing',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpBump = bumpRecord(_Intake, 'Project', [ '#any', '1' ]);
								_SSE.onBump(tmpBump);
								waitFor(() => { return pStreams[0].generations().length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										quiet(QUIET_MS,
											() =>
											{
												let tmpEvents = pStreams[0].generations();
												Expect(tmpEvents).to.have.length(1);
												// No 'id:' line: events are not replayed, and an id would carry the Seq.
												Expect(tmpEvents[0].Fields).to.deep.equal([ 'event', 'data' ]);
												Expect(tmpEvents[0].ID).to.equal(null);
												Expect(Object.keys(tmpEvents[0].Data)).to.deep.equal([ 'Entity', 'Generation', 'Seq' ]);
												Expect(tmpEvents[0].Data.Entity).to.equal('Project');
												Expect(tmpEvents[0].Data.Seq).to.equal(tmpBump.Seq);
												Expect(tmpEvents[0].Data.Generation).to.match(/^g:[0-9a-f]{12}$/);
												// Nothing about the tenant, the tick or the columns travels.
												Expect(tmpEvents[0].Raw).to.not.include(String(tmpBump.Tick));
												Expect(tmpEvents[0].Raw).to.not.include('#all');
												Expect(pStreams[1].generations()).to.have.length(0);
												return fDone();
											});
									}, 'the Lead\'s generation event');
							});
					});

				test('another tenant\'s bump reaches only that tenant; a move (both tenant keys) reaches both; \'#any\' alone reaches nobody',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any' ]));
								_SSE.onBump(bumpRecord(_Intake, 'Task', [ '#any', '2' ]));
								waitFor(() => { return pStreams[1].generations('Task').length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										quiet(QUIET_MS,
											() =>
											{
												Expect(pStreams[0].generations()).to.have.length(0);
												Expect(pStreams[1].generations()).to.have.length(1);
												_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1', '2' ]));
												waitFor(() => { return (pStreams[0].generations('Project').length > 0) && (pStreams[1].generations('Project').length > 0); }, 2000,
													(pMoveError) =>
													{
														Expect(pMoveError).to.not.exist;
														quiet(QUIET_MS,
															() =>
															{
																Expect(pStreams[0].generations()).to.have.length(1);
																Expect(pStreams[1].generations()).to.have.length(2);
																return fDone();
															});
													}, 'both tenants\' move events');
											});
									}, 'the other tenant\'s event');
							});
					});

				test('the Generation is opaque per principal (same bump, different principals, different values) and moves with each forwarded bump',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _Member ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpFirst = bumpRecord(_Intake, 'Client', [ '#any', '1' ]);
								_SSE.onBump(tmpFirst);
								waitFor(() => { return (pStreams[0].generations().length > 0) && (pStreams[1].generations().length > 0); }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										let tmpLeadFirst = pStreams[0].generations()[0].Data;
										let tmpMemberFirst = pStreams[1].generations()[0].Data;
										Expect(tmpLeadFirst.Seq).to.equal(tmpMemberFirst.Seq);
										Expect(tmpLeadFirst.Generation).to.not.equal(tmpMemberFirst.Generation);
										principalKeyOf(_Harness, _Lead,
											(pKeyError, pLeadKey) =>
											{
												Expect(pKeyError).to.not.exist;
												let tmpExpected = `g:${libCrypto.createHash('sha256').update(`${_Harness.fable.RetoldFacetingGenerations.BootEpoch}|${pLeadKey}|Client|${tmpFirst.Tick}`).digest('hex').slice(0, 12)}`;
												Expect(tmpLeadFirst.Generation).to.equal(tmpExpected);
												_SSE.onBump(bumpRecord(_Intake, 'Client', [ '#any', '1' ]));
												waitFor(() => { return pStreams[0].generations().length > 1; }, 2000,
													(pSecondError) =>
													{
														Expect(pSecondError).to.not.exist;
														Expect(pStreams[0].generations()[1].Data.Generation).to.not.equal(tmpLeadFirst.Generation);
														return fDone();
													}, 'the second event');
											});
									}, 'both principals\' events');
							});
					});

				test('unknown and non-facetable entities are never forwarded, not even on the global tick',
					(fDone) =>
					{
						let tmpContext = { Host: _Harness.faceting.Host, Principal: null, Options: _Harness.faceting.options };
						principalKeyOf(_Harness, _Lead, () =>
						{
							openStream(_Harness, _Lead,
								(pError, pStream) =>
								{
									Expect(pError).to.not.exist;
									// Issue is NeverFacet in this harness: the authorizer refuses it.
									Expect(_Harness.fable.RetoldFacetingAuthorizer.canFacet(Object.assign({}, tmpContext, { Principal: serverConnection(_SSE, _SSE.connections()[0].PrincipalKey).Principal }), 'Issue')).to.equal(false);
									_SSE.onBump(bumpRecord(_Intake, 'Issue', [ '#any', '1' ]));
									_SSE.onBump(bumpRecord(_Intake, 'Issue', [ '#any', '*' ]));
									_SSE.onBump(bumpRecord(_Intake, 'Ghost', [ '#any', '1' ]));
									_SSE.onBump(bumpRecord(_Intake, 'Account', [ '#any', '1', '*' ]));
									quiet(SSE_TEST_OPTIONS.GlobalTickMS + QUIET_MS + 100,
										() =>
										{
											Expect(pStream.generations()).to.have.length(0);
											return fDone();
										});
								});
						});
					});

				test('\'*\' bumps (a global lookup, an unknown tenant) arrive only through the global tick, to every tenant, coalesced per entity',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpStart = Date.now();
								let tmpLastFormType = null;
								for (let i = 0; i < 5; i++)
								{
									tmpLastFormType = bumpRecord(_Intake, 'FormType', [ '#any', '*' ]);
									_SSE.onBump(tmpLastFormType);
								}
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '*' ]));
								quiet(SSE_TEST_OPTIONS.CoalesceMS * 3,
									() =>
									{
										// Not forwarded individually.
										Expect(pStreams[0].generations()).to.have.length(0);
										Expect(pStreams[1].generations()).to.have.length(0);
										waitFor(() => { return pStreams.every((pStream) => { return pStream.generations().length >= 2; }); }, SSE_TEST_OPTIONS.GlobalTickMS * 4,
											(pWaitError) =>
											{
												Expect(pWaitError).to.not.exist;
												Expect(Date.now() - tmpStart).to.be.at.least(SSE_TEST_OPTIONS.GlobalTickMS - 20);
												quiet(QUIET_MS,
													() =>
													{
														pStreams.forEach(
															(pStream) =>
															{
																Expect(pStream.generations('FormType')).to.have.length(1);
																Expect(pStream.generations('FormType')[0].Data.Seq).to.equal(tmpLastFormType.Seq);
																Expect(pStream.generations('Project')).to.have.length(1);
															});
														return fDone();
													});
											}, 'the global tick');
									});
							});
					});

				test('many bumps within CoalesceMS coalesce into one event carrying the latest Seq and the largest tick',
					(fDone) =>
					{
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								let tmpCoalesced = _SSE.stats().Coalesced;
								let tmpLast = null;
								for (let i = 0; i < 25; i++)
								{
									tmpLast = bumpRecord(_Intake, 'Task', [ '#any', '1' ]);
									_SSE.onBump(tmpLast);
								}
								waitFor(() => { return pStream.generations().length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										quiet(QUIET_MS,
											() =>
											{
												Expect(pStream.generations()).to.have.length(1);
												Expect(pStream.generations()[0].Data.Seq).to.equal(tmpLast.Seq);
												Expect(_SSE.stats().Coalesced - tmpCoalesced).to.equal(24);
												let tmpKey = _SSE.connections()[0].PrincipalKey;
												let tmpExpected = `g:${libCrypto.createHash('sha256').update(`${_Harness.fable.RetoldFacetingGenerations.BootEpoch}|${tmpKey}|Task|${tmpLast.Tick}`).digest('hex').slice(0, 12)}`;
												Expect(pStream.generations()[0].Data.Generation).to.equal(tmpExpected);
												// A later bump opens a new window.
												_SSE.onBump(bumpRecord(_Intake, 'Task', [ '#any', '1' ]));
												waitFor(() => { return pStream.generations().length === 2; }, 2000,
													(pSecondError) =>
													{
														Expect(pSecondError).to.not.exist;
														return fDone();
													}, 'the second window');
											});
									}, 'the coalesced event');
							});
					});

				test('a heartbeat comment arrives every HeartbeatMS',
					(fDone) =>
					{
						let tmpHeartbeats = _SSE.stats().Heartbeats;
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								waitFor(() => { return pStream.Frames.filter((pFrame) => { return pFrame.Comment === 'hb'; }).length >= 2; }, SSE_TEST_OPTIONS.HeartbeatMS * 6,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										let tmpBeat = pStream.Frames.find((pFrame) => { return pFrame.Comment === 'hb'; });
										Expect(tmpBeat.Fields).to.deep.equal([]);
										Expect(tmpBeat.Raw).to.equal(': hb');
										Expect(_SSE.stats().Heartbeats - tmpHeartbeats).to.be.at.least(2);
										// Heartbeats are not events.
										Expect(_SSE.connections()[0].Sent).to.equal(1);
										return fDone();
									}, 'two heartbeats');
							});
					});

				test('429 per principal: the third stream of one principal is refused and the open ones stay',
					(fDone) =>
					{
						let tmpRefused = _SSE.stats().Refused['SSE.MaxPerPrincipal'] || 0;
						openStreams(_Harness, [ _Lead, _Lead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStreams.map((pStream) => { return pStream.Status; })).to.deep.equal([ 200, 200 ]);
								openStream(_Harness, _Lead,
									(pThirdError, pThird) =>
									{
										Expect(pThirdError).to.not.exist;
										Expect(pThird.Status).to.equal(429);
										Expect(pThird.Body.Error).to.deep.equal({ Code: 'FACET_RATE_LIMITED', Status: 429, Message: 'Too many open change streams.', Detail: { Limit: 'SSE.MaxPerPrincipal' } });
										Expect(pThird.Headers['x-retold-facet-contract']).to.equal('1');
										Expect(_SSE.stats().Refused['SSE.MaxPerPrincipal']).to.equal(tmpRefused + 1);
										Expect(_SSE.stats()).to.include({ Connections: 2, Principals: 1 });
										// The open streams still work.
										_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
										waitFor(() => { return pStreams.every((pStream) => { return pStream.generations().length === 1; }); }, 2000,
											(pWaitError) =>
											{
												Expect(pWaitError).to.not.exist;
												Expect(pStreams.every((pStream) => { return !pStream.Ended; })).to.equal(true);
												return fDone();
											}, 'both open streams');
									});
							});
					});

				test('429 per tenant, then 429 in total',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _Lead, _Member ],
							(pError) =>
							{
								Expect(pError).to.not.exist;
								openStream(_Harness, _Outsider,
									(pTenantError, pTenantRefused) =>
									{
										Expect(pTenantError).to.not.exist;
										Expect(pTenantRefused.Status).to.equal(429);
										Expect(pTenantRefused.Body.Error.Detail).to.deep.equal({ Limit: 'SSE.MaxPerTenant' });
										openStream(_Harness, _OtherLead,
											(pOtherError, pOther) =>
											{
												Expect(pOtherError).to.not.exist;
												Expect(pOther.Status).to.equal(200);
												Expect(_SSE.stats()).to.include({ Connections: 4, Principals: 3 });
												openStream(_Harness, { Tenant: _OtherLead.Tenant, User: _OtherLead.User + 1 },
													(pTotalError, pTotalRefused) =>
													{
														Expect(pTotalError).to.not.exist;
														Expect(pTotalRefused.Status).to.equal(429);
														Expect(pTotalRefused.Body.Error.Detail).to.deep.equal({ Limit: 'SSE.MaxConnections' });
														Expect(_SSE.stats().Connections).to.equal(4);
														return fDone();
													});
											});
									});
							});
					});

				test('the per-tenant cap is a fair share of SSE.MaxConnections among the active tenants: a second tenant halves the first one\'s room',
					(fDone) =>
					{
						Expect(_SSE.tenantCap('1'), 'one tenant: min(MaxPerTenant 3, 4 / 1)').to.equal(3);
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError) =>
							{
								Expect(pError).to.not.exist;
								Expect(_SSE.tenantCap('1'), 'two tenants: min(3, 4 / 2)').to.equal(2);
								Expect(_SSE.tenantCap('9'), 'a third, new tenant: min(3, 4 / 3)').to.equal(1);
								openStream(_Harness, _Member,
									(pMemberError, pMember) =>
									{
										Expect(pMemberError).to.not.exist;
										Expect(pMember.Status).to.equal(200);
										openStream(_Harness, _Lead,
											(pRefusedError, pRefused) =>
											{
												Expect(pRefusedError).to.not.exist;
												Expect(pRefused.Status).to.equal(429);
												Expect(pRefused.Body.Error.Detail).to.deep.equal({ Limit: 'SSE.MaxPerTenant' });
												return fDone();
											});
									});
							});
					});

				test('revalidation never trusts the session snapshot the stream opened with: each stream ends at its (jittered) RevalidateMS with closed { Reason: Revalidate }, and the reconnect goes through the full authentication (a logged-out session is 401)',
					(fDone) =>
					{
						fSetOption('RevalidateMS', 120);
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								// Nothing about the sessions changed on the request objects: the streams still end.
								waitFor(() => { return pStreams.every((pStream) => { return pStream.Ended; }); }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										pStreams.forEach(
											(pStream) =>
											{
												let tmpLast = pStream.Frames[pStream.Frames.length - 1];
												Expect(tmpLast.Event).to.equal('closed');
												Expect(tmpLast.Data).to.deep.equal({ Reason: 'Revalidate' });
											});
										Expect(_SSE.stats().Revalidated).to.be.at.least(2);
										waitFor(() => { return _SSE.stats().Connections === 0; }, 2000,
											(pDropError) =>
											{
												Expect(pDropError).to.not.exist;
												// The reconnect is authenticated afresh by the session layer: the Lead still streams, a
												// session that logged out (no principal headers any more) is refused.
												openStream(_Harness, _Lead,
													(pAgainError, pAgain) =>
													{
														Expect(pAgainError).to.not.exist;
														Expect(pAgain.Status).to.equal(200);
														openStream(_Harness, {},
															(pAnonError, pAnonymous) =>
															{
																Expect(pAnonError).to.not.exist;
																Expect(pAnonymous.Status).to.equal(401);
																return fDone();
															});
													});
											}, 'the server to drop the revalidated streams');
									}, 'the revalidation closes');
							});
					});

				test('a host that can re-read sessions (Host.revalidatePrincipal) keeps an unchanged principal open and closes a changed one',
					(fDone) =>
					{
						fSetOption('RevalidateMS', 60);
						let tmpHost = _Harness.faceting.Host;
						let tmpChanged = new Set();
						tmpHost.revalidatePrincipal = (pRequest, fCallback) =>
						{
							let tmpUser = parseInt(pRequest.headers['x-facet-test-user'], 10);
							if (tmpChanged.has(tmpUser))
							{
								return fCallback(null, { Kind: 'Anonymous', ScopeValues: {} });
							}
							return tmpHost.resolvePrincipal({ params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, SessionID: 'x', UserID: tmpUser, IDUser: tmpUser, CustomerID: parseInt(pRequest.headers['x-facet-test-tenant'], 10) } }, fCallback);
						};
						_Restore.push(() => { delete tmpHost.revalidatePrincipal; });
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								quiet(200,
									() =>
									{
										Expect(pStreams.every((pStream) => { return !pStream.Ended; })).to.equal(true);
										Expect(_SSE.stats().Revalidated).to.be.at.least(2);
										tmpChanged.add(_OtherLead.User);
										waitFor(() => { return pStreams[1].Ended; }, 2000,
											(pWaitError) =>
											{
												Expect(pWaitError).to.not.exist;
												Expect(pStreams[1].Frames[pStreams[1].Frames.length - 1].Data).to.deep.equal({ Reason: 'Revalidate' });
												Expect(pStreams[0].Ended).to.equal(false);
												return fDone();
											}, 'the changed principal\'s stream to close');
									});
							});
					});

				test('a consumer that stops reading is closed after 2 × HeartbeatMS blocked (its slot is freed)',
					(fDone) =>
					{
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								let tmpConnection = Array.from(_SSE._Connections)[0];
								// Simulate a full socket buffer: every write now reports backpressure, no drain comes.
								tmpConnection.Response.write = () => { return false; };
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								waitFor(() => { return _SSE.stats().Connections === 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										Expect(_SSE.stats().Stalled).to.be.at.least(1);
										return fDone();
									}, 'the stalled stream to close');
							});
					});

				test('the default (IncludeSeq \'Auto\') on a policy host: no Seq in ready or generation (the node-wide counter reveals other tenants\' write volume)',
					(fDone) =>
					{
						fSetOption('IncludeSeq', 'Auto');
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(Object.keys(pStream.events('ready')[0].Data)).to.deep.equal([ 'NodeEpoch', 'CoalesceMS', 'HeartbeatMS', 'Reset' ]);
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								waitFor(() => { return pStream.generations().length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										Expect(Object.keys(pStream.generations()[0].Data)).to.deep.equal([ 'Entity', 'Generation' ]);
										return fDone();
									}, 'the generation event');
							});
					});

				test('a cross-origin page is refused (403) before any principal resolves; same-origin and SSE.AllowedOrigins pass',
					(fDone) =>
					{
						let fOpen = (pOrigin, fNext) =>
						{
							let tmpHeaders = { accept: 'text/event-stream', 'x-facet-test-tenant': String(_Lead.Tenant), 'x-facet-test-user': String(_Lead.User) };
							if (pOrigin)
							{
								tmpHeaders.origin = pOrigin;
							}
							let tmpRequest = libHttp.get({ hostname: '127.0.0.1', port: _Harness.port, path: '/1.0/Facet/Changes', headers: tmpHeaders, agent: false },
								(pResponse) =>
								{
									let tmpStatus = pResponse.statusCode;
									let tmpBody = '';
									pResponse.setEncoding('utf8');
									pResponse.on('data', (pChunk) => { tmpBody += pChunk; if (tmpStatus === 200) { tmpRequest.destroy(); } });
									pResponse.on('end', () => { fNext(tmpStatus, tmpBody); });
									pResponse.on('close', () => { fNext(tmpStatus, tmpBody); });
								});
							tmpRequest.on('error', () => {});
						};
						let tmpOnce = (fNext) => { let tmpCalled = false; return (pStatus, pBody) => { if (!tmpCalled) { tmpCalled = true; fNext(pStatus, pBody); } }; };
						fOpen('https://evil.example', tmpOnce(
							(pStatus, pBody) =>
							{
								Expect(pStatus).to.equal(403);
								Expect(JSON.parse(pBody).Error.Code).to.equal('FACET_FORBIDDEN');
								Expect(_SSE.stats().Refused.Origin).to.be.at.least(1);
								fOpen(`http://127.0.0.1:${_Harness.port}`, tmpOnce(
									(pSameStatus) =>
									{
										Expect(pSameStatus).to.equal(200);
										fSetOption('AllowedOrigins', [ 'https://app.example' ]);
										fOpen('https://app.example', tmpOnce(
											(pAllowedStatus) =>
											{
												Expect(pAllowedStatus).to.equal(200);
												return fDone();
											}));
									}));
							}));
					});

				test('a model reload is broadcast as a model event with the new ModelVersion',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								_SSE.broadcastModelChanged();
								waitFor(() => { return pStreams.every((pStream) => { return pStream.events('model').length === 1; }); }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										pStreams.forEach(
											(pStream) =>
											{
												Expect(pStream.events('model')[0].Data).to.deep.equal({ ModelVersion: _Harness.fable.RetoldFacetingCatalog.modelVersion() });
												Expect(pStream.events('model')[0].Fields).to.deep.equal([ 'event', 'data' ]);
											});
										return fDone();
									}, 'the model events');
							});
					});

				test('SSE.IncludeSeq false: no Seq in ready or generation, no id line',
					(fDone) =>
					{
						fSetOption('IncludeSeq', false);
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(Object.keys(pStream.events('ready')[0].Data)).to.deep.equal([ 'NodeEpoch', 'CoalesceMS', 'HeartbeatMS', 'Reset' ]);
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								waitFor(() => { return pStream.generations().length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										let tmpEvent = pStream.generations()[0];
										Expect(tmpEvent.Fields).to.deep.equal([ 'event', 'data' ]);
										Expect(Object.keys(tmpEvent.Data)).to.deep.equal([ 'Entity', 'Generation' ]);
										return fDone();
									}, 'the generation event');
							});
					});

				test('real bumps: Generations.applyChange through the \'SSE\' listener reaches only the writer\'s tenant',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								_SeqN++;
								let tmpSeq = libRetoldFacetingUtil.formatSeq(_Intake.NodeEpoch, _SeqN);
								let tmpBump = _Harness.fable.RetoldFacetingGenerations.applyChange({ Entity: 'Project', Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate' ], Seq: tmpSeq, Source: 'Interim' });
								Expect(tmpBump).to.be.an('object');
								Expect(tmpBump.TenantKeys).to.include('1');
								// A global lookup write goes through the tick to both tenants.
								_Harness.fable.RetoldFacetingGenerations.applyChange({ Entity: 'FormType', Operation: 'Update', Tenants: [], ChangedColumns: [ 'Name' ], Seq: tmpSeq, Source: 'Interim' });
								waitFor(() => { return pStreams[0].generations('Project').length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										Expect(pStreams[0].generations('Project')[0].Data.Seq).to.equal(tmpSeq);
										waitFor(() => { return pStreams.every((pStream) => { return pStream.generations('FormType').length === 1; }); }, SSE_TEST_OPTIONS.GlobalTickMS * 4,
											(pTickError) =>
											{
												Expect(pTickError).to.not.exist;
												Expect(pStreams[1].generations('Project')).to.have.length(0);
												return fDone();
											}, 'the FormType tick');
									}, 'the Project event');
							});
					});

				test('a throwing authorizer or key lookup never breaks onBump (nothing is forwarded)',
					(fDone) =>
					{
						openStream(_Harness, _Lead,
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								let tmpAuthorizer = _Harness.fable.RetoldFacetingAuthorizer;
								let tmpCanFacet = tmpAuthorizer.canFacet;
								tmpAuthorizer.canFacet = () => { throw new Error('boom'); };
								_Restore.push(() => { tmpAuthorizer.canFacet = tmpCanFacet; });
								Expect(() => { _SSE.onBump(bumpRecord(_Intake, 'Document', [ '#any', '1' ])); }).to.not.throw();
								quiet(QUIET_MS,
									() =>
									{
										Expect(pStream.generations()).to.have.length(0);
										Expect(pStream.Ended).to.equal(false);
										return fDone();
									});
							});
					});

				test('backpressure: a write that returns false holds events (coalesced per entity) and heartbeats until drain; the chain ends once, at close',
					(fDone) =>
					{
						let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, SessionID: 'bp', UserID: 1, IDUser: 1, IDTenant: 1, CustomerID: 1 } };
						let tmpResponse = fakeResponse();
						let tmpNext = [];
						// A failed assertion must not leave the in-process stream open for teardown.
						_Restore.push(() => { tmpResponse.emit('close'); });
						let tmpReturned = _SSE.handleChanges(tmpRequest, tmpResponse, (pValue) => { tmpNext.push(pValue); });
						Expect(tmpReturned).to.equal(undefined);
						waitFor(() => { return tmpResponse.Status === 200; }, 2000,
							(pOpenError) =>
							{
								Expect(pOpenError).to.not.exist;
								Expect(tmpResponse.StatusHeaders['Content-Type']).to.equal('text/event-stream; charset=utf-8');
								Expect(tmpNext).to.deep.equal([]);
								Expect(tmpResponse.frames().map((pFrame) => { return pFrame.Event; })).to.deep.equal([ null, 'ready' ]);
								// The next write reports a full buffer.
								tmpResponse.WriteResult = false;
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								waitFor(() => { return tmpResponse.frames().filter((pFrame) => { return pFrame.Event === 'generation'; }).length === 1; }, 2000,
									(pFirstError) =>
									{
										Expect(pFirstError).to.not.exist;
										let tmpChunks = tmpResponse.Chunks.length;
										let tmpLastProject = null;
										for (let i = 0; i < 4; i++)
										{
											tmpLastProject = bumpRecord(_Intake, 'Project', [ '#any', '1' ]);
											_SSE.onBump(tmpLastProject);
										}
										_SSE.onBump(bumpRecord(_Intake, 'Task', [ '#any', '1' ]));
										// Longer than a heartbeat period and several coalescing windows.
										quiet(SSE_TEST_OPTIONS.HeartbeatMS + 60,
											() =>
											{
												// Held: no events, no heartbeats while blocked.
												Expect(tmpResponse.Chunks.length).to.equal(tmpChunks);
												tmpResponse.WriteResult = true;
												tmpResponse.emit('drain');
												let tmpGenerations = tmpResponse.frames().filter((pFrame) => { return pFrame.Event === 'generation'; });
												Expect(tmpGenerations.map((pFrame) => { return pFrame.Data.Entity; })).to.deep.equal([ 'Project', 'Project', 'Task' ]);
												Expect(tmpGenerations[1].Data.Seq).to.equal(tmpLastProject.Seq);
												waitFor(() => { return tmpResponse.frames().some((pFrame) => { return pFrame.Comment === 'hb'; }); }, 2000,
													(pBeatError) =>
													{
														Expect(pBeatError).to.not.exist;
														// The client goes away: the chain ends exactly once.
														tmpResponse.emit('close');
														tmpResponse.emit('close');
														Expect(tmpNext).to.deep.equal([ false ]);
														Expect(_SSE.stats().Connections).to.equal(0);
														Expect(_SSE.timerCount()).to.equal(0);
														return fDone();
													}, 'a heartbeat after drain');
											});
									}, 'the first event');
							});
					});

				test('a client that left while its principal resolved gets no stream: nothing is indexed and the chain ends once',
					(fDone) =>
					{
						let tmpOpened = _SSE.stats().Opened;
						let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, SessionID: 'gone', UserID: 1, IDUser: 1, IDTenant: 1, CustomerID: 1 } };
						let tmpResponse = fakeResponse();
						tmpResponse.socket.destroyed = true;
						let tmpNext = [];
						_SSE.handleChanges(tmpRequest, tmpResponse, (pValue) => { tmpNext.push(pValue); });
						waitFor(() => { return tmpNext.length > 0; }, 2000,
							(pWaitError) =>
							{
								Expect(pWaitError).to.not.exist;
								Expect(tmpNext).to.deep.equal([ false ]);
								Expect(tmpResponse.Status).to.equal(null);
								Expect(tmpResponse.Chunks).to.deep.equal([]);
								Expect(_SSE.stats()).to.include({ Connections: 0, Opened: tmpOpened });
								return fDone();
							}, 'the chain to end');
					});

				test('closeAll sends closed { Reason } to every stream, ends them and leaves no timer',
					(fDone) =>
					{
						openStreams(_Harness, [ _Lead, _OtherLead ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpClosed = _SSE.stats().Closed;
								// The shared flush, the global tick and the shared housekeeping timer are pending (no
								// per-connection timers any more).
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								_SSE.onBump(bumpRecord(_Intake, 'FormType', [ '#any', '*' ]));
								Expect(_SSE.timerCount()).to.equal(3);
								_SSE.closeAll('Shutdown');
								Expect(_SSE.stats()).to.include({ Connections: 0, Principals: 0, Closed: tmpClosed + 2 });
								waitFor(() => { return pStreams.every((pStream) => { return pStream.Ended; }); }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										pStreams.forEach(
											(pStream) =>
											{
												let tmpLast = pStream.Frames[pStream.Frames.length - 1];
												Expect(tmpLast.Event).to.equal('closed');
												Expect(tmpLast.Data).to.deep.equal({ Reason: 'Shutdown' });
												Expect(pStream.generations()).to.have.length(0);
											});
										waitFor(() => { return _SSE.timerCount() === 0; }, 2000,
											(pTimerError) =>
											{
												Expect(pTimerError).to.not.exist;
												return fDone();
											}, 'every timer to be cleared');
									}, 'both streams to end');
							});
					});
			}
		);

		suite
		(
			'LabTrack (personal scopes)',
			() =>
			{
				let _Harness = null;
				let _SSE = null;
				let _Intake = null;

				suiteSetup(
					(fDone) =>
					{
						_Harness = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Faceting: { SSE: SSE_TEST_OPTIONS } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_SSE = _Harness.fable.RetoldFacetingSSE;
								_Intake = _Harness.fable.RetoldFacetingChangeIntake;
								_SSE.connect(_Harness.faceting.Host.getServiceServer());
								_Harness.fable.RetoldFacetingGenerations.subscribe('SSE', (pBump) => { _SSE.onBump(pBump); });
								return fDone();
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						closeStreams(_SSE, () => { _Harness.stop(fDone); });
					});

				teardown(
					(fDone) =>
					{
						closeStreams(_SSE, fDone);
					});

				test('a LabForm bump on its owner\'s key reaches only the owner; an unknown owner reaches every owner of the tenant',
					(fDone) =>
					{
						let tmpTech = _Harness.as('Tech');
						let tmpColleague = _Harness.as('Colleague');
						let tmpOtherTech = _Harness.as('OtherTech');
						let tmpGenerations = _Harness.fable.RetoldFacetingGenerations;
						openStreams(_Harness, [ tmpTech, tmpColleague, tmpOtherTech ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpTenant = tmpGenerations.tenantKey(tmpTech.Tenant);
								let tmpOwnerKey = tmpGenerations.tenantKey(tmpTech.Tenant, tmpTech.User);
								Expect(tmpOwnerKey).to.equal(`${tmpTenant}/${tmpTech.User}`);
								// Tech's own private write (tenant-wide key + owner key): never pushed to a colleague.
								_SSE.onBump(bumpRecord(_Intake, 'LabForm', [ '#any', tmpTenant, tmpOwnerKey ]));
								waitFor(() => { return pStreams[0].generations('LabForm').length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										quiet(QUIET_MS,
											() =>
											{
												Expect(pStreams[0].generations('LabForm')).to.have.length(1);
												Expect(pStreams[1].generations()).to.have.length(0);
												Expect(pStreams[2].generations()).to.have.length(0);
												// A write whose owner is unknown: every owner of the tenant.
												_SSE.onBump(bumpRecord(_Intake, 'LabForm', [ '#any', tmpTenant, `${tmpTenant}/*` ]));
												// A tenant entity: the whole tenant.
												_SSE.onBump(bumpRecord(_Intake, 'LabQueue', [ '#any', tmpTenant ]));
												waitFor(() => { return (pStreams[1].generations('LabForm').length > 0) && (pStreams[1].generations('LabQueue').length > 0) && (pStreams[0].generations('LabQueue').length > 0); }, 2000,
													(pUnknownError) =>
													{
														Expect(pUnknownError).to.not.exist;
														quiet(QUIET_MS,
															() =>
															{
																Expect(pStreams[0].generations('LabForm')).to.have.length(2);
																Expect(pStreams[1].generations('LabForm')).to.have.length(1);
																Expect(pStreams[2].generations()).to.have.length(0);
																return fDone();
															});
													}, 'the tenant-wide events');
											});
									}, 'the owner\'s event');
							});
					});

				test('through Generations: a LabForm change with Owners reaches its owner only',
					(fDone) =>
					{
						let tmpTech = _Harness.as('Tech');
						let tmpColleague = _Harness.as('Colleague');
						openStreams(_Harness, [ tmpTech, tmpColleague ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								_SeqN++;
								let tmpBump = _Harness.fable.RetoldFacetingGenerations.applyChange(
									{
										Entity: 'LabForm', Operation: 'Update', Tenants: [ tmpTech.Tenant ],
										Owners: [ { Tenant: tmpTech.Tenant, Owner: tmpTech.User } ],
										ChangedColumns: [ 'Status' ], Seq: libRetoldFacetingUtil.formatSeq(_Intake.NodeEpoch, _SeqN), Source: 'Interim'
									});
								Expect(tmpBump).to.be.an('object');
								waitFor(() => { return pStreams[0].generations('LabForm').length > 0; }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										quiet(QUIET_MS,
											() =>
											{
												Expect(pStreams[1].generations()).to.have.length(0);
												return fDone();
											});
									}, 'the owner\'s event');
							});
					});
			}
		);

		suite
		(
			'Bookstore (no policy)',
			() =>
			{
				let _Harness = null;
				let _SSE = null;
				let _Intake = null;

				suiteSetup(
					(fDone) =>
					{
						// GlobalTickMS stays long: without a policy nothing waits for it.
						// Without a policy the stream is off by default ('Auto'); Enabled true is the operator's
						// statement that this host is single-tenant.
						_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Faceting: { SSE: Object.assign({}, SSE_TEST_OPTIONS, { GlobalTickMS: 60000, Enabled: true }) } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_SSE = _Harness.fable.RetoldFacetingSSE;
								_Intake = _Harness.fable.RetoldFacetingChangeIntake;
								_SSE.connect(_Harness.faceting.Host.getServiceServer());
								return fDone();
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						closeStreams(_SSE, () => { _Harness.stop(fDone); });
					});

				teardown(
					(fDone) =>
					{
						closeStreams(_SSE, fDone);
					});

				test('an anonymous principal is 401 even without a policy (only User principals stream)',
					(fDone) =>
					{
						openStream(_Harness, {},
							(pError, pStream) =>
							{
								Expect(pError).to.not.exist;
								Expect(pStream.Status).to.equal(401);
								Expect(pStream.Body.Error.Code).to.equal('FACET_UNAUTHENTICATED');
								return fDone();
							});
					});

				test('without a policy every \'*\' bump is forwarded immediately',
					(fDone) =>
					{
						openStreams(_Harness, [ { User: 5 }, { User: 6 } ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								let tmpStart = Date.now();
								_SSE.onBump(bumpRecord(_Intake, 'Review', [ '#any', '*' ]));
								waitFor(() => { return pStreams.every((pStream) => { return pStream.generations('Review').length === 1; }); }, 2000,
									(pWaitError) =>
									{
										Expect(pWaitError).to.not.exist;
										Expect(Date.now() - tmpStart).to.be.below(1000);
										// Only the shared housekeeping timer (no global tick without a policy, no per-stream timers).
										Expect(_SSE.timerCount()).to.equal(1);
										// One bucket is not a tenant: no per-tenant cap without a policy.
										Expect(_SSE.tenantCap('*')).to.equal(Infinity);
										return fDone();
									}, 'the immediate events');
							});
					});
			}
		);

		suite
		(
			'shutdown',
			() =>
			{
				let _Harness = null;
				let _SSE = null;
				let _Intake = null;

				suiteSetup(
					(fDone) =>
					{
						_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { SSE: SSE_TEST_OPTIONS } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_SSE = _Harness.fable.RetoldFacetingSSE;
								_Intake = _Harness.fable.RetoldFacetingChangeIntake;
								_SSE.connect(_Harness.faceting.Host.getServiceServer());
								return fDone();
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						closeStreams(null, () => { _Harness.stop(fDone); });
					});

				test('harness.stop completes with streams open: every stream gets closed { Reason: Shutdown } and no timer survives',
					(fDone) =>
					{
						openStreams(_Harness, [ _Harness.as('Lead'), _Harness.as('OtherLead') ],
							(pError, pStreams) =>
							{
								Expect(pError).to.not.exist;
								_SSE.onBump(bumpRecord(_Intake, 'Project', [ '#any', '1' ]));
								_SSE.onBump(bumpRecord(_Intake, 'FormType', [ '#any', '*' ]));
								// The service's shutdown hook (internal-contracts §44.10) wraps the server's close at attach.
								Expect(_Harness.faceting.shutdown).to.be.a('function');
								Expect(_Harness.fable.Orator.serviceServer[Symbol.for('RetoldFaceting.Shutdown')]).to.equal(true);
								let tmpStart = Date.now();
								_Harness.stop(
									() =>
									{
										Expect(Date.now() - tmpStart).to.be.below(3000);
										waitFor(() => { return pStreams.every((pStream) => { return pStream.Ended; }); }, 2000,
											(pWaitError) =>
											{
												Expect(pWaitError).to.not.exist;
												pStreams.forEach(
													(pStream) =>
													{
														let tmpLast = pStream.Frames[pStream.Frames.length - 1];
														Expect(tmpLast.Event).to.equal('closed');
														Expect(tmpLast.Data).to.deep.equal({ Reason: 'Shutdown' });
													});
												Expect(_SSE.stats().Connections).to.equal(0);
												waitFor(() => { return _SSE.timerCount() === 0; }, 2000,
													(pTimerError) =>
													{
														Expect(pTimerError).to.not.exist;
														return fDone();
													}, 'every timer to be cleared');
											}, 'both streams to end');
									});
							});
					});
			}
		);
	}
);
