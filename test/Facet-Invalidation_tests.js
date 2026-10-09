/**
 * Facet-Invalidation: the end-to-end O7 obligations of Milestone 4 over HTTP — change capture at the
 * stock CRUD routes and notify(), generations, the result cache, freshness, the generation Version and
 * the 304 short-circuit, read-your-writes, SSE and shutdown — with Cache.Enabled (and the default,
 * Cache off, as M2 behavior).
 *
 *   ProjectTrack (SQLite; PostgreSQL gated): attach installs the intake on every facetable entity's
 *     route-bound controller; Miss → Hit with one generation ETag; If-None-Match → 304 decided before
 *     execution (no SQL: Statements 0 and a provider spy), only after authorization (401 / 404 / 403
 *     win, another tenant never gets one); every write kind (single, bulk, update by PUT / PUT-by-id /
 *     PATCH, bulk update, upsert both paths, Upserts, delete, undelete, a tenant move, a global lookup)
 *     and notify() / notifyByFilter() bump exactly the §41 keys (a Generations listener) and invalidate
 *     exactly the dependent answers (stats); column precision (a Title edit keeps a Status answer, a
 *     label-column edit invalidates the labelled facet, '#cols' for a Records-bearing body); a global
 *     lookup edit invalidates every tenant and reaches every tenant's stream through the global tick;
 *     tenant isolation (cache and SSE); Exact never stale; Bounded Stale within MaxLagMS with ONE
 *     background refresh, then fresh; Fast; single flight for concurrent misses; read-your-writes and
 *     MinSeq upgrades (X-Retold-Facet-Freshness); the X-Retold-Facet-* headers; Records / Count / Keys
 *     never cached; every Bypass reason; a throwing intake subscriber or bump listener never breaks a
 *     write; behaviors installed after attach run around the intake.
 *   ProjectTrack with the intake installed after host behaviors (Intake 'None' at attach, then
 *     installChangeCapture): the earlier behaviors still run first, with the controller as this.
 *   LabTrack (SQLite): owner-qualified keys — a colleague's write never invalidates my owner-scoped
 *     answer nor reaches my stream, but does invalidate a TenantOnly fold (E3); an owner move bumps
 *     both owners.
 *   Bookstore-Tenant (SQLite): a model reload clears the cache, tells open streams ('model') and keeps
 *     exactly one event per write.
 *   Cache off (the default): M2 behavior — digest Versions, no lookups, a 304 only after execution,
 *     the envelope differs from M2 only by DependsOn; the intake, generations and SSE still run.
 *   Shutdown: harness.stop completes with streams open; each gets closed { Reason: 'Shutdown' }; no
 *     timer survives.
 *
 * Owner: wiring (M4).  Obligations: internal-contracts §44, §49.1.  Registry port: 19136.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;
const libHttp = require('http');

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libRetoldFacetingService = require('../source/Retold-Faceting-Service.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');
const libChangeIntakeInterim = require('../source/change/Change-Intake-Interim.js');

const PORT = 19136;

const POSTGRES = libProviders.available('PostgreSQL');
const PROVIDERS =
	[
		{ Provider: 'SQLite', Ready: true, Reason: null },
		{ Provider: 'PostgreSQL', Ready: POSTGRES.Available, Reason: POSTGRES.Reason }
	];

// Small SSE timings (internal-contracts §49.1: keep npm test fast).
// IncludeSeq / SeqHeader / ExposeStatus are explicit: their defaults ('Auto' / false) keep the node-wide
// Seq and the cache status away from clients on a policy host (§51.10, §51.57; their own tests check
// the defaults), and these tests assert both.
const SSE_OPTIONS = Object.freeze({ CoalesceMS: 20, HeartbeatMS: 60000, GlobalTickMS: 40, RetryMS: 100, MaxPerPrincipal: 4, IncludeSeq: true });
const EXPOSED = Object.freeze({ Freshness: { SeqHeader: true } });

// Cache on, settle off (notify re-delivery has its own tests in Facet-ChangeIntake).
const CACHE_ON = Object.freeze({ Cache: { Enabled: true, ExposeStatus: true }, Freshness: EXPOSED.Freshness, SSE: SSE_OPTIONS, ChangeCapture: { NotifySettleMS: 0 } });

const ETAG_PATTERN = /^W\/"fv1:[0-9a-f]{16}"$/;

// The M2 envelope keys (internal-contracts §10.1, §28.4) in order; M4 adds only DependsOn (§44.7).
const M2_ENVELOPE_KEYS = [ 'ContractVersion', 'Entity', 'Version', 'ModelVersion', 'Engine', 'Exact', 'AsOf', 'LagMS', 'Stale', 'Cached', 'ElapsedMS', 'Total', 'TotalCountMode', 'IncludesDeleted', 'Filter', 'Facets', 'Errors', 'Warnings' ];

// The numeric ResultCache metrics a test compares before / after (internal-contracts §43.5).
const CACHE_COUNTERS = [ 'Hits', 'StaleHits', 'Misses', 'Stores', 'Rejected', 'Evictions', 'Expired', 'Refreshes', 'RefreshErrors', 'Flights', 'NotModified' ];

// Bodies (internal-contracts §31.5 style).
const Q_DOCUMENT_STATUS = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Document.Status' } ] });
const Q_PROJECT_STATUS = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] });
const Q_PROJECT_CLIENT = Object.freeze({ Facets: [ { Key: 'Client', Facet: 'Project.IDClient', Top: 50 } ] });
const Q_DOCUMENT_FORM = Object.freeze({ Facets: [ { Key: 'Form', Facet: 'Document.IDFormType', Top: 50 } ] });
const Q_ISSUE_SEVERITY = Object.freeze({ Facets: [ { Key: 'Severity', Facet: 'Issue.Severity' } ] });

/**
 * A body with a Freshness.
 *
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pFreshness
 * @return {Record<string, any>}
 */
const withFreshness = (pBody, pFreshness) =>
{
	return Object.assign({}, pBody, { Freshness: pFreshness });
};

const BOUNDED = Object.freeze({ Mode: 'Bounded', MaxLagMS: 5000 });

/**
 * Run steps in order: each is (fNext) => …; the first error (or a thrown assertion) ends the run.
 *
 * @param {Array<(fNext: (pError?: Error) => void) => void>} pSteps
 * @param {(pError?: Error) => void} fDone
 */
const series = (pSteps, fDone) =>
{
	let fRun = (pIndex) =>
	{
		if (pIndex >= pSteps.length)
		{
			return fDone();
		}
		let tmpCalledBack = false;
		let fNext = (pError) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			if (pError)
			{
				return fDone(pError);
			}
			return setImmediate(() => { fRun(pIndex + 1); });
		};
		try
		{
			pSteps[pIndex](fNext);
		}
		catch (pThrown)
		{
			if (!tmpCalledBack)
			{
				tmpCalledBack = true;
				return fDone(pThrown);
			}
			throw pThrown;
		}
	};
	fRun(0);
};

/**
 * Poll a condition (every 5 ms) until it holds or the time is up.
 *
 * @param {() => boolean} fCondition
 * @param {number} pTimeoutMS
 * @param {string} pWhat
 * @param {(pError?: Error) => void} fDone
 */
const waitFor = (fCondition, pTimeoutMS, pWhat, fDone) =>
{
	let tmpStart = Date.now();
	let fPoll = () =>
	{
		let tmpHolds = false;
		try
		{
			tmpHolds = !!fCondition();
		}
		catch (pError)
		{
			return fDone(pError);
		}
		if (tmpHolds)
		{
			return fDone();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fDone(new Error(`Timed out after ${pTimeoutMS} ms waiting for ${pWhat}.`));
		}
		return setTimeout(fPoll, 5);
	};
	fPoll();
};

/**
 * A step that waits pMS.
 *
 * @param {number} pMS
 * @return {(fNext: Function) => void}
 */
const pause = (pMS) =>
{
	return (fNext) => { setTimeout(() => { fNext(); }, pMS); };
};

/**
 * The difference of two ResultCache.stats() snapshots (numbers and the Bypass reasons that moved).
 *
 * @param {Record<string, any>} pBefore
 * @param {Record<string, any>} pAfter
 * @return {Record<string, any>}
 */
const cacheDelta = (pBefore, pAfter) =>
{
	let tmpDelta = { Bypass: {} };
	CACHE_COUNTERS.forEach((pName) => { tmpDelta[pName] = pAfter[pName] - pBefore[pName]; });
	Object.keys(pAfter.Bypass || {}).forEach(
		(pReason) =>
		{
			let tmpMoved = pAfter.Bypass[pReason] - ((pBefore.Bypass || {})[pReason] || 0);
			if (tmpMoved !== 0)
			{
				tmpDelta.Bypass[pReason] = tmpMoved;
			}
		});
	return tmpDelta;
};

/**
 * The count of one bucket of one facet (0 when the bucket is absent).
 *
 * @param {Record<string, any>} pEnvelope
 * @param {string} pFacetKey
 * @param {any} pBucketKey
 * @return {number}
 */
