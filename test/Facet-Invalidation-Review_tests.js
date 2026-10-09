/**
 * Facet-Invalidation-Review: the O7 obligations of the M4 review fixes (internal-contracts §51.46–§51.65),
 * end to end over HTTP with Cache.Enabled, on BOTH meadow-endpoints versions the write paths must
 * cover (the umbrella's installed 4.0.21 and the monorepo's 4.1.x; the latter skips when the checkout
 * is absent):
 *
 *   - writes that COMMIT but never reach a PostOperation (a soft delete through PUT, a tenant move
 *     under an Update-QueryConfiguration filter, a Create-QueryConfiguration filter the new row fails,
 *     a bulk update's per-record failure) still bump: the conservative event (both tenants, '#all');
 *   - a PreOperation behavior that mutates the shared Record object cannot hide the change (the
 *     pre-image snapshot);
 *   - the ordinary single-slot setBehavior after attach never removes the intake (the dispatcher is
 *     wrapped, not a slot); a replaced dispatcher is wrapped again and its entity invalidated before
 *     any lookup; a DepSet entity no change source sees is never cached ('NoChangeSource') unless
 *     declared notify-managed;
 *   - the bump happens at PostOperation ENTRY, before a slow host behavior calls back;
 *
 * and once (installed version):
 *
 *   - scope drift between the cache probe and the execution: Bypass 'ScopeChanged', never stored,
 *     never shared with a single-flight joiner (the joiner computes its own answer);
 *   - a MinSeq this process cannot prove applied: no lookup, no 304, computed and stored;
 *   - a model reload between newContext and the Cache stage: Bypass 'ModelReload';
 *   - single-flight joiners never share a leader with another timeout;
 *   - the defaults on a policy host: no X-Retold-Facet-Seq / -Cache / -Freshness, and a hit computed
 *     by another principal says Cached: false; without a policy the Seq header is sent and the change
 *     stream is not mounted unless SSE.Enabled is true.
 *
 * Owner: wiring (M4 review).  Registry port: 19137.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');

const PORT = 19137;

// Cache on, the cache status and the Seq exposed (their defaults are tested in 'defaults' below).
const CACHE_ON = Object.freeze(
	{
		Cache: { Enabled: true, ExposeStatus: true },
		Freshness: { SeqHeader: true },
		SSE: { CoalesceMS: 15, HeartbeatMS: 60000, GlobalTickMS: 40, IncludeSeq: true },
		ChangeCapture: { NotifySettleMS: 0 }
	});

const Q_DOCUMENT_STATUS = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Document.Status' } ] });
const Q_PROJECT_STATUS = Object.freeze({ Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] });
const Q_PROJECT_CLIENT = Object.freeze({ Facets: [ { Key: 'Client', Facet: 'Project.IDClient', Top: 50 } ] });

const VERSIONS = [ 'Installed', 'Monorepo' ];

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
 * The { Key: Count } of one facet.
 *
 * @param {Record<string, any>} pEnvelope
 * @param {string} pFacet
 * @return {Record<string, number>}
 */