const bucketCount = (pEnvelope, pFacetKey, pBucketKey) =>
{
	let tmpFacet = (pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets[pFacetKey] : null;
	let tmpBucket = (tmpFacet && Array.isArray(tmpFacet.Buckets)) ? tmpFacet.Buckets.find((pBucket) => { return String(pBucket.Key) === String(pBucketKey); }) : null;
	return tmpBucket ? tmpBucket.Count : 0;
};

/**
 * The label of one bucket of one facet.
 *
 * @param {Record<string, any>} pEnvelope
 * @param {string} pFacetKey
 * @param {any} pBucketKey
 * @return {string|null}
 */
const bucketLabel = (pEnvelope, pFacetKey, pBucketKey) =>
{
	let tmpFacet = (pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets[pFacetKey] : null;
	let tmpBucket = (tmpFacet && Array.isArray(tmpFacet.Buckets)) ? tmpFacet.Buckets.find((pBucket) => { return String(pBucket.Key) === String(pBucketKey); }) : null;
	return tmpBucket ? tmpBucket.Label : null;
};

/**
 * The comparable facts of a Generations bump (internal-contracts §41.3).
 *
 * @param {Record<string, any>} pBump
 * @return {{ Entity: string, Operation: string, Source: string, TenantKeys: Array<string>, Columns: Array<string> }}
 */
const bumpFacts = (pBump) =>
{
	return { Entity: pBump.Entity, Operation: pBump.Operation, Source: pBump.Source, TenantKeys: pBump.TenantKeys.slice(), Columns: pBump.Columns.slice() };
};

/**
 * Count every SQL statement the providers of the faceted entities run (a provider spy): wraps Read and
 * Count of each distinct DAL provider (Live, Reference, labels and hydration all read through them).
 *
 * @param {Record<string, any>} pHarness
 * @return {{ Count: number, restore: () => void }}
 */
const spyStatements = (pHarness) =>
{
	let tmpSpy = { Count: 0 };
	let tmpRestores = [];
	let tmpProviders = new Set();
	pHarness.fable.RetoldFacetingCatalog.entities().forEach(
		(pEntity) =>
		{
			let tmpDAL = pHarness.faceting.Host.getExecutionDAL(pEntity);
			if (tmpDAL && tmpDAL.provider)
			{
				tmpProviders.add(tmpDAL.provider);
			}
		});
	tmpProviders.forEach(
		(pProvider) =>
		{
			[ 'Read', 'Count' ].forEach(
				(pMethod) =>
				{
					let fOriginal = pProvider[pMethod];
					if (typeof(fOriginal) !== 'function')
					{
						return;
					}
					let tmpOwn = Object.prototype.hasOwnProperty.call(pProvider, pMethod);
					pProvider[pMethod] = function (...pArguments)
					{
						tmpSpy.Count++;
						return fOriginal.apply(this, pArguments);
					};
					tmpRestores.push(() => { if (tmpOwn) { pProvider[pMethod] = fOriginal; } else { delete pProvider[pMethod]; } });
				});
		});
	tmpSpy.Providers = tmpProviders.size;
	tmpSpy.restore = () => { tmpRestores.forEach((fRestore) => { fRestore(); }); tmpRestores = []; };
	return tmpSpy;
};

// ---------------------------------------------------------------- SSE client (node http; closed by teardown)

let _OpenStreams = [];

/**
 * Parse complete frames out of a stream's buffer.
 *
 * @param {Record<string, any>} pStream
 */
const parseFrames = (pStream) =>
{
	let tmpIndex = pStream.Buffer.indexOf('\n\n');
	while (tmpIndex >= 0)
	{
		let tmpRaw = pStream.Buffer.slice(0, tmpIndex);
		pStream.Buffer = pStream.Buffer.slice(tmpIndex + 2);
		let tmpFrame = { Event: null, Data: null, ID: null, At: Date.now() };
		let tmpData = [];
		tmpRaw.split('\n').forEach(
			(pLine) =>
			{
				if (pLine.indexOf('event: ') === 0)
				{
					tmpFrame.Event = pLine.slice(7);
				}
				else if (pLine.indexOf('data: ') === 0)
				{
					tmpData.push(pLine.slice(6));
				}
				else if (pLine.indexOf('id: ') === 0)
				{
					tmpFrame.ID = pLine.slice(4);
				}
			});
		if (tmpData.length > 0)
		{
			tmpFrame.Data = JSON.parse(tmpData.join('\n'));
		}
		if (tmpFrame.Event)
		{
			pStream.Frames.push(tmpFrame);
		}
		tmpIndex = pStream.Buffer.indexOf('\n\n');
	}
};

/**
 * Open GET /1.0/Facet/Changes as a principal; calls back after 'ready' (or the refusal body).
 *
 * @param {Record<string, any>} pHarness
 * @param {{ Tenant?: number, User?: number }} pWho
 * @param {(pError?: Error, pStream?: Record<string, any>) => void} fCallback
 */
const openStream = (pHarness, pWho, fCallback) =>
{
	let tmpHeaders = { accept: 'text/event-stream' };
	if (pWho && (typeof(pWho.Tenant) === 'number'))
	{
		tmpHeaders['x-facet-test-tenant'] = String(pWho.Tenant);
	}
	if (pWho && (typeof(pWho.User) === 'number'))
	{
		tmpHeaders['x-facet-test-user'] = String(pWho.User);
	}
	let tmpStream = { Status: null, Buffer: '', Text: '', Frames: [], Ended: false, Request: null };
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
	tmpStream.Request = libHttp.get({ hostname: '127.0.0.1', port: pHarness.port, path: '/1.0/Facet/Changes', headers: tmpHeaders, agent: false },
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
			pResponse.on('end', () => { tmpStream.Ended = true; fDone(); });
			pResponse.on('error', () => { tmpStream.Ended = true; });
			pResponse.on('close', () => { tmpStream.Ended = true; });
		});
	tmpStream.Request.on('error', (pError) => { tmpStream.Ended = true; if (!tmpCalledBack) { fDone(pError); } });
	_OpenStreams.push(tmpStream);
};

/**
 * Close every client stream of the test and wait until the server dropped them.
 *
 * @param {Record<string, any>|null} pHarness
 * @param {Function} fDone
 */
const closeStreams = (pHarness, fDone) =>
{
	_OpenStreams.forEach((pStream) => { pStream.close(); });
	_OpenStreams = [];
	if (!pHarness || !pHarness.fable || !pHarness.fable.RetoldFacetingSSE)
	{
		return fDone();
	}
	waitFor(() => { return pHarness.fable.RetoldFacetingSSE.stats().Connections === 0; }, 2000, 'the server to drop every stream', fDone);
};

/**
 * The tools of one suite, bound to its (late-started) harness.
 *
 * @param {() => Record<string, any>} fHarness
 * @return {Record<string, Function>}
 */
const suiteTools = (fHarness) =>
{
	let tmpTools = {};

	/**
	 * A value given now, or computed when the step runs (a function: for values an earlier step sets).
	 *
	 * @param {any} pValue
	 * @return {any}
	 */
	let fLate = (pValue) =>
	{
		return (typeof(pValue) === 'function') ? pValue() : pValue;
	};

	/**
	 * A request step: (fNext) => HTTP, then fCheck(pResponse) (a thrown assertion ends the run).  The
	 * path, body and headers may be functions, evaluated when the step runs.
	 */
	tmpTools.call = (pMethod, pPath, pBody, pWho, pHeaders, fCheck) =>
	{
		return (fNext) =>
		{
			let tmpHarness = fHarness();
			tmpHarness.request(pMethod, fLate(pPath), fLate(pBody), Object.assign({ Headers: fLate(pHeaders) || {} }, pWho || {}),
				(pError, pResponse) =>
				{
					if (pError)
					{
						return fNext(pError);
					}
					try
					{
						if (typeof(fCheck) === 'function')
						{
							fCheck(pResponse);
						}
					}
					catch (pCheckError)
					{
						return fNext(pCheckError);
					}
					return fNext();
				});
		};
	};

	/**
	 * A Query step.
	 */
	tmpTools.query = (pEntity, pBody, pWho, pHeaders, fCheck) =>
	{
		return tmpTools.call('POST', `/1.0/Facet/${pEntity}/Query`, pBody, pWho, pHeaders, fCheck);
	};

	/**
	 * An in-process step through queryInternal with a synthetic request (+ headers), checking
	 * (pError, pEnvelope, pMeta).
	 */
	tmpTools.inProcess = (pEntity, pBody, pWho, pHeaders, pInternal, fCheck) =>
	{
		return (fNext) =>
		{
			let tmpHarness = fHarness();
			let tmpRequest = libHarness.syntheticRequest(pEntity, pWho, pBody);
			tmpRequest.headers = Object.assign({}, tmpRequest.headers || {}, pHeaders || {});
			tmpHarness.faceting.queryInternal(pEntity, pBody, tmpRequest, pInternal || {},
				(pError, pEnvelope, pMeta) =>
				{
					setImmediate(
						() =>
						{
							try
							{
								fCheck(pError, pEnvelope, pMeta);
							}
							catch (pCheckError)
							{
								return fNext(pCheckError);
							}
							return fNext();
						});
				});
		};
	};

	/**
	 * A step that reads a row of the stock list route as a principal (provider neutral):
	 * GET /1.0/<Entities>/FilteredTo/<filter>/0/<cap>.
	 */
	tmpTools.rows = (pEntity, pFilter, pCap, pWho, fUse) =>
	{
		let tmpPath = pFilter ? `/1.0/${pEntity}s/FilteredTo/${pFilter}/0/${pCap}` : `/1.0/${pEntity}s/0/${pCap}`;
		return tmpTools.call('GET', tmpPath, null, pWho, {},
			(pResponse) =>
			{
				Expect(pResponse.Status, JSON.stringify(pResponse.Body).slice(0, 300)).to.equal(200);
				Expect(pResponse.Body).to.be.an('array');
				fUse(pResponse.Body);
			});
	};

	tmpTools.cacheStats = () =>
	{
		return fHarness().fable.RetoldFacetingResultCache.stats();
	};

	tmpTools.openStream = (pWho, fUse) =>
	{
		return (fNext) =>
		{
			openStream(fHarness(), pWho,
				(pError, pStream) =>
				{
					if (pError)
					{
						return fNext(pError);
					}
					try
					{
						Expect(pStream.Status).to.equal(200);
						fUse(pStream);
					}
					catch (pCheckError)
					{
						return fNext(pCheckError);
					}
					return fNext();
				});
		};
	};

	return tmpTools;
};

/**
 * The main ProjectTrack suite (Cache.Enabled), on one provider.
 *
 * @param {{ Provider: string, Ready: boolean, Reason: string|null }} pProvider
 */
const projectTrackSuite = (pProvider) =>
{
	(pProvider.Ready ? suite : suite.skip)
	(
		`ProjectTrack, Cache.Enabled (${pProvider.Provider})${pProvider.Ready ? '' : ` (skipped: ${pProvider.Reason})`}`,
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = suiteTools(() => { return H; });
			let LEAD = null;
			let MEMBER = null;
			let OUTSIDER = null;
			let OTHER = null;
			// Every Generations bump (a listener named like no wiring subscription).
			let _Bumps = [];
			// Behavior switches (installed once, off by default).
			let _Flags = { NotCacheable: false, SlowMS: 0, AfterAttach: 0 };

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider, Faceting: CACHE_ON },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							LEAD = H.as('Lead');
							MEMBER = H.as('Member');
							OUTSIDER = H.as('Outsider');
							OTHER = H.as('OtherLead');
							H.fable.RetoldFacetingGenerations.subscribe('InvalidationTest', (pBump) => { _Bumps.push(pBump); });
							// FacetCacheable === false opts a request out (06 §7 determinism escape).
							H.installBehavior('Issue', 'Reads-QueryConfiguration',
								(pRequest, pRequestState, fCallback) =>
								{
									if (_Flags.NotCacheable)
									{
										pRequestState.FacetCacheable = false;
									}
									return fCallback();
								});
							// A slow list behavior (single-flight joiners, concurrent stale viewers), off unless SlowMS > 0.
							[ 'Client', 'Document' ].forEach(
								(pEntity) =>
								{
									H.installBehavior(pEntity, 'Reads-QueryConfiguration',
										(pRequest, pRequestState, fCallback) =>
										{
											if (_Flags.SlowMS > 0)
											{
												return setTimeout(() => { fCallback(); }, _Flags.SlowMS);
											}
											return fCallback();
										});
								});
							// A host PostOperation behavior installed AFTER attach (chain-wrapped around the intake).
							H.installBehavior('Task', 'Update-PostOperation',
								function (pRequest, pRequestState, fCallback)
								{
									_Flags.AfterAttach++;
									_Flags.AfterAttachThis = (this === H.faceting.Host.getRouteBoundController('Task'));
									return fCallback();
								});
							return fDone();
						});
				});
			suiteTeardown(
				(fDone) =>
				{
					closeStreams(null, () => { return H ? H.stop(fDone) : fDone(); });
				});
			setup(
				() =>
				{
					// Each test starts with an empty cache and no tracked writes (metrics are compared as deltas).
					H.fable.RetoldFacetingResultCache.clear();
					H.fable.RetoldFacetingReadYourWrites.clear();
				});
			teardown(
				(fDone) =>
				{
					// A Stale serve's background refresh finishes inside its own test (its store is counted there).
					waitFor(() => { return H.fable.RetoldFacetingResultCache._Refreshing.size === 0; }, 5000, 'the background refreshes to finish',
						(pError) =>
						{
							closeStreams(H, (pCloseError) => { return fDone(pError || pCloseError); });
						});
				});

			test('attach installs the intake on every facetable entity\'s route-bound controller; Describe and status() report it',
				(fDone) =>
				{
					let tmpIntake = H.fable.RetoldFacetingChangeIntake;
					let tmpEntities = H.fable.RetoldFacetingCatalog.entities();
					let tmpStats = tmpIntake.stats();
					Expect(tmpStats.Source).to.equal('Interim');
					Expect(tmpStats.Entities).to.equal(tmpEntities.length);
					Expect(tmpEntities).to.include.members([ 'Project', 'Document', 'FormType', 'Client', 'Task', 'Issue', 'ProjectMembership' ]);
					tmpEntities.forEach(
						(pEntity) =>
						{
							let tmpController = H.faceting.Host.getRouteBoundController(pEntity);
							Expect(tmpIntake.Interim.wrappedSlots(tmpController), pEntity).to.have.members([ 'Create-PostOperation', 'Update-PostOperation', 'Delete-PostOperation', 'Undelete-PostOperation' ]);
						});
					// Installing again (what a model reload does) wraps nothing twice.
					let tmpWrapper = H.faceting.Host.getRouteBoundController('Document').BehaviorInjection._BehaviorFunctions['Update-PostOperation'];
					Expect(H.faceting.installChangeCapture().Source).to.equal('Interim');
					Expect(H.faceting.Host.getRouteBoundController('Document').BehaviorInjection._BehaviorFunctions['Update-PostOperation']).to.equal(tmpWrapper);
					// The shutdown hook is on the server Orator closes.
					Expect(H.fable.Orator.serviceServer[libRetoldFacetingService.SHUTDOWN_MARKER]).to.equal(true);
					let tmpStatus = H.faceting.status();
					Expect(tmpStatus.Cache).to.include({ Enabled: true });
					Expect(tmpStatus.Generations).to.have.property('GlobalTick');
					Expect(tmpStatus.Changes).to.include({ Source: 'Interim' });
					Expect(tmpStatus.SSE).to.have.property('Connections');
					Expect(tmpStatus.ReadYourWrites).to.have.property('Principals');
					series(
						[
							T.call('GET', '/1.0/Facet/Describe', null, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Body.Cache).to.deep.equal({ Enabled: true });
									Expect(pResponse.Body.Changes).to.deep.equal({ Intake: 'Interim', Stream: '/1.0/Facet/Changes' });
									Expect(pResponse.Body.Freshness).to.deep.equal({ DefaultMode: 'Exact', MaxLagMS: 5000, ReadYourWritesMS: 10000 });
								})
						], fDone);
				});

			test('a Query: Miss, then Hit with the same generation ETag — Cached on the envelope and every facet, DependsOn, the X-Retold-Facet-* headers, and no SQL for the hit',
				(fDone) =>
				{
					let tmpBefore = null;
					let tmpFirst = null;
					let tmpSpy = null;
					series(
						[
							(fNext) => { tmpBefore = T.cacheStats(); return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									tmpFirst = pResponse;
									Expect(pResponse.Headers.etag).to.match(ETAG_PATTERN);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss');
									Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Exact');
									Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
									Expect(pResponse.Body).to.include({ Cached: false, Stale: false, LagMS: 0, Exact: true, Engine: 'Live' });
									Expect(pResponse.Body.DependsOn).to.deep.equal([ 'Document' ]);
									Expect(pResponse.Body.Version).to.equal(pResponse.Headers.etag.slice(3, -1));
								}),
							(fNext) => { tmpSpy = spyStatements(H); return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {},
								(pResponse) =>
								{
									tmpSpy.restore();
									Expect(tmpSpy.Count, 'a hit runs no SQL').to.equal(0);
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit');
									Expect(pResponse.Headers.etag).to.equal(tmpFirst.Headers.etag);
									Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
									Expect(pResponse.Body).to.include({ Cached: true, Stale: false, LagMS: 0, Exact: true, Engine: 'Live', AsOf: tmpFirst.Body.AsOf });
									Object.keys(pResponse.Body.Facets).forEach((pKey) => { Expect(pResponse.Body.Facets[pKey], pKey).to.include({ Cached: true, Stale: false, LagMS: 0, Exact: true }); });
									Expect(libFacetEnvelope.normalizeForComparison(pResponse.Body)).to.deep.equal(libFacetEnvelope.normalizeForComparison(tmpFirst.Body));
									let tmpDelta = cacheDelta(tmpBefore, T.cacheStats());
									Expect(tmpDelta).to.include({ Misses: 1, Hits: 1, Stores: 1, StaleHits: 0, Flights: 1 });
									Expect(tmpDelta.Bypass).to.deep.equal({});
								})
						], fDone);
				});

			test('If-None-Match: a 304 decided before execution (no SQL: a provider spy, Statements 0 in-process), with the standard and M4 headers; a list and * match',
				(fDone) =>
				{
					let tmpETag = null;
					let tmpSpy = null;
					let tmpBefore = null;
					series(
						[
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { tmpETag = pResponse.Headers.etag; }),
							(fNext) => { tmpBefore = T.cacheStats(); tmpSpy = spyStatements(H); Expect(tmpSpy.Providers).to.be.greaterThan(0); return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, () => { return { 'if-none-match': tmpETag }; },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(304);
									Expect(pResponse.Body).to.equal(null);
									Expect(pResponse.Headers.etag).to.equal(tmpETag);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('NotModified');
									Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
									Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Exact');
									Expect(pResponse.Headers['cache-control']).to.equal('private, no-cache');
									Expect(pResponse.Headers['x-retold-facet-contract']).to.equal('1');
								}),
							(fNext) => { T.query('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': `W/"fv1:0000000000000000", ${tmpETag}` }, (pResponse) => { Expect(pResponse.Status).to.equal(304); })(fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': '*' }, (pResponse) => { Expect(pResponse.Status).to.equal(304); }),
							T.inProcess('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': '*' }, {},
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError).to.not.exist;
									Expect(pEnvelope).to.equal(null);
									Expect(pMeta).to.include({ NotModified: true, Statements: 0, Version: tmpETag.slice(3, -1) });
									Expect(pMeta.Cache).to.include({ Status: 'NotModified', LagMS: 0 });
									tmpSpy.restore();
									Expect(tmpSpy.Count, 'the 304 path runs no SQL').to.equal(0);
									Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ NotModified: 4, Hits: 0, Misses: 0, Stores: 0 });
								}),
							// A stale or foreign tag is no match: the answer comes back (a hit here).
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': 'W/"fv1:0000000000000000"' }, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); })
						], (pError) => { if (tmpSpy) { tmpSpy.restore(); } return fDone(pError); });
				});

			test('a 304 only after authorization: 401 (anonymous), 404 (an unknown entity) and 403 (an ad-hoc facet) win over a matching If-None-Match; another tenant never gets one',
				(fDone) =>
				{
					let tmpETag = null;
					series(
						[
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { tmpETag = pResponse.Headers.etag; }),
							T.query('Document', Q_DOCUMENT_STATUS, null, { 'if-none-match': '*' },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(401);
									Expect(pResponse.Body.Error.Code).to.equal('FACET_UNAUTHENTICATED');
								}),
							T.query('NoSuchEntity', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': '*' },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(404);
									Expect(pResponse.Body.Error.Code).to.equal('FACET_UNKNOWN_ENTITY');
								}),
							T.query('Document', { Facets: [ { Key: 'Status', Facet: 'Document.Status', Definition: { Fold: 'Terms' } } ] }, LEAD, { 'if-none-match': '*' },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(403);
									Expect(pResponse.Body.Error.Code).to.equal('FACET_ADHOC_FORBIDDEN');
								}),
							// Tenant 2 with tenant 1's ETag: its own key, its own Version, its own counts.
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, () => { return { 'if-none-match': tmpETag }; },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Headers.etag).to.not.equal(tmpETag);
									Expect(bucketCount(pResponse.Body, 'Status', 'Withdrawn')).to.be.greaterThan(0);
								})
						], fDone);
				});

			test('every write kind through the stock CRUD routes bumps exactly the §41 keys (column precision, \'#row\', both tenants of a move, \'*\' for a global lookup), one tick per record',
				(fDone) =>
				{
					let tmpFrom = 0;
					let tmpID = null;
					let tmpUpsertID = null;
					let tmpDraft = null;
					let tmpProject = null;
					let tmpFormType = null;
					let fBumps = () => { return _Bumps.slice(tmpFrom).map(bumpFacts); };
					let fMark = (fNext) => { tmpFrom = _Bumps.length; return fNext(); };
					let fUpdate = (pColumns) => { return { Entity: 'Document', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: pColumns }; };
					series(
						[
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.rows('Project', null, 1, LEAD, (pRows) => { tmpProject = pRows[0]; }),
							T.rows('FormType', null, 1, LEAD, (pRows) => { tmpFormType = pRows[0]; }),
							// single Create
							fMark,
							T.call('POST', '/1.0/Document', { Title: 'Invalidation create', Status: 'Draft', DocumentDate: '2026-03-15 00:00:00', IDFormType: 4, IDProject: 1, IDCustomer: 1 }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									tmpID = pResponse.Body.IDDocument;
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Create', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#row' ] } ]);
									let tmpSeq = libRetoldFacetingUtil.parseSeq(_Bumps[_Bumps.length - 1].Seq);
									Expect(tmpSeq.Epoch).to.equal(H.fable.RetoldFacetingChangeIntake.NodeEpoch);
								}),
							// bulk Create: one bump per record, each row's own tenant, consecutive Seqs
							fMark,
							T.call('POST', '/1.0/Documents', [ { Title: 'Bulk A', Status: 'Draft', IDCustomer: 1 }, { Title: 'Bulk B', Status: 'Draft', IDCustomer: 2 } ], LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(fBumps().map((pBump) => { return pBump.TenantKeys; })).to.deep.equal([ [ '#any', '1' ], [ '#any', '2' ] ]);
									Expect(fBumps().every((pBump) => { return (pBump.Operation === 'Create') && (pBump.Columns.join() === '#row'); })).to.equal(true);
									let tmpSeqs = _Bumps.slice(tmpFrom).map((pBump) => { return libRetoldFacetingUtil.parseSeq(pBump.Seq).N; });
									Expect(tmpSeqs[1]).to.equal(tmpSeqs[0] + 1);
								}),
							// Update by PUT /1.0/E: the changed column, the audit columns, '#cols'
							fMark,
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, Status: 'Final' }; }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(fBumps()).to.deep.equal([ fUpdate([ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ]) ]);
								}),
							// PUT /1.0/E/:id and PATCH /1.0/E/:id
							fMark,
							(fNext) => { T.call('PUT', `/1.0/Document/${tmpID}`, { Title: 'Renamed by id' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ fUpdate([ '#cols', 'Title', 'UpdateDate', 'UpdatingIDUser' ]) ]); })(fNext); },
							fMark,
							(fNext) => { T.call('PATCH', `/1.0/Document/${tmpID}`, { Summary: 'Patched' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ fUpdate([ '#cols', 'Summary', 'UpdateDate', 'UpdatingIDUser' ]) ]); })(fNext); },
							// bulk Update: one bump per record
							fMark,
							(fNext) => { T.call('PUT', '/1.0/Documents', [ { IDDocument: tmpID, Summary: 'Bulk one' }, { IDDocument: tmpDraft.IDDocument, Summary: 'Bulk two' } ], LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ fUpdate([ '#cols', 'Summary', 'UpdateDate', 'UpdatingIDUser' ]), fUpdate([ '#cols', 'Summary', 'UpdateDate', 'UpdatingIDUser' ]) ]); })(fNext); },
							// Upsert: the create path, then the update path; Upserts (one bump per record)
							fMark,
							T.call('PUT', '/1.0/Document/Upsert', { Title: 'Upsert new', Status: 'Draft', IDCustomer: 1 }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									tmpUpsertID = pResponse.Body.IDDocument;
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Create', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#row' ] } ]);
								}),
							fMark,
							(fNext) => { T.call('PUT', '/1.0/Document/Upsert', { IDDocument: tmpUpsertID, Status: 'Archived' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ fUpdate([ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ]) ]); })(fNext); },
							fMark,
							(fNext) => { T.call('PUT', '/1.0/Document/Upserts', [ { Title: 'Upserts new', Status: 'Draft', IDCustomer: 2 }, { IDDocument: tmpUpsertID, Status: 'Draft' } ], LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Create', Source: 'Interim', TenantKeys: [ '#any', '2' ], Columns: [ '#row' ] }, fUpdate([ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ]) ]); })(fNext); },
							// Delete and Undelete change membership: '#row'
							fMark,
							(fNext) => { T.call('DELETE', `/1.0/Document/${tmpUpsertID}`, null, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Delete', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#row' ] } ]); })(fNext); },
							fMark,
							(fNext) => { T.call('GET', `/1.0/Document/Undelete/${tmpUpsertID}`, null, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Undelete', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#row' ] } ]); })(fNext); },
							// A tenant move: the tenant column is a row column ('#row'); both tenants; then back
							fMark,
							(fNext) =>
							{
								T.call('PUT', '/1.0/Project', { IDProject: tmpProject.IDProject, IDCustomer: 2 }, LEAD, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(fBumps()).to.deep.equal([ { Entity: 'Project', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '1', '2' ], Columns: [ '#cols', '#row', 'UpdateDate', 'UpdatingIDUser' ] } ]);
									})(fNext);
							},
							(fNext) => { H.request('PUT', '/1.0/Project', { IDProject: tmpProject.IDProject, IDCustomer: 1 }, OTHER, (pError, pResponse) => { if (pError) { return fNext(pError); } return fNext((pResponse.Status === 200) ? null : new Error(`move back: ${pResponse.Status}`)); }); },
							// A global lookup (no tenant column): '*', no audit columns on FormType
							fMark,
							(fNext) =>
							{
								T.call('PUT', '/1.0/FormType', { IDFormType: tmpFormType.IDFormType, Category: 'Edited' }, LEAD, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(fBumps()).to.deep.equal([ { Entity: 'FormType', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '*' ], Columns: [ '#cols', 'Category' ] } ]);
									})(fNext);
							},
							(fNext) => { T.call('PUT', '/1.0/FormType', { IDFormType: tmpFormType.IDFormType, Category: tmpFormType.Category }, LEAD, {}, null)(fNext); }
						], fDone);
				});

			test('notify() / notifyByFilter(): raw writers bump exactly their keys and invalidate exactly their dependents; never throw',
				(fDone) =>
				{
					let tmpFrom = 0;
					let tmpBefore = null;
					let fMark = (fNext) => { tmpFrom = _Bumps.length; tmpBefore = T.cacheStats(); return fNext(); };
					let fBumps = () => { return _Bumps.slice(tmpFrom).map(bumpFacts); };
					let fWarm = [ T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null), T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, null) ];
					let fBoth = (pLead, pOther) =>
					{
						return [
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'tenant 1').to.equal(pLead); }),
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'tenant 2').to.equal(pOther); })
						];
					};
					let tmpService = H.faceting;
					series(
						[].concat(
							fWarm,
							[
								fMark,
								(fNext) =>
								{
									let tmpSeq = tmpService.notify('Document', { Operation: 'Update', IDs: [ 1 ], Tenants: [ 2 ], ChangedColumns: [ 'Title' ] });
									Expect(tmpSeq).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Update', Source: 'Notify', TenantKeys: [ '#any', '2' ], Columns: [ '#cols', 'Title' ] } ]);
									return fNext();
								}
							],
							// Title is read by neither answer: both still hit.
							fBoth('Hit', 'Hit'),
							[
								fMark,
								(fNext) =>
								{
									Expect(tmpService.notifyChanged('Document', { Records: [ { IDDocument: 5, IDCustomer: 1, Status: 'Final' } ], ChangedColumns: [ 'Status' ] })).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Update', Source: 'Notify', TenantKeys: [ '#any', '1' ], Columns: [ '#cols', 'Status' ] } ]);
									return fNext();
								}
							],
							fBoth('Miss', 'Hit'),
							[
								fMark,
								(fNext) =>
								{
									// Nothing known: every tenant, every column.
									Expect(tmpService.notify('Document')).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'Update', Source: 'Notify', TenantKeys: [ '#any', '*' ], Columns: [ '#all' ] } ]);
									return fNext();
								}
							],
							fBoth('Miss', 'Miss'),
							[
								fMark,
								(fNext) =>
								{
									Expect(tmpService.notifyByFilter('Document', 'FBV~Status~EQ~Draft', { Tenants: [ 2 ] })).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
									Expect(fBumps()).to.deep.equal([ { Entity: 'Document', Operation: 'EntityDirty', Source: 'Notify', TenantKeys: [ '#any', '2' ], Columns: [ '#all' ] } ]);
									return fNext();
								}
							],
							fBoth('Hit', 'Miss'),
							[
								(fNext) =>
								{
									Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Hits: 1, Misses: 1 });
									// Refused, never thrown (the caller's commit already happened).
									let tmpInvalid = H.fable.RetoldFacetingChangeIntake.stats().Invalid;
									let tmpTick = H.fable.RetoldFacetingGenerations.GlobalTick;
									Expect(tmpService.notify('NoSuchEntity', {})).to.equal(null);
									Expect(tmpService.notify('Document', { Operation: 'Explode' })).to.equal(null);
									Expect(tmpService.notify('Document', { Tenants: 2 })).to.equal(null);
									Expect(tmpService.notifyByFilter('Document', '')).to.equal(null);
									Expect(tmpService.notifyByFilter('Document', 7)).to.equal(null);
									Expect(H.fable.RetoldFacetingChangeIntake.stats().Invalid).to.equal(tmpInvalid + 5);
									Expect(H.fable.RetoldFacetingGenerations.GlobalTick).to.equal(tmpTick);
									Expect(H.fable.RetoldFacetingChangeIntake.stats().BySource.Notify).to.be.at.least(4);
									return fNext();
								}
							]), fDone);
				});

			test('dependent answers miss, unrelated ones hit (stats): a Title edit keeps a Status answer, a Status edit misses it alone, a label-column edit invalidates the labelled facet, an unread Project column keeps Project answers',
				(fDone) =>
				{
					let tmpDraft = null;
					let tmpClient = null;
					let tmpBefore = null;
					let tmpLeadStatus = null;
					let tmpProject = null;
					let fWarm = () =>
					{
						return [
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { tmpLeadStatus = pResponse.Body; }),
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, null),
							T.query('Project', Q_PROJECT_CLIENT, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, null)
						];
					};
					let fExpect = (pStatuses) =>
					{
						return [
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'Document.Status t1').to.equal(pStatuses[0]); tmpLeadStatus = pResponse.Body; }),
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'Project.Status t1').to.equal(pStatuses[1]); }),
							T.query('Project', Q_PROJECT_CLIENT, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'Project.IDClient t1').to.equal(pStatuses[2]); if (tmpClient) { tmpClient.Seen = bucketLabel(pResponse.Body, 'Client', tmpClient.IDClient); } }),
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'Document.Status t2').to.equal(pStatuses[3]); })
						];
					};
					let fMark = (fNext) => { tmpBefore = T.cacheStats(); return fNext(); };
					series(
						[].concat(
							[
								T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
								T.rows('Project', 'FBV~IDClient~EQ~3', 1, LEAD, (pRows) => { tmpProject = pRows[0]; }),
								T.rows('Client', 'FBV~IDClient~EQ~3', 1, LEAD, (pRows) => { tmpClient = pRows[0]; })
							],
							fWarm(),
							[ fMark, T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpDraft.IDDocument, Title: 'Only the title' }; }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); }) ],
							fExpect([ 'Hit', 'Hit', 'Hit', 'Hit' ]),
							[ (fNext) => { Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Hits: 4, Misses: 0 }); return fNext(); } ],
							[
								fMark,
								(fNext) =>
								{
									let tmpDrafts = bucketCount(tmpLeadStatus, 'Status', 'Draft');
									T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Final' }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); tmpDraft.DraftsBefore = tmpDrafts; })(fNext);
								}
							],
							fExpect([ 'Miss', 'Hit', 'Hit', 'Hit' ]),
							[
								(fNext) =>
								{
									Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Hits: 3, Misses: 1, Stores: 1 });
									Expect(bucketCount(tmpLeadStatus, 'Status', 'Draft')).to.equal(tmpDraft.DraftsBefore - 1);
									return fNext();
								},
								fMark,
								T.call('PUT', '/1.0/Client', () => { return { IDClient: tmpClient.IDClient, Name: 'Relabelled Client' }; }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })
							],
							fExpect([ 'Hit', 'Hit', 'Miss', 'Hit' ]),
							[
								(fNext) => { Expect(tmpClient.Seen).to.equal('Relabelled Client'); return fNext(); },
								fMark,
								T.call('PUT', '/1.0/Project', () => { return { IDProject: tmpProject.IDProject, Name: 'An unread column' }; }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })
							],
							fExpect([ 'Hit', 'Hit', 'Hit', 'Hit' ]),
							[
								(fNext) => { Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Hits: 4, Misses: 0 }); return fNext(); },
								T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }; }, OUTSIDER, {}, null),
								T.call('PUT', '/1.0/Client', () => { return { IDClient: tmpClient.IDClient, Name: tmpClient.Name }; }, OUTSIDER, {}, null)
							]), fDone);
				});

			test('a Records-bearing Query (E1) is cacheable and reads \'#cols\' on the pivot: any Project column edit invalidates it',
				(fDone) =>
				{
					let tmpE1 = (
						{
							Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } } ],
							Facets: [ { Key: 'Status', Facet: 'Project.Status' } ],
							Records: { Begin: 0, Cap: 5, Sort: [ { Field: 'IDProject', Dir: 'ASC' } ] }
						});
					let tmpFirst = null;
					series(
						[
							T.query('Project', tmpE1, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); tmpFirst = pResponse.Body; Expect(tmpFirst.Records.length).to.be.greaterThan(0); }),
							T.query('Project', tmpE1, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); Expect(pResponse.Body.Records).to.deep.equal(tmpFirst.Records); }),
							(fNext) => { T.call('PUT', '/1.0/Project', { IDProject: tmpFirst.Records[0].IDProject, Name: 'Hydrated name' }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							T.query('Project', tmpE1, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss');
									Expect(pResponse.Body.Records[0].Name).to.equal('Hydrated name');
								}),
							(fNext) => { T.call('PUT', '/1.0/Project', { IDProject: tmpFirst.Records[0].IDProject, Name: tmpFirst.Records[0].Name }, OUTSIDER, {}, null)(fNext); }
						], fDone);
				});

			test('a global lookup (FormType) edit invalidates every tenant\'s labelled answer and reaches every tenant\'s stream through the global tick',
				(fDone) =>
				{
					let tmpLeadStream = null;
					let tmpOtherStream = null;
					let tmpFormType = null;
					series(
						[
							T.rows('FormType', 'FBV~IDFormType~EQ~4', 1, LEAD, (pRows) => { tmpFormType = pRows[0]; }),
							T.query('Document', Q_DOCUMENT_FORM, LEAD, {}, (pResponse) => { Expect(pResponse.Body.DependsOn).to.deep.equal([ 'Document', 'FormType' ]); }),
							T.query('Document', Q_DOCUMENT_FORM, OTHER, {}, null),
							T.query('Document', Q_DOCUMENT_FORM, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							T.openStream(LEAD, (pStream) => { tmpLeadStream = pStream; }),
							T.openStream(OTHER, (pStream) => { tmpOtherStream = pStream; }),
							(fNext) => { T.call('PUT', '/1.0/FormType', { IDFormType: tmpFormType.IDFormType, Name: 'Form D (renamed)' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							T.query('Document', Q_DOCUMENT_FORM, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); Expect(bucketLabel(pResponse.Body, 'Form', tmpFormType.IDFormType)).to.equal('Form D (renamed)'); }),
							T.query('Document', Q_DOCUMENT_FORM, OTHER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { waitFor(() => { return (tmpLeadStream.generations('FormType').length > 0) && (tmpOtherStream.generations('FormType').length > 0); }, 2000, 'the FormType generation on both tenants\' streams', fNext); },
							(fNext) =>
							{
								[ tmpLeadStream, tmpOtherStream ].forEach((pStream) => { Expect(Object.keys(pStream.generations('FormType')[0].Data).sort()).to.deep.equal([ 'Entity', 'Generation', 'Seq' ]); });
								return fNext();
							},
							(fNext) => { T.call('PUT', '/1.0/FormType', { IDFormType: tmpFormType.IDFormType, Name: tmpFormType.Name }, LEAD, {}, null)(fNext); }
						], fDone);
				});

			test('tenant isolation: a tenant-1 write never invalidates tenant 2\'s answers nor reaches a tenant-2 stream; the tenant-1 stream gets only { Entity, Generation, Seq }',
				(fDone) =>
				{
					let tmpLeadStream = null;
					let tmpOtherStream = null;
					let tmpDraft = null;
					let tmpBefore = null;
					series(
						[
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, null),
							T.openStream(LEAD, (pStream) => { tmpLeadStream = pStream; }),
							T.openStream(OTHER, (pStream) => { tmpOtherStream = pStream; }),
							(fNext) => { tmpBefore = T.cacheStats(); return fNext(); },
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Archived' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							(fNext) => { waitFor(() => { return tmpLeadStream.generations('Document').length > 0; }, 2000, 'the Document generation on the tenant-1 stream', fNext); },
							pause(SSE_OPTIONS.CoalesceMS * 5),
							(fNext) =>
							{
								let tmpEvent = tmpLeadStream.generations('Document')[0];
								Expect(Object.keys(tmpEvent.Data).sort()).to.deep.equal([ 'Entity', 'Generation', 'Seq' ]);
								Expect(tmpEvent.Data.Generation).to.match(/^g:[0-9a-f]{12}$/);
								Expect(tmpEvent.Data.Seq).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
								// No 'id:' line (events are not replayed; an id would carry the Seq).
								Expect(tmpEvent.ID).to.equal(null);
								Expect(tmpOtherStream.generations().length, 'tenant 2 sees nothing of tenant 1').to.equal(0);
								return fNext();
							},
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Hits: 1, Misses: 1 }); return fNext(); },
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, LEAD, {}, null)(fNext); }
						], fDone);
				});

			test('Exact never serves a stale entry; Bounded serves Stale within MaxLagMS (never a 304, the entry\'s Seq), starts ONE background refresh for any number of viewers, then answers fresh',
				(fDone) =>
				{
					let tmpDraft = null;
					let tmpFirst = null;
					let tmpBefore = null;
					let tmpStores = 0;
					let tmpSpy = null;
					series(
						[
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, {}, (pResponse) => { tmpFirst = pResponse; Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Bounded'); }),
							// Another principal of the tenant writes (Member has no write of its own: no upgrade).
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Final' }, OUTSIDER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							(fNext) => { tmpBefore = T.cacheStats(); tmpSpy = spyStatements(H); return fNext(); },
							// Six viewers of the stale key at once (a slow list behavior holds every request, and the
							// refresh, ~30 ms per probe / execution): every one is served Stale, ONE refresh runs.
							(fNext) =>
							{
								_Flags.SlowMS = 30;
								let tmpPending = 6;
								let tmpErrors = [];
								for (let i = 0; i < 6; i++)
								{
									let tmpHeaders = (i === 0) ? { 'if-none-match': tmpFirst.Headers.etag } : {};
									T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, tmpHeaders,
										(pResponse) =>
										{
											Expect(pResponse.Status, 'a Stale answer is never a 304').to.equal(200);
											Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Stale');
											Expect(pResponse.Headers.etag, 'the Version of the representation served').to.equal(tmpFirst.Headers.etag);
											Expect(pResponse.Headers['x-retold-facet-seq'], 'the Seq the stale answer covers').to.equal(tmpFirst.Headers['x-retold-facet-seq']);
											Expect(pResponse.Body).to.include({ Cached: true, Stale: true, Exact: false });
											Expect(pResponse.Body.LagMS).to.be.within(0, 5000);
											Object.keys(pResponse.Body.Facets).forEach((pKey) => { Expect(pResponse.Body.Facets[pKey]).to.include({ Cached: true, Stale: true, Exact: false, LagMS: pResponse.Body.LagMS }); });
											Expect(bucketCount(pResponse.Body, 'Status', 'Draft')).to.equal(bucketCount(tmpFirst.Body, 'Status', 'Draft'));
										})(
										(pError) =>
										{
											if (pError)
											{
												tmpErrors.push(pError);
											}
											tmpPending--;
											if (tmpPending === 0)
											{
												_Flags.SlowMS = 0;
												return fNext(tmpErrors[0]);
											}
										});
								}
							},
							(fNext) =>
							{
								let tmpDelta = cacheDelta(tmpBefore, T.cacheStats());
								Expect(tmpDelta).to.include({ StaleHits: 6, Refreshes: 1, Hits: 0, Misses: 0 });
								tmpStores = tmpBefore.Stores;
								waitFor(() => { return T.cacheStats().Stores > tmpStores; }, 5000, 'the background refresh to store', fNext);
							},
							(fNext) => { tmpSpy.restore(); Expect(tmpSpy.Count, 'the refresh executed').to.be.greaterThan(0); return fNext(); },
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit');
									Expect(pResponse.Body).to.include({ Stale: false, Exact: true, Cached: true });
									Expect(pResponse.Headers.etag).to.not.equal(tmpFirst.Headers.etag);
									Expect(bucketCount(pResponse.Body, 'Status', 'Draft')).to.equal(bucketCount(tmpFirst.Body, 'Status', 'Draft') - 1);
									Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Refreshes: 1, RefreshErrors: 0 });
								}),
							// Exact after another write: a miss, never the stale entry.
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, OUTSIDER, {}, null)(fNext); },
							(fNext) => { tmpBefore = T.cacheStats(); return fNext(); },
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, { Mode: 'Exact' }), MEMBER, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss');
									Expect(pResponse.Body).to.include({ Stale: false, Cached: false, Exact: true });
									Expect(bucketCount(pResponse.Body, 'Status', 'Draft')).to.equal(bucketCount(tmpFirst.Body, 'Status', 'Draft'));
									Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ StaleHits: 0, Misses: 1, Refreshes: 0 });
								})
						], (pError) => { _Flags.SlowMS = 0; if (tmpSpy) { tmpSpy.restore(); } return fDone(pError); });
				});

			test('Fast serves a stale entry past MaxLagMS (until Cache.MaxAgeMS); Bounded with MaxLagMS 0 does not',
				(fDone) =>
				{
					let tmpDraft = null;
					series(
						[
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', Q_DOCUMENT_STATUS, MEMBER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Title: 'Fast' }, OUTSIDER, {}, null)(fNext); },
							(fNext) => { H.faceting.notify('Document', { Tenants: [ 1 ] }); return fNext(); },
							pause(15),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, { Mode: 'Bounded', MaxLagMS: 0 }), MEMBER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); Expect(pResponse.Body.Stale).to.equal(false); }),
							(fNext) => { H.faceting.notify('Document', { Tenants: [ 1 ] }); return fNext(); },
							pause(15),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, { Mode: 'Fast', MaxLagMS: 0 }), MEMBER, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Stale');
									Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Fast');
									Expect(pResponse.Body).to.include({ Stale: true, Exact: false });
									Expect(pResponse.Body.LagMS).to.be.at.least(10);
								})
						], fDone);
				});

			test('single flight: concurrent misses of one answer share one execution (the joiners: Coalesced, Statements 0)',
				(fDone) =>
				{
					let tmpBefore = null;
					let tmpResults = [];
					series(
						[
							(fNext) => { tmpBefore = T.cacheStats(); _Flags.SlowMS = 40; return fNext(); },
							(fNext) =>
							{
								let tmpPending = 4;
								for (let i = 0; i < 4; i++)
								{
									let tmpRequest = libHarness.syntheticRequest('Project', LEAD, Q_PROJECT_CLIENT);
									H.faceting.queryInternal('Project', Q_PROJECT_CLIENT, tmpRequest, {},
										(pError, pEnvelope, pMeta) =>
										{
											tmpResults.push({ Error: pError, Envelope: pEnvelope, Meta: pMeta });
											tmpPending--;
											if (tmpPending === 0)
											{
												setImmediate(() => { fNext(); });
											}
										});
								}
							},
							(fNext) =>
							{
								_Flags.SlowMS = 0;
								tmpResults.forEach((pResult) => { Expect(pResult.Error).to.not.exist; });
								let tmpLeaders = tmpResults.filter((pResult) => { return !pResult.Meta.Cache.Coalesced; });
								let tmpJoiners = tmpResults.filter((pResult) => { return pResult.Meta.Cache.Coalesced; });
								Expect(tmpLeaders.length).to.equal(1);
								Expect(tmpJoiners.length).to.equal(3);
								Expect(tmpLeaders[0].Meta.Statements).to.be.greaterThan(0);
								tmpJoiners.forEach(
									(pJoiner) =>
									{
										Expect(pJoiner.Meta).to.include({ Statements: 0, Version: tmpLeaders[0].Meta.Version });
										Expect(pJoiner.Meta.Cache).to.include({ Status: 'Miss', Coalesced: true });
										Expect(pJoiner.Envelope).to.not.equal(tmpLeaders[0].Envelope);
										Expect(libFacetEnvelope.normalizeForComparison(pJoiner.Envelope)).to.deep.equal(libFacetEnvelope.normalizeForComparison(tmpLeaders[0].Envelope));
										Expect(pJoiner.Envelope.Version).to.equal(tmpLeaders[0].Envelope.Version);
									});
								Expect(cacheDelta(tmpBefore, T.cacheStats())).to.include({ Misses: 4, Flights: 1, Stores: 1 });
								return fNext();
							}
						], (pError) => { _Flags.SlowMS = 0; return fDone(pError); });
				});

			test('read-your-writes and MinSeq over HTTP: the writer\'s Bounded read is upgraded to Exact (never stale); MinSeq (body or header, any epoch) too; a malformed header MinSeq is a 400',
				(fDone) =>
				{
					let tmpDraft = null;
					let tmpWriteSeq = null;
					let tmpUpgrades = null;
					series(
						[
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Bounded'); }),
							(fNext) => { tmpUpgrades = H.fable.RetoldFacetingReadYourWrites.stats().Upgrades; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Final' }, LEAD, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										tmpWriteSeq = H.fable.RetoldFacetingChangeIntake.currentSeq();
									})(fNext);
							},
							// The tracker holds the writer under the key its reads resolve to (and nobody else).
							(fNext) =>
							{
								H.faceting.Host.resolvePrincipal(libHarness.syntheticRequest('Document', LEAD),
									(pError, pPrincipal) =>
									{
										if (pError)
										{
											return fNext(pError);
										}
										let tmpWrite = H.fable.RetoldFacetingReadYourWrites.lastWrite(pPrincipal);
										Expect(tmpWrite).to.include({ Seq: tmpWriteSeq });
										H.faceting.Host.resolvePrincipal(libHarness.syntheticRequest('Document', MEMBER),
											(pMemberError, pMember) =>
											{
												if (pMemberError)
												{
													return fNext(pMemberError);
												}
												Expect(H.fable.RetoldFacetingReadYourWrites.lastWrite(pMember)).to.equal(null);
												return fNext();
											});
									});
							},
							// Another principal sharing the key still gets the stale entry …
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Stale'); }),
							// … the writer does not: its own write is in its answer.
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Exact; upgraded=ReadYourWrites');
									Expect([ 'Miss', 'Hit' ]).to.include(pResponse.Headers['x-retold-facet-cache']);
									Expect(pResponse.Body).to.include({ Stale: false, Exact: true });
									Expect(Number(pResponse.Headers['x-retold-facet-seq'].split(':')[2])).to.be.at.least(Number(tmpWriteSeq.split(':')[2]));
								}),
							(fNext) => { H.faceting.notify('Document', { Tenants: [ 1 ], ChangedColumns: [ 'Status' ] }); return fNext(); },
							T.query('Document', () => { return withFreshness(Q_DOCUMENT_STATUS, Object.assign({ MinSeq: tmpWriteSeq }, BOUNDED)); }, MEMBER, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Exact; upgraded=MinSeq'); Expect(pResponse.Body.Stale).to.equal(false); }),
							(fNext) => { H.faceting.notify('Document', { Tenants: [ 1 ], ChangedColumns: [ 'Status' ] }); return fNext(); },
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, { 'x-retold-facet-minseq': 'e:0badcafe:99' }, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Exact; upgraded=MinSeq'); Expect(pResponse.Body.Stale).to.equal(false); }),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), MEMBER, { 'x-retold-facet-minseq': 'e:nothex:1' },
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(400);
									Expect(pResponse.Body.Error.Code).to.equal('FACET_REQUEST_INVALID');
									Expect(pResponse.Body.Error.Detail).to.include({ Field: 'Freshness.MinSeq' });
								}),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, { Mode: 'Sometimes' }), MEMBER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(400); Expect(pResponse.Body.Error.Detail).to.include({ Field: 'Freshness.Mode' }); }),
							(fNext) =>
							{
								let tmpAfter = H.fable.RetoldFacetingReadYourWrites.stats().Upgrades;
								Expect(tmpAfter.ReadYourWrites - tmpUpgrades.ReadYourWrites).to.equal(1);
								Expect(tmpAfter.MinSeq - tmpUpgrades.MinSeq).to.equal(2);
								return fNext();
							},
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, OUTSIDER, {}, null)(fNext); }
						], fDone);
				});

			test('X-Retold-Facet-Seq on Records / Count / Keys (never cached: no lookups, no stores); omitted when Freshness.SeqHeader is false',
				(fDone) =>
				{
					let tmpBefore = null;
					let fNoCache = (pResponse) =>
					{
						Expect(pResponse.Status).to.equal(200);
						Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
						Expect(pResponse.Headers).to.not.have.property('x-retold-facet-cache');
						Expect(pResponse.Headers.etag).to.match(ETAG_PATTERN);
					};
					series(
						[
							(fNext) => { tmpBefore = T.cacheStats(); return fNext(); },
							T.call('POST', '/1.0/Facet/Document/Records/0/5', { Clauses: [] }, LEAD, {}, fNoCache),
							T.call('POST', '/1.0/Facet/Document/Records/Count', { Clauses: [] }, LEAD, {}, fNoCache),
							T.call('POST', '/1.0/Facet/Document/Keys', { Cap: 10 }, LEAD, {}, fNoCache),
							(fNext) =>
							{
								let tmpDelta = cacheDelta(tmpBefore, T.cacheStats());
								Expect(tmpDelta).to.include({ Hits: 0, Misses: 0, StaleHits: 0, Stores: 0, Flights: 0 });
								Expect(tmpDelta.Bypass).to.deep.equal({});
								H.faceting.options.Freshness.SeqHeader = false;
								return fNext();
							},
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(pResponse.Headers).to.not.have.property('x-retold-facet-seq'); Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							T.call('POST', '/1.0/Facet/Document/Records/Count', { Clauses: [] }, LEAD, {}, (pResponse) => { Expect(pResponse.Headers).to.not.have.property('x-retold-facet-seq'); })
						], (pError) => { H.faceting.options.Freshness.SeqHeader = true; return fDone(pError); });
				});

			test('uncacheable answers run as M2 with a Bypass reason (counted): PlanErrors, ForceEngine, Staged, NotCacheable, Errors, TooLarge, TooManyEntities',
				(fDone) =>
				{
					let tmpBefore = null;
					let tmpBypassETag = null;
					let tmpSpy = null;
					let tmpE1 = null;
					series(
						[
							(fNext) => { tmpBefore = T.cacheStats(); return fNext(); },
							// PlanErrors (a per-facet 400): a digest Version, and its 304 comes only after execution
							T.query('Document', { Facets: [ { Key: 'Status', Facet: 'Document.Status' }, { Key: 'Nope', Facet: 'Document.Nope' } ] }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Bypass');
									Expect(pResponse.Body.Errors.Nope.Code).to.equal('FACET_UNKNOWN_FACET');
									tmpBypassETag = pResponse.Headers.etag;
								}),
							(fNext) => { tmpSpy = spyStatements(H); return fNext(); },
							(fNext) =>
							{
								T.query('Document', { Facets: [ { Key: 'Status', Facet: 'Document.Status' }, { Key: 'Nope', Facet: 'Document.Nope' } ] }, LEAD, { 'if-none-match': tmpBypassETag },
									(pResponse) =>
									{
										tmpSpy.restore();
										Expect(pResponse.Status).to.equal(304);
										Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Bypass');
										Expect(tmpSpy.Count, 'an uncacheable 304 executes first (M2)').to.be.greaterThan(0);
									})(fNext);
							},
							// ForceEngine (the Reference oracle, in-process): never cached; DependsOn as Live
							T.inProcess('Document', Q_DOCUMENT_FORM, LEAD, {}, { ForceEngine: 'Reference' },
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError).to.not.exist;
									Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'ForceEngine' });
									Expect(pEnvelope.Engine).to.equal('Reference');
									Expect(pEnvelope.DependsOn).to.deep.equal([ 'Document', 'FormType' ]);
								}),
							// Staged (post-execution): not stored, a digest Version
							(fNext) =>
							{
								tmpE1 = { Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] };
								return fNext();
							},
							(fNext) =>
							{
								T.inProcess('Project', tmpE1, LEAD, {}, { PlanForm: { Staged: 'Always' } },
									(pError, pEnvelope, pMeta) =>
									{
										Expect(pError).to.not.exist;
										Expect(pMeta.Staged.Relations).to.be.greaterThan(0);
										Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'Staged' });
										Expect(pEnvelope.Version).to.equal(pMeta.Version);
									})(fNext);
							},
							// NotCacheable (a list behavior sets FacetCacheable = false)
							(fNext) => { _Flags.NotCacheable = true; return fNext(); },
							T.query('Issue', Q_ISSUE_SEVERITY, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Bypass'); }),
							(fNext) => { _Flags.NotCacheable = false; return fNext(); },
							T.query('Issue', Q_ISSUE_SEVERITY, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							// Errors (post-execution: a per-facet 422 from post-processing)
							T.query('Document', { Facets: [ { Key: 'Status', Facet: 'Document.Status' }, { Key: 'Daily', Facet: 'Document.DocumentDate', Interval: 'day' } ] }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Body.Errors.Daily.Code).to.equal('FACET_INTERVAL_TOO_FINE');
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Bypass');
								}),
							// TooLarge: not stored, yet the generation Version stands (a 304 before execution)
							(fNext) => { H.faceting.options.Cache.MaxEntryBytes = 600; return fNext(); },
							T.query('Project', Q_PROJECT_CLIENT, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); tmpBypassETag = pResponse.Headers.etag; }),
							(fNext) => { T.query('Project', Q_PROJECT_CLIENT, LEAD, { 'if-none-match': tmpBypassETag }, (pResponse) => { Expect(pResponse.Status).to.equal(304); Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('NotModified'); })(fNext); },
							T.query('Project', Q_PROJECT_CLIENT, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { H.faceting.options.Cache.MaxEntryBytes = 4194304; return fNext(); },
							// TooManyEntities: more DepSet entities than MaxRelationsPerRequest → no probes
							(fNext) => { H.faceting.options.Limits.MaxRelationsPerRequest = 1; return fNext(); },
							T.inProcess('Project', Q_PROJECT_CLIENT, LEAD, {}, {}, (pError, pEnvelope, pMeta) => { Expect(pMeta && pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'TooManyEntities' }); Expect(pMeta.ProbeRuns).to.equal(0); }),
							(fNext) =>
							{
								H.faceting.options.Limits.MaxRelationsPerRequest = 32;
								let tmpDelta = cacheDelta(tmpBefore, T.cacheStats());
								Expect(tmpDelta.Bypass).to.deep.equal({ PlanErrors: 2, ForceEngine: 1, Staged: 1, NotCacheable: 1, Errors: 1, TooLarge: 2, TooManyEntities: 1 });
								Expect(tmpDelta).to.include({ Rejected: 2, NotModified: 1 });
								return fNext();
							}
						], (pError) =>
						{
							_Flags.NotCacheable = false;
							H.faceting.options.Cache.MaxEntryBytes = 4194304;
							H.faceting.options.Limits.MaxRelationsPerRequest = 32;
							if (tmpSpy)
							{
								tmpSpy.restore();
							}
							return fDone(pError);
						});
				});

			test('the wrapper never breaks a write: a throwing intake subscriber and a throwing bump listener leave the 2xx response, the bump, the invalidation and the stream intact; a behavior installed after attach runs around the intake',
				(fDone) =>
				{
					let tmpIntake = H.fable.RetoldFacetingChangeIntake;
					let tmpGenerations = H.fable.RetoldFacetingGenerations;
					let tmpTask = null;
					let tmpFrom = 0;
					let tmpErrors = 0;
					let tmpStream = null;
					let tmpAfter = 0;
					series(
						[
							T.rows('Task', null, 1, LEAD, (pRows) => { tmpTask = pRows[0]; }),
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							T.openStream(LEAD, (pStream) => { tmpStream = pStream; }),
							(fNext) =>
							{
								tmpIntake.subscribe('ThrowingSubscriber', () => { throw new Error('subscriber boom'); });
								tmpGenerations.subscribe('ThrowingListener', () => { throw new Error('listener boom'); });
								tmpErrors = tmpIntake.stats().SubscriberErrors;
								tmpFrom = _Bumps.length;
								tmpAfter = _Flags.AfterAttach;
								return fNext();
							},
							(fNext) =>
							{
								T.call('PUT', '/1.0/Task', { IDTask: tmpTask.IDTask, Status: (tmpTask.Status === 'Done') ? 'Open' : 'Done' }, LEAD, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(pResponse.Body.IDTask).to.equal(tmpTask.IDTask);
										Expect(_Bumps.slice(tmpFrom).map(bumpFacts)).to.deep.equal([ { Entity: 'Task', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ] } ]);
										Expect(tmpIntake.stats().SubscriberErrors).to.equal(tmpErrors + 1);
										Expect(_Flags.AfterAttach).to.equal(tmpAfter + 1);
										Expect(_Flags.AfterAttachThis).to.equal(true);
									})(fNext);
							},
							(fNext) => { waitFor(() => { return tmpStream.generations('Task').length > 0; }, 2000, 'the Task generation despite the throwing listener', fNext); },
							(fNext) => { tmpIntake.unsubscribe('ThrowingSubscriber'); tmpGenerations.unsubscribe('ThrowingListener'); return fNext(); },
							// Writes to a create path too, and the dependents still invalidate.
							(fNext) => { T.call('POST', '/1.0/Document', { Title: 'After the throwers', Status: 'Draft', IDCustomer: 1 }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							(fNext) => { T.call('PUT', '/1.0/Task', { IDTask: tmpTask.IDTask, Status: tmpTask.Status }, LEAD, {}, null)(fNext); }
						], (pError) =>
						{
							tmpIntake.unsubscribe('ThrowingSubscriber');
							tmpGenerations.unsubscribe('ThrowingListener');
							return fDone(pError);
						});
				});
		}
	);
};

/**
 * The intake installed AFTER host behaviors (ChangeCapture.Intake 'None' at attach, then
 * installChangeCapture): the earlier behaviors run first with the controller as this; the intake
 * wraps, never replaces; a later install wraps nothing twice.  Before the install a write moves no
 * generation (the documented hazard of Cache.Enabled without a change source: only notify() helps).
 */
const preexistingSuite = () =>
{
	suite
	(
		'ProjectTrack: the intake wraps host behaviors installed before it (Intake \'None\' at attach, then installChangeCapture)',
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = suiteTools(() => { return H; });
			let LEAD = null;
			let _Order = [];
			let _Bumps = [];

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Cache: { Enabled: true, ExposeStatus: true }, Freshness: EXPOSED.Freshness, SSE: SSE_OPTIONS, ChangeCapture: { Intake: 'None', NotifySettleMS: 0 } } },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							LEAD = H.as('Lead');
							H.fable.RetoldFacetingGenerations.subscribe('InvalidationTest', (pBump) => { _Bumps.push(pBump); _Order.push(`bump:${pBump.Operation}`); });
							// Host behaviors that exist before the intake wraps the slots.
							H.installBehavior('Document', 'Create-PostOperation',
								function (pRequest, pRequestState, fCallback)
								{
									_Order.push((this === H.faceting.Host.getRouteBoundController('Document')) ? 'host-create' : 'host-create(wrong this)');
									return fCallback();
								});
							H.installBehavior('Document', 'Update-PostOperation',
								function (pRequest, pRequestState, fCallback)
								{
									_Order.push((this === H.faceting.Host.getRouteBoundController('Document')) ? 'host-update' : 'host-update(wrong this)');
									// A host decoration of the record: never what the intake captured (it captured at entry).
									if (pRequestState.Record)
									{
										pRequestState.Record.Status = 'Decorated';
									}
									return fCallback();
								});
							return fDone();
						});
				});
			suiteTeardown((fDone) => { H.stop(fDone); });

			test('before the install: Source None, no X-Retold-Facet-Seq, and a write moves nothing (a cached answer stays a hit until notify())',
				(fDone) =>
				{
					let tmpDraft = null;
					Expect(H.fable.RetoldFacetingChangeIntake.stats().Source).to.equal('None');
					series(
						[
							T.call('GET', '/1.0/Facet/Describe', null, LEAD, {}, (pResponse) => { Expect(pResponse.Body.Changes).to.deep.equal({ Intake: 'None', Stream: '/1.0/Facet/Changes' }); }),
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); Expect(pResponse.Headers).to.not.have.property('x-retold-facet-seq'); }),
							(fNext) => { _Order = []; T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Archived' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(_Order).to.deep.equal([ 'host-update' ]); })(fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'invisible without a change source').to.equal('Hit'); }),
							(fNext) => { Expect(H.faceting.notify('Document', { Records: [ { IDDocument: tmpDraft.IDDocument, IDCustomer: 1 } ], ChangedColumns: [ 'Status' ] })).to.match(libRetoldFacetingUtil.SEQ_PATTERN); return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'notify() moves it').to.equal('Miss'); }),
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, LEAD, {}, null)(fNext); }
						], fDone);
				});

			test('installChangeCapture: the event is ingested at entry (the row is committed), then the earlier behavior (controller as this), then a behavior installed after; captured at entry; a second install wraps nothing twice',
				(fDone) =>
				{
					let tmpDraft = null;
					let tmpFrom = 0;
					series(
						[
							(fNext) =>
							{
								H.faceting.options.ChangeCapture.Intake = 'Interim';
								let tmpInstall = H.faceting.installChangeCapture();
								Expect(tmpInstall.Source).to.equal('Interim');
								Expect(tmpInstall.Entities).to.include.members([ 'Document', 'Project', 'FormType' ]);
								H.installBehavior('Document', 'Create-PostOperation', function (pRequest, pRequestState, fCallback) { _Order.push('after-create'); return fCallback(); });
								return fNext();
							},
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							(fNext) => { _Order = []; tmpFrom = _Bumps.length; return fNext(); },
							T.call('POST', '/1.0/Document', { Title: 'Wrapped, not replaced', Status: 'Draft', IDCustomer: 1 }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(_Order).to.deep.equal([ 'bump:Create', 'host-create', 'after-create' ]);
								}),
							(fNext) => { _Order = []; tmpFrom = _Bumps.length; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Final' }, LEAD, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(pResponse.Body.Status, 'the host decoration reaches the client').to.equal('Decorated');
										Expect(_Order).to.deep.equal([ 'bump:Update', 'host-update' ]);
										// Captured at entry (before the decoration): the diff is the real one.
										Expect(_Bumps.slice(tmpFrom).map(bumpFacts)).to.deep.equal([ { Entity: 'Document', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '1' ], Columns: [ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ] } ]);
									})(fNext);
							},
							(fNext) => { H.faceting.installChangeCapture(); H.faceting.installChangeCapture(); _Order = []; return fNext(); },
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(_Order).to.deep.equal([ 'bump:Update', 'host-update' ]); })(fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq()); })
						], fDone);
				});
		}
	);
};