const counts = (pEnvelope, pFacet) =>
{
	let tmpCounts = {};
	let tmpFacet = (pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets[pFacet] : null;
	(tmpFacet && Array.isArray(tmpFacet.Buckets) ? tmpFacet.Buckets : []).forEach((pBucket) => { tmpCounts[String(pBucket.Key)] = pBucket.Count; });
	return tmpCounts;
};

/**
 * The tools of one suite, bound to its (late-started) harness.
 *
 * @param {() => Record<string, any>} fHarness
 * @return {Record<string, Function>}
 */
const tools = (fHarness) =>
{
	let T = {};
	// An HTTP step; fCheck(pResponse) may throw.
	T.call = (pMethod, pPath, pBody, pWho, pHeaders, fCheck) =>
	{
		return (fNext) =>
		{
			fHarness().request(pMethod, (typeof(pPath) === 'function') ? pPath() : pPath, (typeof(pBody) === 'function') ? pBody() : pBody, Object.assign({ Headers: pHeaders || {} }, pWho || {}),
				(pError, pResponse) =>
				{
					if (pError)
					{
						return fNext(pError);
					}
					try
					{
						if (fCheck)
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
	T.query = (pEntity, pBody, pWho, pHeaders, fCheck) =>
	{
		return T.call('POST', `/1.0/Facet/${pEntity}/Query`, pBody, pWho, pHeaders, fCheck);
	};
	// An in-process step through queryInternal (pMeta visible).
	T.inProcess = (pEntity, pBody, pWho, pInternal, fCheck) =>
	{
		return (fNext) =>
		{
			let tmpRequest = libHarness.syntheticRequest(pEntity, pWho, pBody);
			fHarness().faceting.queryInternal(pEntity, pBody, tmpRequest, pInternal || {},
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
	// A Query whose counts must equal the Reference oracle's (the truth after the write).
	T.matchesReference = (pEntity, pBody, pWho, pFacet, pExpectCache, fUse) =>
	{
		return (fNext) =>
		{
			let tmpHarness = fHarness();
			tmpHarness.facetQuery(pEntity, pBody, pWho,
				(pError, pResponse) =>
				{
					if (pError)
					{
						return fNext(pError);
					}
					tmpHarness.reference(pEntity, pBody, pWho,
						(pReferenceError, pReference) =>
						{
							setImmediate(
								() =>
								{
									try
									{
										Expect(pReferenceError).to.not.exist;
										Expect(pResponse.Status).to.equal(200);
										if (pExpectCache)
										{
											Expect(pResponse.Headers['x-retold-facet-cache']).to.equal(pExpectCache);
										}
										Expect(counts(pResponse.Body, pFacet), 'the cached answer equals the truth').to.deep.equal(counts(pReference, pFacet));
										if (fUse)
										{
											fUse(pResponse, pReference);
										}
									}
									catch (pCheckError)
									{
										return fNext(pCheckError);
									}
									return fNext();
								});
						});
				});
		};
	};
	// A SQL helper (SQLite only: these suites run on SQLite).
	T.row = (pSQL) =>
	{
		return fHarness().db.prepare(pSQL).get();
	};
	return T;
};

/**
 * The write-path suite on one meadow-endpoints version.
 *
 * @param {string} pVersion - 'Installed' | 'Monorepo'
 */
const writePathSuite = (pVersion) =>
{
	let tmpModule = libHarness.meadowEndpointsModule(pVersion);
	(tmpModule.Available ? suite : suite.skip)
	(
		`write paths that never reach a PostOperation, mutated pre-images and replaced slots (meadow-endpoints ${pVersion}${tmpModule.Version ? ` ${tmpModule.Version}` : ''})${tmpModule.Available ? '' : ` (skipped: ${tmpModule.Reason})`}`,
		function ()
		{
			this.timeout(60000);

			let H = null;
			let T = tools(() => { return H; });
			let LEAD = null;
			let OTHER = null;
			let _Bumps = [];
			// Behavior switches (installed once, off by default).
			let _Flags = { UpdateTenancy: false, CreateImpossible: false, MergeRecord: false, SlowPostMS: 0 };

			suiteSetup(
				(fDone) =>
				{
					H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: CACHE_ON, MeadowEndpoints: pVersion },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							LEAD = H.as('Lead');
							OTHER = H.as('OtherLead');
							H.fable.RetoldFacetingGenerations.subscribe('ReviewTest', (pBump) => { _Bumps.push(pBump); });
							// A tenancy filter on the update query (the row must be the session's tenant's).
							H.installBehavior('Document', 'Update-QueryConfiguration',
								function (pRequest, pRequestState, fCallback)
								{
									if (_Flags.UpdateTenancy)
									{
										pRequestState.Query.addFilter('IDCustomer', pRequestState.SessionData.CustomerID);
									}
									return fCallback();
								});
							// A create filter the new row can never satisfy (the re-read fails after the INSERT).
							H.installBehavior('Document', 'Create-QueryConfiguration',
								function (pRequest, pRequestState, fCallback)
								{
									if (_Flags.CreateImpossible)
									{
										pRequestState.Query.addFilter('IDCustomer', 987654);
									}
									return fCallback();
								});
							// A validation-style PreOperation that merges the submitted record into the shared Record.
							H.installBehavior('Document', 'Update-PreOperation',
								function (pRequest, pRequestState, fCallback)
								{
									if (_Flags.MergeRecord)
									{
										Object.assign(pRequestState.Record, pRequestState.RecordToModify);
									}
									return fCallback();
								});
							return fDone();
						});
				});
			suiteTeardown((fDone) => { return H ? H.stop(fDone) : fDone(); });
			setup(() => { _Flags.UpdateTenancy = false; _Flags.CreateImpossible = false; _Flags.MergeRecord = false; _Flags.SlowPostMS = 0; });

			test('PUT { Deleted: 1 } soft-deletes the row and answers 500 (meadow\'s re-read cannot see it): the conservative event still bumps, and the Exact answer is the truth',
				(fDone) =>
				{
					let tmpID = null;
					let tmpFrom = 0;
					series(
						[
							(fNext) => { tmpID = T.row('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND Status = \'Draft\' ORDER BY IDDocument LIMIT 1').IDDocument; return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, Deleted: 1 }; }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(500);
									Expect(T.row(`SELECT Deleted FROM Document WHERE IDDocument = ${tmpID}`).Deleted, 'the write committed').to.equal(1);
									let tmpBumps = _Bumps.slice(tmpFrom).filter((pBump) => { return pBump.Entity === 'Document'; });
									Expect(tmpBumps.map((pBump) => { return [ pBump.Operation, pBump.TenantKeys, pBump.Columns ]; })).to.deep.equal([ [ 'Update', [ '#any', '1' ], [ '#all' ] ] ]);
									Expect(H.fable.RetoldFacetingChangeIntake.stats().UnconfirmedWrites).to.be.at.least(1);
								}),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss'),
							T.call('GET', () => { return `/1.0/Document/Undelete/${tmpID}`; }, null, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); }),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss')
						], fDone);
				});

			test('a tenant move under an Update-QueryConfiguration tenancy filter commits and answers 500: both tenants are bumped, both tenants\' answers are the truth',
				(fDone) =>
				{
					let tmpID = null;
					let tmpFrom = 0;
					series(
						[
							(fNext) => { tmpID = T.row('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDDocument LIMIT 1 OFFSET 3').IDDocument; return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, OTHER, {}, null),
							(fNext) => { _Flags.UpdateTenancy = true; tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, IDCustomer: 2 }; }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(500);
									Expect(T.row(`SELECT IDCustomer FROM Document WHERE IDDocument = ${tmpID}`).IDCustomer, 'the move committed').to.equal(2);
									let tmpBump = _Bumps.slice(tmpFrom).find((pCandidate) => { return pCandidate.Entity === 'Document'; });
									Expect(tmpBump.TenantKeys).to.deep.equal([ '#any', '1', '2' ]);
									Expect(tmpBump.Columns).to.deep.equal([ '#all' ]);
								}),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss'),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, OTHER, 'Status', 'Miss'),
							// Back to tenant 1 the same way (the filter is now tenant 2's): 500 again, both bumped again.
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, IDCustomer: 1 }; }, OTHER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(500); }),
							(fNext) => { _Flags.UpdateTenancy = false; return fNext(); },
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss'),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, OTHER, 'Status', 'Miss')
						], fDone);
				});

			test('a Create-QueryConfiguration filter the new row cannot satisfy: the INSERT commits, the answer is 500, the Create still bumps \'#row\' of the row\'s tenant',
				(fDone) =>
				{
					let tmpFrom = 0;
					let tmpBefore = 0;
					series(
						[
							(fNext) => { tmpBefore = T.row('SELECT COUNT(*) AS N FROM Document').N; return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							(fNext) => { _Flags.CreateImpossible = true; tmpFrom = _Bumps.length; return fNext(); },
							T.call('POST', '/1.0/Document', { Title: 'Unreadable after create', Status: 'Draft', IDCustomer: 1 }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(500);
									Expect(T.row('SELECT COUNT(*) AS N FROM Document').N, 'the INSERT committed').to.equal(tmpBefore + 1);
									let tmpBump = _Bumps.slice(tmpFrom).find((pCandidate) => { return pCandidate.Entity === 'Document'; });
									Expect([ tmpBump.Operation, tmpBump.TenantKeys, tmpBump.Columns ]).to.deep.equal([ 'Create', [ '#any', '1' ], [ '#row' ] ]);
								}),
							(fNext) => { _Flags.CreateImpossible = false; return fNext(); },
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss')
						], fDone);
				});

			test('a bulk update with one record whose re-read fails: one conservative event for it, one precise event for the other, never two for one record',
				(fDone) =>
				{
					let tmpRows = null;
					let tmpFrom = 0;
					series(
						[
							(fNext) => { tmpRows = H.db.prepare('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDDocument LIMIT 2 OFFSET 7').all(); tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Documents', () => { return [ { IDDocument: tmpRows[0].IDDocument, Deleted: 1 }, { IDDocument: tmpRows[1].IDDocument, Title: 'Bulk title' } ]; }, LEAD, {},
								() =>
								{
									let tmpBumps = _Bumps.slice(tmpFrom).filter((pBump) => { return pBump.Entity === 'Document'; });
									Expect(tmpBumps.map((pBump) => { return pBump.Columns; })).to.deep.equal([ [ '#all' ], [ '#cols', 'Title', 'UpdateDate', 'UpdatingIDUser' ] ]);
								}),
							T.call('GET', () => { return `/1.0/Document/Undelete/${tmpRows[0].IDDocument}`; }, null, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); }),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', null)
						], fDone);
				});

			test('an Update-PreOperation that merges the submitted record into the shared Record cannot hide the change: Status is bumped, the Exact answer misses and is the truth',
				(fDone) =>
				{
					let tmpID = null;
					let tmpFrom = 0;
					series(
						[
							(fNext) => { tmpID = T.row('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND Status = \'Draft\' ORDER BY IDDocument LIMIT 1 OFFSET 2').IDDocument; return fNext(); },
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Hit'); }),
							(fNext) => { _Flags.MergeRecord = true; tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, Status: 'Final' }; }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									let tmpBump = _Bumps.slice(tmpFrom).find((pCandidate) => { return pCandidate.Entity === 'Document'; });
									Expect(tmpBump.Columns).to.include('Status');
									Expect(tmpBump.TenantKeys).to.deep.equal([ '#any', '1' ]);
								}),
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss'),
							T.call('PUT', '/1.0/Document', () => { return { IDDocument: tmpID, Status: 'Draft' }; }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })
						], fDone);
				});

			test('a plain setBehavior on a PostOperation slot after attach (the documented single-slot API) replaces the host\'s slot, never the intake: writes still bump; the install still covers the entity',
				(fDone) =>
				{
					let tmpID = null;
					let tmpRan = 0;
					let tmpFrom = 0;
					let tmpController = H.faceting.Host.getRouteBoundController('Project');
					series(
						[
							(fNext) =>
							{
								tmpController.BehaviorInjection.setBehavior('Update-PostOperation', function (pRequest, pRequestState, fCallback) { tmpRan++; return fCallback(); });
								let tmpInstall = H.faceting.installChangeCapture();
								Expect(tmpInstall.Entities).to.include('Project');
								Expect(H.fable.RetoldFacetingChangeIntake.covers('Project')).to.equal(true);
								tmpID = T.row('SELECT IDProject FROM Project WHERE IDCustomer = 1 AND Deleted = 0 AND Status = \'Active\' ORDER BY IDProject LIMIT 1').IDProject;
								return fNext();
							},
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, null),
							(fNext) => { tmpFrom = _Bumps.length; return fNext(); },
							T.call('PUT', '/1.0/Project', () => { return { IDProject: tmpID, Status: 'OnHold' }; }, LEAD, {},
								(pResponse) =>
								{
									Expect(pResponse.Status).to.equal(200);
									Expect(tmpRan).to.equal(1);
									Expect(_Bumps.slice(tmpFrom).some((pBump) => { return (pBump.Entity === 'Project') && (pBump.Columns.indexOf('Status') >= 0); })).to.equal(true);
								}),
							T.matchesReference('Project', Q_PROJECT_STATUS, LEAD, 'Status', 'Miss'),
							T.call('PUT', '/1.0/Project', () => { return { IDProject: tmpID, Status: 'Active' }; }, LEAD, {}, null),
							(fNext) => { delete tmpController.BehaviorInjection._BehaviorFunctions['Update-PostOperation']; return fNext(); }
						], fDone);
				});

			test('a replaced dispatcher is wrapped again at the next cacheable request and its entity invalidated before the lookup (no answer from the gap survives); writes are captured again',
				(fDone) =>
				{
					let tmpID = null;
					let tmpInjection = H.faceting.Host.getRouteBoundController('Project').BehaviorInjection;
					let tmpRewraps = 0;
					series(
						[
							(fNext) => { tmpID = T.row('SELECT IDProject FROM Project WHERE IDCustomer = 1 AND Deleted = 0 AND Status = \'Active\' ORDER BY IDProject LIMIT 1 OFFSET 1').IDProject; return fNext(); },
							T.query('Project', Q_PROJECT_STATUS, LEAD, {}, null),
							(fNext) =>
							{
								// A host (or an APM tool) replaces the dispatcher with one that skips every wrapper.
								let fPrototype = Object.getPrototypeOf(tmpInjection).runBehavior;
								Object.defineProperty(tmpInjection, 'runBehavior', { value: function (...pArguments) { return fPrototype.apply(this, pArguments); }, configurable: true, writable: true, enumerable: false });
								tmpRewraps = H.fable.RetoldFacetingChangeIntake.stats().Rewraps;
								return fNext();
							},
							// A write in the gap is invisible …
							T.call('PUT', '/1.0/Project', () => { return { IDProject: tmpID, Status: 'Done' }; }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); }),
							// … but the next cacheable request wraps the dispatcher again and invalidates Project first.
							T.matchesReference('Project', Q_PROJECT_STATUS, LEAD, 'Status', 'Miss',
								() => { Expect(H.fable.RetoldFacetingChangeIntake.stats().Rewraps).to.equal(tmpRewraps + 1); }),
							T.call('PUT', '/1.0/Project', () => { return { IDProject: tmpID, Status: 'Active' }; }, LEAD, {}, null),
							T.matchesReference('Project', Q_PROJECT_STATUS, LEAD, 'Status', 'Miss')
						], fDone);
				});

			test('a DepSet entity no change source sees is never cached (\'NoChangeSource\') unless ChangeCapture.NotifyManaged names it; an entity without a route-bound controller is not covered',
				(fDone) =>
				{
					let tmpIntake = H.fable.RetoldFacetingChangeIntake;
					let tmpInterim = tmpIntake.Interim;
					let fEnsure = tmpInterim.ensureCovered;
					let tmpCapture = H.faceting.options.ChangeCapture;
					let fRestore = () => { tmpInterim.ensureCovered = fEnsure; tmpCapture.NotifyManaged = []; };
					series(
						[
							(fNext) =>
							{
								// An entity without a route-bound controller is not covered by the interim intake.
								let tmpHost = H.faceting.Host;
								let fOriginal = tmpHost.getRouteBoundController;
								tmpHost.getRouteBoundController = function (pEntity) { return (pEntity === 'Client') ? null : fOriginal.call(this, pEntity); };
								let tmpCovered = tmpIntake.covers('Client');
								tmpHost.getRouteBoundController = fOriginal;
								Expect(tmpCovered).to.equal(false);
								// Client (the label target, readable) whose writes nothing sees: e.g. a controller the
								// intake cannot wrap.
								tmpInterim.ensureCovered = function (pEntity) { return (pEntity === 'Client') ? false : fEnsure.call(this, pEntity); };
								return fNext();
							},
							T.inProcess('Project', Q_PROJECT_CLIENT, LEAD, {},
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError).to.not.exist;
									Expect(pEnvelope.DependsOn).to.include('Client');
									Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'NoChangeSource' });
								}),
							(fNext) => { tmpCapture.NotifyManaged = [ 'Client' ]; return fNext(); },
							T.inProcess('Project', Q_PROJECT_CLIENT, LEAD, {},
								(pError, pEnvelope, pMeta) =>
								{
									Expect(pError).to.not.exist;
									Expect(pMeta.Cache.Status).to.not.equal('Bypass');
								})
						],
						(pError) =>
						{
							fRestore();
							return fDone(pError);
						});
				});

			test('the bump happens at PostOperation ENTRY: while a slow host behavior has not called back, a query already misses and sees the committed row',
				(fDone) =>
				{
					let tmpID = T.row('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND Status = \'Draft\' ORDER BY IDDocument LIMIT 1 OFFSET 4').IDDocument;
					let tmpController = H.faceting.Host.getRouteBoundController('Document');
					let tmpHeld = null;
					tmpController.BehaviorInjection.setBehavior('Update-PostOperation', function (pRequest, pRequestState, fCallback) { tmpHeld = fCallback; });
					series(
						[
							T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
							(fNext) =>
							{
								H.request('PUT', '/1.0/Document', { IDDocument: tmpID, Status: 'Archived' }, LEAD, () => {});
								let fWait = () => { if (tmpHeld) { return fNext(); } setTimeout(fWait, 5); };
								fWait();
							},
							T.matchesReference('Document', Q_DOCUMENT_STATUS, LEAD, 'Status', 'Miss'),
							(fNext) =>
							{
								delete tmpController.BehaviorInjection._BehaviorFunctions['Update-PostOperation'];
								tmpHeld();
								setTimeout(fNext, 20);
							},
							T.call('PUT', '/1.0/Document', { IDDocument: tmpID, Status: 'Draft' }, LEAD, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })
						], fDone);
				});
		}
	);
};