/**
 * LabTrack: owner-qualified keys (internal-contracts §41.2 Personal, §46.4, §51.12).
 */
const labTrackSuite = () =>
{
	suite
	(
		'LabTrack, Cache.Enabled: owner-scoped isolation (PersonalScopes LabForm.OwnerIDUser)',
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = suiteTools(() => { return H; });
			let TECH = null;
			let COLLEAGUE = null;
			let OTHER = null;
			let _Bumps = [];
			const Q_LABFORM_STATUS = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ] });
			const Q_E3A = Object.freeze({ Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' } ] });

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Faceting: CACHE_ON },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							TECH = H.as('Tech');
							COLLEAGUE = H.as('Colleague');
							OTHER = H.as('OtherTech');
							H.fable.RetoldFacetingGenerations.subscribe('InvalidationTest', (pBump) => { _Bumps.push(pBump); });
							return fDone();
						});
				});
			suiteTeardown((fDone) => { closeStreams(null, () => { H.stop(fDone); }); });
			setup(() => { H.fable.RetoldFacetingResultCache.clear(); H.fable.RetoldFacetingReadYourWrites.clear(); });
			teardown(
				(fDone) =>
				{
					waitFor(() => { return H.fable.RetoldFacetingResultCache._Refreshing.size === 0; }, 5000, 'the background refreshes to finish',
						(pError) => { closeStreams(H, (pCloseError) => { return fDone(pError || pCloseError); }); });
				});

			test('a colleague\'s write bumps the tenant and the colleague\'s owner key only: my owner-scoped answer still hits and my stream hears nothing, but my TenantOnly fold (E3) misses; my own write misses mine and reaches my stream',
				(fDone) =>
				{
					let tmpTechStream = null;
					let tmpOtherStream = null;
					let tmpColleagueForm = null;
					let tmpTechForm = null;
					let tmpFrom = 0;
					let tmpDependsOn = null;
					series(
						[
							T.rows('LabForm', 'FBV~Status~EQ~Pending', 1, COLLEAGUE, (pRows) => { tmpColleagueForm = pRows[0]; Expect(tmpColleagueForm.OwnerIDUser).to.equal(COLLEAGUE.User); }),
							T.rows('LabForm', 'FBV~Status~EQ~Pending', 1, TECH, (pRows) => { tmpTechForm = pRows[0]; Expect(tmpTechForm.OwnerIDUser).to.equal(TECH.User); }),
							T.query('LabForm', Q_LABFORM_STATUS, TECH, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							T.query('MaterialIntakeRequirement', Q_E3A, TECH, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); tmpDependsOn = pResponse.Body.DependsOn; }),
							(fNext) => { Expect(tmpDependsOn).to.include('LabForm'); return fNext(); },
							T.openStream(TECH, (pStream) => { tmpTechStream = pStream; }),
							T.openStream(OTHER, (pStream) => { tmpOtherStream = pStream; }),
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpColleagueForm.IDLabForm, Status: 'Complete', CompletedDate: '2026-03-15 00:00:00' }, COLLEAGUE, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										let tmpBumps = _Bumps.slice(tmpFrom).map(bumpFacts);
										Expect(tmpBumps.length).to.equal(1);
										Expect(tmpBumps[0].TenantKeys).to.deep.equal([ '#any', '1', `1/${COLLEAGUE.User}` ]);
										Expect(tmpBumps[0].Columns).to.include.members([ '#cols', 'Status', 'CompletedDate' ]);
									})(fNext);
							},
							T.query('LabForm', Q_LABFORM_STATUS, TECH, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'my owner-scoped answer').to.equal('Hit'); }),
							T.query('MaterialIntakeRequirement', Q_E3A, TECH, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'my TenantOnly fold reads the tenant key').to.equal('Miss'); }),
							pause(SSE_OPTIONS.CoalesceMS * 5),
							(fNext) => { Expect(tmpTechStream.generations('LabForm').length, 'a colleague\'s private write is not signalled').to.equal(0); return fNext(); },
							// My own write: my owner key.
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpTechForm.IDLabForm, Status: 'Complete', CompletedDate: '2026-03-16 00:00:00' }, TECH, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(_Bumps.slice(tmpFrom).map(bumpFacts)[0].TenantKeys).to.deep.equal([ '#any', '1', `1/${TECH.User}` ]);
									})(fNext);
							},
							T.query('LabForm', Q_LABFORM_STATUS, TECH, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { waitFor(() => { return tmpTechStream.generations('LabForm').length > 0; }, 2000, 'my own LabForm write on my stream', fNext); },
							pause(SSE_OPTIONS.CoalesceMS * 3),
							(fNext) => { Expect(tmpOtherStream.generations().length, 'tenant 2 hears nothing').to.equal(0); return fNext(); },
							(fNext) => { T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpColleagueForm.IDLabForm, Status: 'Pending', CompletedDate: null }, COLLEAGUE, {}, null)(fNext); },
							(fNext) => { T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpTechForm.IDLabForm, Status: 'Pending', CompletedDate: null }, TECH, {}, null)(fNext); }
						], fDone);
				});

			test('an owner move bumps both owners (\'#row\': the owner column moves rows between owner scopes); a global lookup edit (LabFormType) is \'*\'',
				(fDone) =>
				{
					let tmpColleagueForm = null;
					let tmpFrom = 0;
					let tmpType = null;
					series(
						[
							T.rows('LabForm', null, 1, COLLEAGUE, (pRows) => { tmpColleagueForm = pRows[0]; }),
							T.rows('LabFormType', null, 1, TECH, (pRows) => { tmpType = pRows[0]; }),
							T.query('LabForm', Q_LABFORM_STATUS, TECH, {}, null),
							T.query('LabForm', Q_LABFORM_STATUS, COLLEAGUE, {}, null),
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpColleagueForm.IDLabForm, OwnerIDUser: TECH.User }, COLLEAGUE, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(_Bumps.slice(tmpFrom).map(bumpFacts)).to.deep.equal([ { Entity: 'LabForm', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '1', `1/${TECH.User}`, `1/${COLLEAGUE.User}` ].sort(), Columns: [ '#cols', '#row', 'UpdateDate', 'UpdatingIDUser' ] } ]);
									})(fNext);
							},
							T.query('LabForm', Q_LABFORM_STATUS, TECH, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'the new owner').to.equal('Miss'); }),
							T.query('LabForm', Q_LABFORM_STATUS, COLLEAGUE, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'the old owner').to.equal('Miss'); }),
							(fNext) => { T.call('PUT', '/1.0/LabForm', { IDLabForm: tmpColleagueForm.IDLabForm, OwnerIDUser: COLLEAGUE.User }, TECH, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })(fNext); },
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							(fNext) =>
							{
								T.call('PUT', '/1.0/LabFormType', { IDLabFormType: tmpType.IDLabFormType, Discipline: 'Edited' }, TECH, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(_Bumps.slice(tmpFrom).map(bumpFacts)).to.deep.equal([ { Entity: 'LabFormType', Operation: 'Update', Source: 'Interim', TenantKeys: [ '#any', '*' ], Columns: [ '#cols', 'Discipline' ] } ]);
									})(fNext);
							},
							(fNext) => { T.call('PUT', '/1.0/LabFormType', { IDLabFormType: tmpType.IDLabFormType, Discipline: tmpType.Discipline }, TECH, {}, null)(fNext); }
						], fDone);
				});
		}
	);
};

/**
 * Bookstore-Tenant: a model reload (internal-contracts §44.10).
 */
const reloadSuite = () =>
{
	suite
	(
		'Bookstore-Tenant, Cache.Enabled: a model reload clears the cache, tells open streams and keeps one event per write',
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = suiteTools(() => { return H; });
			let ONE = { Tenant: 1, User: 5 };
			let _Bumps = [];
			const Q_REVIEW_RATING = Object.freeze({ Facets: [ { Key: 'Rating', Facet: 'Review.Rating' } ] });

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant', Faceting: CACHE_ON },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							H.fable.RetoldFacetingGenerations.subscribe('InvalidationTest', (pBump) => { _Bumps.push(pBump); });
							return fDone();
						});
				});
			suiteTeardown((fDone) => { closeStreams(null, () => { H.stop(fDone); }); });

			test('reload: Entries 0, a \'model\' event on the open stream, the next answer a miss; a write afterwards still yields exactly one bump',
				(fDone) =>
				{
					let tmpStream = null;
					let tmpFrom = 0;
					let tmpWrappers = null;
					series(
						[
							T.query('Review', Q_REVIEW_RATING, ONE, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							T.query('Review', Q_REVIEW_RATING, ONE, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							T.openStream(ONE, (pStream) => { tmpStream = pStream; }),
							(fNext) =>
							{
								let tmpController = H.faceting.Host.getRouteBoundController('Review');
								tmpWrappers = Object.keys(libChangeIntakeInterim.SLOTS).map((pSlot) => { return tmpController.BehaviorInjection._BehaviorFunctions[pSlot]; });
								Expect(H.fable.RetoldFacetingResultCache.stats().Entries).to.equal(1);
								H.rds.loadModel('Bookstore', JSON.parse(JSON.stringify(H.model)), 'SQLite', (pReloadError) => { return fNext(pReloadError); });
							},
							(fNext) =>
							{
								Expect(H.fable.RetoldFacetingResultCache.stats().Entries, 'cleared by the reload').to.equal(0);
								let tmpController = H.faceting.Host.getRouteBoundController('Review');
								Object.keys(libChangeIntakeInterim.SLOTS).forEach((pSlot, pIndex) => { Expect(tmpController.BehaviorInjection._BehaviorFunctions[pSlot], pSlot).to.equal(tmpWrappers[pIndex]); });
								waitFor(() => { return tmpStream.events('model').length > 0; }, 2000, 'the model event', fNext);
							},
							(fNext) => { Expect(tmpStream.events('model')[0].Data.ModelVersion).to.equal(H.fable.RetoldFacetingCatalog.modelVersion()); return fNext(); },
							T.query('Review', Q_REVIEW_RATING, ONE, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss'); }),
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Review', { IDReview: 1, Text: 'After the reload' }, ONE, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(_Bumps.length - tmpFrom, 'one bump: nothing wrapped twice').to.equal(1);
								}),
							T.query('Review', Q_REVIEW_RATING, ONE, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache'], 'Text is not read by a Rating facet').to.equal('Hit'); })
						], fDone);
				});
		}
	);
};