suite
(
	'Facet-Invalidation-Review',
	() =>
	{
		VERSIONS.forEach(writePathSuite);

		suite
		(
			'scope drift, MinSeq, model reloads, flights (ProjectTrack, installed meadow-endpoints)',
			function ()
			{
				this.timeout(60000);

				let H = null;
				let T = tools(() => { return H; });
				let LEAD = null;
				let MEMBER = null;
				// The per-user project list a Document Reads behavior appends (IDProject IN …), and the switches.
				let _Lists = { 1: [ 1 ], 2: [ 1 ] };
				let _Flags = { Drift: false, DriftUser: 1, SlowMS: 0 };
				let _Calls = new WeakMap();

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: CACHE_ON },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								LEAD = H.as('Lead');
								MEMBER = H.as('Member');
								// A membership-style scope read per request: the list may change between the cache probe
								// (the first capture of the request) and the execution (later captures).
								H.installBehavior('Document', 'Reads-QueryConfiguration',
									function (pRequest, pRequestState, fCallback)
									{
										let tmpUser = pRequestState.SessionData ? pRequestState.SessionData.UserID : 0;
										let tmpCall = (_Calls.get(pRequest) || 0) + 1;
										_Calls.set(pRequest, tmpCall);
										let tmpList = (_Lists[tmpUser] || [ 0 ]).slice();
										if (_Flags.Drift && (tmpUser === _Flags.DriftUser) && (tmpCall > 1))
										{
											// A membership grant lands between the probe and the execution.
											tmpList.push(2);
										}
										pRequestState.Query.addFilter('IDProject', tmpList, 'IN');
										if (_Flags.SlowMS > 0)
										{
											return setTimeout(() => { fCallback(); }, _Flags.SlowMS);
										}
										return fCallback();
									});
								return fDone();
							});
					});
				suiteTeardown((fDone) => { return H ? H.stop(fDone) : fDone(); });
				setup(() => { H.fable.RetoldFacetingResultCache.clear(); _Flags.Drift = false; _Flags.SlowMS = 0; });

				test('scope drift between the probe and the execution: Bypass \'ScopeChanged\' (never stored); the next principal with the same key computes its own answer',
					(fDone) =>
					{
						let tmpStores = 0;
						let tmpLeadTotal = null;
						series(
							[
								(fNext) => { _Flags.Drift = true; tmpStores = H.fable.RetoldFacetingResultCache.stats().Stores; return fNext(); },
								T.inProcess('Document', Q_DOCUMENT_STATUS, LEAD, {},
									(pError, pEnvelope, pMeta) =>
									{
										Expect(pError).to.not.exist;
										Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'ScopeChanged' });
										Expect(pEnvelope.Version, 'the digest Version, not the generation one').to.match(/^fv1:[0-9a-f]{16}$/);
										Expect(H.fable.RetoldFacetingResultCache.stats().Stores).to.equal(tmpStores);
										tmpLeadTotal = pEnvelope.Total;
									}),
								(fNext) => { _Flags.Drift = false; return fNext(); },
								// The Member's probe yields the same key the Lead's did: a Miss, with the Member's own count.
								T.inProcess('Document', Q_DOCUMENT_STATUS, MEMBER, {},
									(pError, pEnvelope, pMeta) =>
									{
										Expect(pError).to.not.exist;
										Expect(pMeta.Cache.Status).to.equal('Miss');
										Expect(pEnvelope.Total).to.be.below(tmpLeadTotal);
										Expect(pEnvelope.Total).to.equal(T.row('SELECT COUNT(*) AS N FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND IDProject IN (1)').N);
									})
							], fDone);
					});

				test('a single-flight joiner never takes a leader\'s drifted answer: it computes its own',
					(fDone) =>
					{
						_Flags.Drift = true;
						_Flags.SlowMS = 30;
						let tmpResults = [];
						let fRun = (pWho) =>
						{
							let tmpRequest = libHarness.syntheticRequest('Document', pWho, Q_DOCUMENT_STATUS);
							H.faceting.queryInternal('Document', Q_DOCUMENT_STATUS, tmpRequest, {},
								(pError, pEnvelope, pMeta) =>
								{
									tmpResults.push({ Who: pWho.User, Error: pError, Total: pEnvelope ? pEnvelope.Total : null, Cache: pMeta ? pMeta.Cache : null });
									if (tmpResults.length < 2)
									{
										return;
									}
									setImmediate(
										() =>
										{
											try
											{
												let tmpLead = tmpResults.find((pResult) => { return pResult.Who === LEAD.User; });
												let tmpMember = tmpResults.find((pResult) => { return pResult.Who === MEMBER.User; });
												Expect(tmpLead.Cache.Reason).to.equal('ScopeChanged');
												Expect(tmpMember.Cache.Coalesced, 'the joiner recomputed').to.equal(false);
												Expect(tmpMember.Total).to.equal(T.row('SELECT COUNT(*) AS N FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND IDProject IN (1)').N);
												Expect(tmpLead.Total).to.be.above(tmpMember.Total);
											}
											catch (pCheckError)
											{
												return fDone(pCheckError);
											}
											return fDone();
										});
								});
						};
						fRun(LEAD);
						setTimeout(() => { fRun(MEMBER); }, 5);
					});

				test('a MinSeq this process cannot prove (another epoch, or beyond the local counter): no lookup and no 304 — computed (SQL ran), stored; a local, applied MinSeq may hit',
					(fDone) =>
					{
						let tmpETag = null;
						let tmpIntake = H.fable.RetoldFacetingChangeIntake;
						series(
							[
								T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, (pResponse) => { tmpETag = pResponse.Headers.etag; }),
								T.inProcess('Document', Object.assign({}, Q_DOCUMENT_STATUS, { Freshness: { Mode: 'Bounded', MinSeq: 'e:0badf00d:5' } }), LEAD, {},
									(pError, pEnvelope, pMeta) =>
									{
										Expect(pError).to.not.exist;
										Expect(pMeta.Cache).to.include({ Status: 'Miss', Reason: 'MinSeq' });
										Expect(pMeta.Statements).to.be.above(0);
										Expect(pMeta.Freshness).to.include({ Mode: 'Exact', Upgrade: 'MinSeq' });
									}),
								(fNext) =>
								{
									// A future local Seq and a matching If-None-Match: still no 304.
									let tmpFuture = libRetoldFacetingUtil.formatSeq(tmpIntake.NodeEpoch, tmpIntake._SeqCounter + 50);
									T.query('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': tmpETag, 'x-retold-facet-minseq': tmpFuture },
										(pResponse) =>
										{
											// The answer is the digest Version (its content), never the generation one this process
											// cannot vouch for: no 304 against the generation ETag.
											Expect(pResponse.Status).to.equal(200);
											Expect(pResponse.Headers['x-retold-facet-cache']).to.equal('Miss');
											Expect(pResponse.Headers.etag).to.not.equal(tmpETag);
										})(fNext);
								},
								(fNext) =>
								{
									// An applied local Seq proves itself: the current vector covers it.
									T.query('Document', Q_DOCUMENT_STATUS, LEAD, { 'if-none-match': tmpETag, 'x-retold-facet-minseq': tmpIntake.currentSeq() },
										(pResponse) =>
										{
											Expect(pResponse.Status).to.equal(304);
										})(fNext);
								}
							], fDone);
					});

				test('a model reload between newContext and the Cache stage makes the answer uncacheable (\'ModelReload\'): an old-model plan is never stored under the new ModelVersion',
					(fDone) =>
					{
						let tmpCatalog = H.fable.RetoldFacetingCatalog;
						let tmpPlanner = H.fable.RetoldFacetingPlanner;
						let fModelVersion = tmpCatalog.modelVersion;
						let fPlan = tmpPlanner.plan;
						let tmpReloaded = false;
						tmpPlanner.plan = function (...pArguments)
						{
							tmpReloaded = true;
							return fPlan.apply(this, pArguments);
						};
						tmpCatalog.modelVersion = function () { return tmpReloaded ? 'm:reloaded0000' : fModelVersion.call(this); };
						let fRestore = () => { tmpPlanner.plan = fPlan; tmpCatalog.modelVersion = fModelVersion; };
						T.inProcess('Document', Q_DOCUMENT_STATUS, LEAD, {},
							(pError, pEnvelope, pMeta) =>
							{
								fRestore();
								Expect(pError).to.not.exist;
								Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'ModelReload' });
							})(
							(pError) =>
							{
								fRestore();
								return fDone(pError);
							});
					});

				test('the background refresh of a Stale serve computes through the single flight: concurrent Exact misses of the same key and vector join it (one execution)',
					(fDone) =>
					{
						let tmpRow = T.row('SELECT IDDocument, Status FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND IDProject = 1 AND Status = \'Final\' ORDER BY IDDocument LIMIT 1');
						let tmpID = tmpRow.IDDocument;
						let tmpFlights = 0;
						let tmpBounded = Object.assign({}, Q_DOCUMENT_STATUS, { Freshness: { Mode: 'Bounded', MaxLagMS: 60000 } });
						series(
							[
								T.query('Document', Q_DOCUMENT_STATUS, LEAD, {}, null),
								// Another principal writes (the reader's own write would upgrade it to Exact).
								T.call('PUT', '/1.0/Document', { IDDocument: tmpID, Status: 'Archived' }, MEMBER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); }),
								(fNext) =>
								{
									_Flags.SlowMS = 30;
									tmpFlights = H.fable.RetoldFacetingResultCache.stats().Flights;
									let tmpPending = 6;
									let tmpStatuses = [];
									let fOne = (pBody) =>
									{
										let tmpRequest = libHarness.syntheticRequest('Document', LEAD, pBody);
										H.faceting.queryInternal('Document', pBody, tmpRequest, {},
											(pError, pEnvelope, pMeta) =>
											{
												tmpStatuses.push(pMeta ? pMeta.Cache.Status : String(pError));
												tmpPending--;
												if (tmpPending > 0)
												{
													return;
												}
												let fWait = () =>
												{
													if (H.fable.RetoldFacetingResultCache._Refreshing.size > 0)
													{
														return setTimeout(fWait, 5);
													}
													setImmediate(
														() =>
														{
															try
															{
																Expect(tmpStatuses.filter((pStatus) => { return pStatus === 'Stale'; }).length).to.equal(1);
																Expect(H.fable.RetoldFacetingResultCache.stats().Flights - tmpFlights, 'the refresh and the Exact misses ran once').to.equal(1);
															}
															catch (pCheckError)
															{
																return fNext(pCheckError);
															}
															return fNext();
														});
												};
												fWait();
											});
									};
									fOne(tmpBounded);
									setImmediate(() => { for (let i = 0; i < 5; i++) { fOne(Q_DOCUMENT_STATUS); } });
								},
								(fNext) => { _Flags.SlowMS = 0; return fNext(); },
								T.call('PUT', '/1.0/Document', { IDDocument: tmpID, Status: 'Final' }, MEMBER, {}, (pResponse) => { Expect(pResponse.Status).to.equal(200); })
							], fDone);
					});

				test('single flight is per timeout: requests with different TimeoutMS never share a leader; equal ones do',
					(fDone) =>
					{
						_Flags.SlowMS = 30;
						let tmpFlights = H.fable.RetoldFacetingResultCache.stats().Flights;
						let tmpResults = [];
						let fRun = (pTimeoutMS) =>
						{
							let tmpBody = Object.assign({}, Q_DOCUMENT_STATUS, { TimeoutMS: pTimeoutMS });
							let tmpRequest = libHarness.syntheticRequest('Document', LEAD, tmpBody);
							H.faceting.queryInternal('Document', tmpBody, tmpRequest, {},
								(pError, pEnvelope, pMeta) =>
								{
									tmpResults.push({ TimeoutMS: pTimeoutMS, Coalesced: pMeta ? pMeta.Cache.Coalesced : null });
									if (tmpResults.length < 3)
									{
										return;
									}
									setImmediate(
										() =>
										{
											try
											{
												Expect(H.fable.RetoldFacetingResultCache.stats().Flights - tmpFlights).to.equal(2);
												Expect(tmpResults.filter((pResult) => { return pResult.Coalesced; }).map((pResult) => { return pResult.TimeoutMS; })).to.deep.equal([ 5000 ]);
											}
											catch (pCheckError)
											{
												return fDone(pCheckError);
											}
											return fDone();
										});
								});
						};
						fRun(5000);
						fRun(5000);
						fRun(9000);
					});
			}
		);

		suite
		(
			'defaults (Cache.Enabled only): what an ordinary client is told',
			function ()
			{
				this.timeout(60000);

				let H = null;
				let B = null;
				let T = tools(() => { return H; });
				let TB = tools(() => { return B; });

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Cache: { Enabled: true } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								B = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Faceting: { Cache: { Enabled: true } } }, fDone);
							});
					});
				suiteTeardown((fDone) => { H.stop(() => { return B ? B.stop(fDone) : fDone(); }); });

				test('a policy host sends no X-Retold-Facet-Seq, -Cache or -Freshness; a hit computed by another principal says Cached: false, the principal\'s own hit says Cached: true',
					(fDone) =>
					{
						let tmpLead = H.as('Lead');
						let tmpMember = H.as('Member');
						series(
							[
								T.query('Document', Q_DOCUMENT_STATUS, tmpLead, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										[ 'x-retold-facet-seq', 'x-retold-facet-cache', 'x-retold-facet-freshness' ].forEach((pHeader) => { Expect(pResponse.Headers).to.not.have.property(pHeader); });
										Expect(pResponse.Body.Cached).to.equal(false);
									}),
								T.query('Document', Q_DOCUMENT_STATUS, tmpMember, {}, (pResponse) => { Expect(pResponse.Body.Cached, 'a colleague\'s entry').to.equal(false); }),
								T.inProcess('Document', Q_DOCUMENT_STATUS, tmpMember, {}, (pError, pEnvelope, pMeta) => { Expect(pMeta.Cache.Status, 'it was a hit (server side)').to.equal('Hit'); }),
								T.query('Document', Q_DOCUMENT_STATUS, tmpLead, {}, (pResponse) => { Expect(pResponse.Body.Cached, 'its own entry').to.equal(true); }),
								T.call('GET', '/1.0/Facet/Describe', null, tmpLead, {}, (pResponse) => { Expect(pResponse.Body.Changes.Stream).to.equal('/1.0/Facet/Changes'); })
							], fDone);
					});

				test('a host without a policy sends X-Retold-Facet-Seq and does not mount the change stream (SSE.Enabled \'Auto\')',
					(fDone) =>
					{
						series(
							[
								TB.query('Review', { Facets: [ { Key: 'Rating', Facet: 'Review.Rating' } ] }, {}, {},
									(pResponse) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(pResponse.Headers['x-retold-facet-seq']).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
									}),
								TB.call('GET', '/1.0/Facet/Describe', null, {}, {}, (pResponse) => { Expect(pResponse.Body.Changes.Stream).to.equal(null); }),
								TB.call('GET', '/1.0/Facet/Changes', null, { User: 5 }, {}, (pResponse) => { Expect(pResponse.Status).to.equal(404); })
							], fDone);
					});
			}
		);
	}
);