/**
 * Cache off (the default, internal-contracts §51.1): M2 behavior.
 */
const cacheOffSuite = () =>
{
	suite
	(
		'ProjectTrack, Cache off (the default): M2 behavior; the intake, generations and SSE still run',
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = suiteTools(() => { return H; });
			let LEAD = null;

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Cache: { ExposeStatus: true }, Freshness: EXPOSED.Freshness, SSE: SSE_OPTIONS, ChangeCapture: { NotifySettleMS: 0 } } },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							LEAD = H.as('Lead');
							return fDone();
						});
				});
			suiteTeardown((fDone) => { closeStreams(null, () => { H.stop(fDone); }); });

			test('Off: no lookups, the digest Version (stable while the representation is, new when it changes), a 304 only after execution, the envelope differs from M2 only by DependsOn',
				(fDone) =>
				{
					let tmpFirst = null;
					let tmpDraft = null;
					let tmpSpy = null;
					let tmpTick = 0;
					let tmpStream = null;
					series(
						[
							T.call('GET', '/1.0/Facet/Describe', null, LEAD, {}, (pResponse) => { Expect(pResponse.Body.Cache).to.deep.equal({ Enabled: false }); Expect(pResponse.Body.Changes).to.deep.equal({ Intake: 'Interim', Stream: '/1.0/Facet/Changes' }); }),
							T.rows('Document', 'FBV~Status~EQ~Draft', 1, LEAD, (pRows) => { tmpDraft = pRows[0]; }),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {},
								(pResponse) =>
								{
									tmpFirst = pResponse;
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Off');
									Expect(pResponse.Headers['x-retold-facet-seq']).to.equal(H.fable.RetoldFacetingChangeIntake.currentSeq());
									Expect(Object.keys(pResponse.Body)).to.deep.equal(M2_ENVELOPE_KEYS.concat([ 'DependsOn' ]));
									Expect(pResponse.Body).to.include({ Cached: false, Stale: false, LagMS: 0, Exact: true });
									Expect(pResponse.Body.DependsOn).to.deep.equal([ 'Document' ]);
								}),
							T.query('Document', withFreshness(Q_DOCUMENT_STATUS, BOUNDED), LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Off');
									Expect(pResponse.Headers['x-retold-facet-freshness']).to.equal('Bounded');
									Expect(pResponse.Headers.etag, 'the digest is stable').to.equal(tmpFirst.Headers.etag);
									Expect(pResponse.Body.Cached).to.equal(false);
								}),
							T.openStream(LEAD, (pStream) => { tmpStream = pStream; }),
							(fNext) => { tmpTick = H.fable.RetoldFacetingGenerations.GlobalTick; return fNext(); },
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Title: 'Unread' }, LEAD, {}, null)(fNext); },
							(fNext) => { Expect(H.fable.RetoldFacetingGenerations.GlobalTick, 'generations still move').to.equal(tmpTick + 1); waitFor(() => { return tmpStream.generations('Document').length > 0; }, 2000, 'the change stream with the cache off', fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers.etag, 'the same representation, the same digest').to.equal(tmpFirst.Headers.etag); }),
							(fNext) => { tmpSpy = spyStatements(H); return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, () => { return { 'if-none-match': tmpFirst.Headers.etag }; },
								(pResponse) =>
								{
									tmpSpy.restore();
									Expect(pResponse.Status).to.equal(304);
									Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Off');
									Expect(tmpSpy.Count, 'M2: the 304 comes after execution').to.be.greaterThan(0);
								}),
							T.inProcess('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': '*' }, {},
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError).to.not.exist;
									Expect(pEnvelope).to.be.an('object');
									Expect(pMeta).to.not.have.property('NotModified');
									Expect(pMeta.Statements).to.be.greaterThan(0);
									Expect(pMeta.Cache).to.include({ Status: 'Off', Key: null, GenVector: null });
								}),
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Final' }, LEAD, {}, null)(fNext); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers.etag, 'a new representation, a new digest').to.not.equal(tmpFirst.Headers.etag); }),
							(fNext) =>
							{
								let tmpStats = H.fable.RetoldFacetingResultCache.stats();
								CACHE_COUNTERS.forEach((pName) => { Expect(tmpStats[pName], pName).to.equal(0); });
								Expect(tmpStats.Bypass).to.deep.equal({});
								Expect(tmpStats.Entries).to.equal(0);
								return fNext();
							},
							(fNext) => { T.call('PUT', '/1.0/Document', { IDDocument: tmpDraft.IDDocument, Status: 'Draft' }, LEAD, {}, null)(fNext); }
						], (pError) => { if (tmpSpy) { tmpSpy.restore(); } return fDone(pError); });
				});
		}
	);
};

/**
 * Shutdown (internal-contracts §44.10).
 */
const shutdownSuite = () =>
{
	suite
	(
		'shutdown: harness.stop completes with streams open',
		function ()
		{
			this.timeout(60000);

			test('every open stream gets closed { Reason: \'Shutdown\' } and ends; the server closes; no SSE timer, settle timer or refresh survives',
				(fDone) =>
				{
					let H = null;
					let tmpStreams = [];
					let tmpShutdowns = 0;
					H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Cache: { Enabled: true, ExposeStatus: true }, Freshness: EXPOSED.Freshness, SSE: SSE_OPTIONS, ChangeCapture: { NotifySettleMS: 60000 } } },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							let fShutdown = H.faceting.shutdown.bind(H.faceting);
							H.faceting.shutdown = (fCallback) => { tmpShutdowns++; return fShutdown(fCallback); };
							openStream(H, H.as('Lead'),
								(pLeadError, pLead) =>
								{
									if (pLeadError)
									{
										return fDone(pLeadError);
									}
									tmpStreams.push(pLead);
									openStream(H, H.as('OtherLead'),
										(pOtherError, pOther) =>
										{
											if (pOtherError)
											{
												return fDone(pOtherError);
											}
											tmpStreams.push(pOther);
											// A notify arms a settle timer (60 s): shutdown must clear it.
											Expect(H.faceting.notify('Document', { Tenants: [ 1 ] })).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
											Expect(H.fable.RetoldFacetingChangeIntake._SettleTimers.size).to.equal(1);
											Expect(H.fable.RetoldFacetingSSE.stats().Connections).to.equal(2);
											let tmpStart = Date.now();
											H.stop(
												() =>
												{
													try
													{
														Expect(Date.now() - tmpStart, 'stop never waits on an open stream').to.be.below(3000);
														Expect(tmpShutdowns).to.equal(1);
														Expect(H.fable.RetoldFacetingSSE.stats().Connections).to.equal(0);
														Expect(H.fable.RetoldFacetingChangeIntake._SettleTimers.size).to.equal(0);
														Expect(H.fable.RetoldFacetingResultCache._Refreshing.size).to.equal(0);
														// Idempotent.
														H.faceting.shutdown();
													}
													catch (pCheckError)
													{
														return fDone(pCheckError);
													}
													// The socket-destroy fallbacks (unref'd) clear as each socket closes.
													waitFor(() => { return tmpStreams.every((pStream) => { return pStream.Ended; }) && (H.fable.RetoldFacetingSSE.timerCount() === 0); }, 2000, 'the client streams to end and every SSE timer to clear',
														(pWaitError) =>
														{
															if (pWaitError)
															{
																return fDone(pWaitError);
															}
															try
															{
																tmpStreams.forEach(
																	(pStream) =>
																	{
																		let tmpClosed = pStream.events('closed');
																		Expect(tmpClosed.length).to.equal(1);
																		Expect(tmpClosed[0].Data).to.deep.equal({ Reason: 'Shutdown' });
																	});
															}
															catch (pCheckError)
															{
																return fDone(pCheckError);
															}
															return fDone();
														});
												});
										});
								});
						});
				});
		}
	);
};

suite
(
	'Facet-Invalidation',
	() =>
	{
		suite
		(
			'wiring (no server)',
			() =>
			{
				test('the M4 services are registered sub-services, in the contracted order; the service exports the cache statuses and the shutdown marker',
					() =>
					{
						let tmpNames = libRetoldFacetingService.SUB_SERVICES.map((pEntry) => { return pEntry[0]; });
						let tmpM4 = [ 'RetoldFacetingCacheKey', 'RetoldFacetingGenerations', 'RetoldFacetingResultCache', 'RetoldFacetingChangeIntake', 'RetoldFacetingReadYourWrites' ];
						Expect(tmpNames.slice(tmpNames.indexOf('RetoldFacetingLabelResolver') + 1, tmpNames.indexOf('RetoldFacetingLabelResolver') + 6)).to.deep.equal(tmpM4);
						Expect(tmpNames.slice(-3)).to.deep.equal([ 'RetoldFacetingRouter', 'RetoldFacetingRoutes', 'RetoldFacetingSSE' ]);
						Expect(libRetoldFacetingService.CACHE_STATUSES).to.deep.equal([ 'Off', 'Bypass', 'Miss', 'Hit', 'Stale', 'NotModified', 'Refresh' ]);
						Expect(libRetoldFacetingService.SHUTDOWN_MARKER).to.equal(Symbol.for('RetoldFaceting.Shutdown'));
						[ 'notify', 'notifyChanged', 'notifyByFilter', 'shutdown', 'installChangeCapture', 'installShutdownHook', 'stageFreshness', 'stageCache', 'stageStore' ].forEach(
							(pMethod) =>
							{
								Expect(libRetoldFacetingService.prototype[pMethod], pMethod).to.be.a('function');
							});
						// One Seq grammar: the server helper re-exports the pure contract's.
						Expect(libRetoldFacetingUtil.SEQ_PATTERN).to.equal(require('../source/contract/Facet-Contract-Request.js').SEQ_PATTERN);
					});
			}
		);

		PROVIDERS.forEach((pProvider) => { projectTrackSuite(pProvider); });
		preexistingSuite();
		labTrackSuite();
		reloadSuite();
		cacheOffSuite();
		shutdownSuite();
	}
);
