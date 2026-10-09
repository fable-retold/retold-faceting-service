/**
 * Facet-ReadYourWrites: the read-your-writes tracker and the MinSeq upgrade.
 *
 * Owner: builder C (M4).  Obligations: internal-contracts §45, §49.1.  Registry port: 19135 (the
 * harness binds an ephemeral port; 19135 names the run).
 *
 *   - Bounded / Fast are upgraded to Exact within ReadYourWritesMS after the principal's own write,
 *     not after it, never for another principal (another user, another tenant), and Exact stays
 *     Exact (Upgrade null);
 *   - MinSeq: own epoch, a foreign epoch and a future Seq all upgrade to Exact (the Live path cannot
 *     wait for a Seq); a malformed MinSeq is the normalizer's 400 over HTTP;
 *   - the number of tracked principals is bounded (oldest writer dropped first);
 *   - events without a principal key, settle re-deliveries and garbage are ignored, never thrown on;
 *   - the write principal (Host.buildPrincipal over the write's SessionData, as the intake builds it)
 *     and the read principal (PrincipalResolver over the same session) share a principal key, so a
 *     tracked write upgrades that session's reads and nobody else's;
 *   - end to end through notify({ Principal }) and an HTTP write when the intake is in place.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libReadYourWrites = require('../source/change/Retold-Faceting-ReadYourWrites.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');

const PORT = 19135;

const EPOCH = 'e:4f0c2b9e';
const FOREIGN_EPOCH = 'e:0badcafe';

/**
 * A principal as Host.buildPrincipal shapes it.
 *
 * @param {number} pUser
 * @param {number} pTenant
 * @param {Record<string, any>} [pExtra]
 * @return {Record<string, any>}
 */
const principal = (pUser, pTenant, pExtra) =>
{
	return Object.assign(
		{
			Kind: 'User',
			Source: 'InProcess',
			IDUser: pUser,
			IDCustomer: pTenant,
			ScopeValues: { IDCustomer: pTenant },
			UserRecord: { IDUser: pUser, IDCustomer: pTenant },
			RoleSetHash: '',
			ResolvedAt: Date.now()
		}, pExtra || {});
};

/**
 * A ChangeEvent as the intake delivers it (internal-contracts §39.2), for one writer.
 *
 * @param {Record<string, any>|null} pPrincipal
 * @param {number} pN - the Seq counter
 * @param {Record<string, any>} [pOverrides]
 * @return {Record<string, any>}
 */
const changeEvent = (pPrincipal, pN, pOverrides) =>
{
	return Object.freeze(Object.assign(
		{
			ChangeID: `ch:${String(pN).padStart(6, '0')}`,
			Source: 'Interim',
			Entity: 'Project',
			Operation: 'Update',
			IDs: [ 1 ],
			Tenants: [ 1 ],
			Owners: null,
			ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ],
			KeyImages: {},
			Filter: null,
			Actor: { PrincipalKey: pPrincipal ? libRetoldFacetingUtil.principalKey(pPrincipal) : null, UserID: pPrincipal ? pPrincipal.IDUser : 0, Verb: 'Update' },
			Timestamp: Date.now(),
			Epoch: EPOCH,
			Seq: `${EPOCH}:${pN}`
		}, pOverrides || {}));
};

/**
 * A tracker on a quiet fable with Freshness overrides.
 *
 * @param {Record<string, any>} [pFreshness]
 * @return {any}
 */
const tracker = (pFreshness) =>
{
	return new libReadYourWrites(libBuilders.newFable('RetoldFacetingReadYourWritesTest'), { Freshness: Object.assign({ ReadYourWritesMS: 10000, ReadYourWritesMaxPrincipals: 10000 }, pFreshness || {}) });
};

const BOUNDED = Object.freeze({ Mode: 'Bounded', MaxLagMS: 5000, MinSeq: null });
const FAST = Object.freeze({ Mode: 'Fast', MaxLagMS: 5000, MinSeq: null });
const EXACT = Object.freeze({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null });

suite
(
	'Facet-ReadYourWrites',
	() =>
	{
		suite
		(
			'tracker',
			() =>
			{
				test('with no writes every mode is kept as requested (Upgrade null); an invalid mode is the DefaultMode',
					() =>
					{
						let tmpTracker = tracker();
						let tmpPrincipal = principal(1, 1);
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, EXACT)).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Exact', Upgrade: null });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, BOUNDED)).to.deep.equal({ Mode: 'Bounded', MaxLagMS: 5000, MinSeq: null, Requested: 'Bounded', Upgrade: null });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, FAST)).to.deep.equal({ Mode: 'Fast', MaxLagMS: 5000, MinSeq: null, Requested: 'Fast', Upgrade: null });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, { Mode: 'Eventually', MaxLagMS: 'x' })).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Exact', Upgrade: null });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, null)).to.include({ Mode: 'Exact', Requested: 'Exact', Upgrade: null });
						let tmpBoundedDefault = new libReadYourWrites(libBuilders.newFable('RetoldFacetingReadYourWritesTest'), { Freshness: { DefaultMode: 'Bounded', MaxLagMS: 750 } });
						Expect(tmpBoundedDefault.effectiveFreshness(tmpPrincipal, undefined)).to.deep.equal({ Mode: 'Bounded', MaxLagMS: 750, MinSeq: null, Requested: 'Bounded', Upgrade: null });
						Expect(tmpTracker.stats()).to.deep.equal({ Principals: 0, Writes: 0, Upgrades: { ReadYourWrites: 0, MinSeq: 0 } });
					});

				test('a principal\'s own write upgrades its Bounded and Fast reads to Exact within ReadYourWritesMS; Exact stays Exact',
					() =>
					{
						let tmpTracker = tracker();
						let tmpPrincipal = principal(1, 1);
						tmpTracker.onChange(changeEvent(tmpPrincipal, 41));
						let tmpWrite = tmpTracker.lastWrite(tmpPrincipal);
						Expect(tmpWrite.Seq).to.equal(`${EPOCH}:41`);
						Expect(tmpWrite.At).to.be.within(Date.now() - 1000, Date.now());
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, BOUNDED)).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Bounded', Upgrade: 'ReadYourWrites' });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, FAST)).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Fast', Upgrade: 'ReadYourWrites' });
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, EXACT)).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Exact', Upgrade: null });
						// The same principal resolved again later (another ResolvedAt / Source) has the same key.
						let tmpAgain = principal(1, 1, { ResolvedAt: Date.now() + 5, Source: 'Session' });
						Expect(tmpTracker.effectiveFreshness(tmpAgain, BOUNDED).Upgrade).to.equal('ReadYourWrites');
						// A principal key works as well as the principal.
						Expect(tmpTracker.lastWrite(libRetoldFacetingUtil.principalKey(tmpPrincipal)).Seq).to.equal(`${EPOCH}:41`);
						Expect(tmpTracker.stats()).to.deep.equal({ Principals: 1, Writes: 1, Upgrades: { ReadYourWrites: 3, MinSeq: 0 } });
					});

				test('the window ends after ReadYourWritesMS (the boundary itself is inside), and the expired entry is dropped',
					() =>
					{
						let tmpTracker = tracker({ ReadYourWritesMS: 2000 });
						let tmpPrincipal = principal(1, 1);
						tmpTracker.onChange(changeEvent(tmpPrincipal, 7));
						let tmpAt = tmpTracker.lastWrite(tmpPrincipal).At;
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, BOUNDED, tmpAt + 2000).Upgrade).to.equal('ReadYourWrites');
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, BOUNDED, tmpAt + 2001)).to.deep.equal({ Mode: 'Bounded', MaxLagMS: 5000, MinSeq: null, Requested: 'Bounded', Upgrade: null });
						Expect(tmpTracker.lastWrite(tmpPrincipal)).to.equal(null);
						Expect(tmpTracker.stats().Principals).to.equal(0);
					});

				test('a real wait: the upgrade lapses once ReadYourWritesMS has passed',
					(fDone) =>
					{
						let tmpTracker = tracker({ ReadYourWritesMS: 40 });
						let tmpPrincipal = principal(1, 1);
						tmpTracker.onChange(changeEvent(tmpPrincipal, 8));
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, FAST).Mode).to.equal('Exact');
						setTimeout(
							() =>
							{
								Expect(tmpTracker.effectiveFreshness(tmpPrincipal, FAST)).to.include({ Mode: 'Fast', Upgrade: null });
								Expect(tmpTracker.stats().Principals).to.equal(0);
								return fDone();
							}, 80);
					});

				test('another principal is never upgraded by someone else\'s write (other user, other tenant, other roles, anonymous)',
					() =>
					{
						let tmpTracker = tracker();
						tmpTracker.onChange(changeEvent(principal(1, 1), 9));
						[
							principal(2, 1),
							principal(1, 2),
							principal(1, 1, { RoleSetHash: 'r:admin' }),
							principal(1, 1, { Kind: 'Anonymous' }),
							principal(1, 1, { ScopeValues: { IDCustomer: 1, OwnerIDUser: 1 } })
						].forEach(
							(pOther) =>
							{
								Expect(tmpTracker.effectiveFreshness(pOther, BOUNDED)).to.include({ Mode: 'Bounded', Upgrade: null });
								Expect(tmpTracker.lastWrite(pOther)).to.equal(null);
							});
						Expect(tmpTracker.effectiveFreshness(null, BOUNDED)).to.include({ Mode: 'Bounded', Upgrade: null });
						Expect(tmpTracker.stats().Upgrades.ReadYourWrites).to.equal(0);
					});

				test('MinSeq upgrades to Exact for its own epoch, a foreign epoch and a future Seq; Exact with MinSeq stays unflagged',
					() =>
					{
						let tmpTracker = tracker();
						let tmpPrincipal = principal(3, 1);
						[ `${EPOCH}:12`, `${FOREIGN_EPOCH}:12`, `${EPOCH}:999999999999` ].forEach(
							(pSeq) =>
							{
								Expect(tmpTracker.effectiveFreshness(tmpPrincipal, { Mode: 'Bounded', MaxLagMS: 2500, MinSeq: pSeq })).to.deep.equal({ Mode: 'Exact', MaxLagMS: 2500, MinSeq: pSeq, Requested: 'Bounded', Upgrade: 'MinSeq' });
								Expect(tmpTracker.effectiveFreshness(tmpPrincipal, { Mode: 'Fast', MaxLagMS: 0, MinSeq: pSeq })).to.include({ Mode: 'Exact', MinSeq: pSeq, Upgrade: 'MinSeq' });
							});
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, { Mode: 'Exact', MaxLagMS: 5000, MinSeq: `${EPOCH}:3` })).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: `${EPOCH}:3`, Requested: 'Exact', Upgrade: null });
						// MinSeq wins over read-your-writes when both apply.
						tmpTracker.onChange(changeEvent(tmpPrincipal, 13));
						Expect(tmpTracker.effectiveFreshness(tmpPrincipal, { Mode: 'Bounded', MaxLagMS: 5000, MinSeq: `${EPOCH}:13` }).Upgrade).to.equal('MinSeq');
						Expect(tmpTracker.stats().Upgrades).to.deep.equal({ ReadYourWrites: 0, MinSeq: 7 });
					});

				test('a malformed MinSeq from an in-process caller still upgrades (toward the fresher answer) and is reported as null',
					() =>
					{
						let tmpTracker = tracker();
						Expect(tmpTracker.effectiveFreshness(principal(1, 1), { Mode: 'Bounded', MaxLagMS: 5000, MinSeq: 'e:XYZ:1' })).to.deep.equal({ Mode: 'Exact', MaxLagMS: 5000, MinSeq: null, Requested: 'Bounded', Upgrade: 'MinSeq' });
						// An empty string is no MinSeq at all.
						Expect(tmpTracker.effectiveFreshness(principal(1, 1), { Mode: 'Bounded', MaxLagMS: 5000, MinSeq: '' })).to.include({ Mode: 'Bounded', Upgrade: null });
					});

				test('the tracked principals are bounded by ReadYourWritesMaxPrincipals (oldest writer dropped first; a new write moves a writer to the newest end)',
					() =>
					{
						let tmpTracker = tracker({ ReadYourWritesMaxPrincipals: 3 });
						let tmpWriters = [ 1, 2, 3, 4, 5 ].map((pUser) => { return principal(pUser, 1); });
						tmpWriters.forEach((pWriter, pIndex) => { tmpTracker.onChange(changeEvent(pWriter, 100 + pIndex)); });
						Expect(tmpTracker.stats()).to.include({ Principals: 3, Writes: 5 });
						Expect(tmpTracker.lastWrite(tmpWriters[0])).to.equal(null);
						Expect(tmpTracker.lastWrite(tmpWriters[1])).to.equal(null);
						[ 2, 3, 4 ].forEach((pIndex) => { Expect(tmpTracker.effectiveFreshness(tmpWriters[pIndex], BOUNDED).Upgrade).to.equal('ReadYourWrites'); });
						// Writer 3 (index 2) writes again: it is now the newest, so writer 4 (index 3) is the next dropped.
						tmpTracker.onChange(changeEvent(tmpWriters[2], 200));
						tmpTracker.onChange(changeEvent(tmpWriters[0], 201));
						Expect(tmpTracker.stats().Principals).to.equal(3);
						Expect(tmpTracker.lastWrite(tmpWriters[3])).to.equal(null);
						Expect(tmpTracker.lastWrite(tmpWriters[2]).Seq).to.equal(`${EPOCH}:200`);
						Expect(tmpTracker.lastWrite(tmpWriters[4])).to.not.equal(null);
						Expect(tmpTracker.lastWrite(tmpWriters[0]).Seq).to.equal(`${EPOCH}:201`);
					});

				test('events without a principal key, settle re-deliveries and garbage are ignored and never throw',
					() =>
					{
						let tmpTracker = tracker();
						let tmpPrincipal = principal(1, 1);
						[
							null, undefined, 7, 'x', {}, { Actor: null }, { Actor: 'pk:0000000000000000' },
							changeEvent(null, 1),
							changeEvent(tmpPrincipal, 2, { Actor: { PrincipalKey: 'not-a-key' } }),
							changeEvent(tmpPrincipal, 3, { ChangeID: 'ch:000003~settle', Source: 'Notify' })
						].forEach(
							(pEvent) =>
							{
								Expect(() => { tmpTracker.onChange(pEvent); }).to.not.throw();
							});
						Expect(tmpTracker.stats()).to.deep.equal({ Principals: 0, Writes: 0, Upgrades: { ReadYourWrites: 0, MinSeq: 0 } });
						// A Notify write with a principal does count (only its settle re-delivery does not).
						tmpTracker.onChange(changeEvent(tmpPrincipal, 4, { ChangeID: 'ch:000004', Source: 'Notify' }));
						Expect(tmpTracker.lastWrite(tmpPrincipal).Seq).to.equal(`${EPOCH}:4`);
						Expect(() => { tmpTracker.effectiveFreshness({ get ScopeValues() { throw new Error('boom'); } }, BOUNDED); }).to.not.throw();
					});

				test('ReadYourWritesMS 0 turns the tracker off (MinSeq still upgrades); clear() forgets every write',
					() =>
					{
						let tmpOff = tracker({ ReadYourWritesMS: 0 });
						let tmpPrincipal = principal(1, 1);
						tmpOff.onChange(changeEvent(tmpPrincipal, 5));
						Expect(tmpOff.effectiveFreshness(tmpPrincipal, BOUNDED).Upgrade).to.equal(null);
						Expect(tmpOff.effectiveFreshness(tmpPrincipal, { Mode: 'Fast', MaxLagMS: 5000, MinSeq: `${EPOCH}:5` }).Upgrade).to.equal('MinSeq');
						Expect(tmpOff.stats().Principals).to.equal(0);

						let tmpOn = tracker();
						tmpOn.onChange(changeEvent(tmpPrincipal, 6));
						Expect(tmpOn.stats().Principals).to.equal(1);
						tmpOn.clear();
						Expect(tmpOn.lastWrite(tmpPrincipal)).to.equal(null);
						Expect(tmpOn.effectiveFreshness(tmpPrincipal, BOUNDED).Upgrade).to.equal(null);
					});
			}
		);

		suite
		(
			'ProjectTrack (the write principal and the read principal)',
			() =>
			{
				let _Harness = null;
				let _Tracker = null;

				/**
				 * The principal a read of this session resolves to (PrincipalResolver, as stagePrincipal does).
				 */
				let fReadPrincipal = (pTenant, pUser, fCallback) =>
				{
					let tmpRequest = { params: {}, headers: {}, query: {}, UserSession: { LoggedIn: true, SessionID: `read-${pTenant}-${pUser}`, UserID: pUser, IDUser: pUser, IDTenant: pTenant, CustomerID: pTenant } };
					let tmpContext = { RequestID: 'rfq-test', Entity: 'Project', Request: tmpRequest, Host: _Harness.faceting.Host, Options: _Harness.faceting.options, Principal: null };
					_Harness.fable.RetoldFacetingPrincipalResolver.resolve(tmpContext, fCallback);
				};

				/**
				 * The principal of a write of this session, built the way the interim intake builds it
				 * (internal-contracts §40.3 Actor): Host.buildPrincipal over the controller's write-side
				 * SessionData (another SessionID: the key never reads it).
				 */
				let fWritePrincipal = (pTenant, pUser) =>
				{
					let tmpRequest = { params: {}, headers: {}, query: {}, body: {}, UserSession: { LoggedIn: true, SessionID: `write-${pTenant}-${pUser}`, UserID: pUser, IDUser: pUser, IDTenant: pTenant, CustomerID: pTenant } };
					let tmpController = _Harness.fable.MeadowEndpoints.Project.controller;
					let tmpRequestState = tmpController.initializeRequestState(tmpRequest, 'Update');
					return _Harness.faceting.Host.buildPrincipal(tmpRequestState.SessionData, tmpRequest);
				};

				suiteSetup(
					(fDone) =>
					{
						_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Freshness: { ReadYourWritesMS: 10000 } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_Tracker = _Harness.fable.RetoldFacetingReadYourWrites;
								return fDone();
							});
					});

				suiteTeardown(
					(fDone) =>
					{
						_Harness.stop(fDone);
					});

				setup(
					() =>
					{
						_Tracker.clear();
					});

				test('a write principal and the read principal of the same session share a principal key; other sessions do not',
					(fDone) =>
					{
						let tmpLead = _Harness.as('Lead');
						let tmpMember = _Harness.as('Member');
						let tmpOtherLead = _Harness.as('OtherLead');
						let tmpWriter = fWritePrincipal(tmpLead.Tenant, tmpLead.User);
						Expect(tmpWriter.Kind).to.equal('User');
						_Tracker.onChange(changeEvent(tmpWriter, 21));
						fReadPrincipal(tmpLead.Tenant, tmpLead.User,
							(pError, pReader) =>
							{
								Expect(pError).to.not.exist;
								Expect(libRetoldFacetingUtil.principalKey(pReader)).to.equal(libRetoldFacetingUtil.principalKey(tmpWriter));
								Expect(_Tracker.effectiveFreshness(pReader, BOUNDED)).to.include({ Mode: 'Exact', Upgrade: 'ReadYourWrites' });
								fReadPrincipal(tmpMember.Tenant, tmpMember.User,
									(pMemberError, pMember) =>
									{
										Expect(pMemberError).to.not.exist;
										Expect(_Tracker.effectiveFreshness(pMember, BOUNDED)).to.include({ Mode: 'Bounded', Upgrade: null });
										fReadPrincipal(tmpOtherLead.Tenant, tmpOtherLead.User,
											(pOtherError, pOther) =>
											{
												Expect(pOtherError).to.not.exist;
												Expect(_Tracker.effectiveFreshness(pOther, FAST)).to.include({ Mode: 'Fast', Upgrade: null });
												return fDone();
											});
									});
							});
					});

				// M4 wiring: the intake's notify exists (no skip any more).
				test('end to end: notify({ Principal }) records the writer and upgrades that session\'s reads',
					function (fDone)
					{
						let tmpIntake = _Harness.fable.RetoldFacetingChangeIntake;
						let tmpLead = _Harness.as('Lead');
						let tmpWriter = fWritePrincipal(tmpLead.Tenant, tmpLead.User);
						// The wiring subscribes the tracker at attach (internal-contracts §39.3); same name → replaced, never doubled.
						tmpIntake.subscribe('ReadYourWrites', (pEvent) => { _Tracker.onChange(pEvent); });
						let tmpSeq = tmpIntake.notify('Project', { Operation: 'Update', IDs: [ 1 ], Tenants: [ tmpLead.Tenant ], ChangedColumns: [ 'Status' ], Principal: tmpWriter });
						Expect(tmpSeq).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
						Expect(_Tracker.lastWrite(tmpWriter).Seq).to.equal(tmpSeq);
						fReadPrincipal(tmpLead.Tenant, tmpLead.User,
							(pError, pReader) =>
							{
								Expect(pError).to.not.exist;
								Expect(_Tracker.effectiveFreshness(pReader, BOUNDED)).to.include({ Mode: 'Exact', Upgrade: 'ReadYourWrites' });
								return fDone();
							});
					});

				// M4 wiring: attach installs the interim intake on Project (no skip any more).
				test('end to end: a write through the stock PUT route records the writer and only the writer',
					function (fDone)
					{
						let tmpIntake = _Harness.fable.RetoldFacetingChangeIntake;
						let tmpInstall = tmpIntake.install();
						Expect(tmpInstall.Source).to.equal('Interim');
						Expect(tmpInstall.Entities).to.include('Project');
						tmpIntake.subscribe('ReadYourWrites', (pEvent) => { _Tracker.onChange(pEvent); });
						let tmpLead = _Harness.as('Lead');
						_Harness.request('GET', '/1.0/Project/1', null, tmpLead,
							(pReadError, pRead) =>
							{
								Expect(pReadError).to.not.exist;
								Expect(pRead.Status).to.equal(200);
								_Harness.request('PUT', '/1.0/Project', { IDProject: 1, Name: pRead.Body.Name }, tmpLead,
									(pWriteError, pWrite) =>
									{
										Expect(pWriteError).to.not.exist;
										Expect(pWrite.Status).to.equal(200);
										fReadPrincipal(tmpLead.Tenant, tmpLead.User,
											(pError, pReader) =>
											{
												Expect(pError).to.not.exist;
												let tmpLastWrite = _Tracker.lastWrite(pReader);
												Expect(tmpLastWrite).to.not.equal(null);
												Expect(tmpLastWrite.Seq).to.match(libRetoldFacetingUtil.SEQ_PATTERN);
												Expect(_Tracker.effectiveFreshness(pReader, FAST)).to.include({ Mode: 'Exact', Upgrade: 'ReadYourWrites' });
												fReadPrincipal(_Harness.as('Member').Tenant, _Harness.as('Member').User,
													(pMemberError, pMember) =>
													{
														Expect(pMemberError).to.not.exist;
														Expect(_Tracker.lastWrite(pMember)).to.equal(null);
														return fDone();
													});
											});
									});
							});
					});

				// M4 wiring: the normalizer validates Freshness (internal-contracts §44.2; no skip any more).
				test('over HTTP a malformed MinSeq is the normalizer\'s 400',
					function (fDone)
					{
						_Harness.facetQuery('Project', { Facets: [ { Facet: 'Project.Status' } ], Freshness: { Mode: 'Bounded', MaxLagMS: 1000, MinSeq: 'e:nothex:12' } }, _Harness.as('Lead'),
							(pError, pResponse) =>
							{
								Expect(pError).to.not.exist;
								Expect(pResponse.Status).to.equal(400);
								Expect(pResponse.Body.Error.Code).to.equal('FACET_REQUEST_INVALID');
								Expect(pResponse.Body.Error.Detail).to.include({ Field: 'Freshness.MinSeq' });
								return fDone();
							});
					});

				// X-Retold-Facet-Freshness is checked whenever the response carries it (the wiring's §44.8).
				test('over HTTP a valid MinSeq (own or foreign epoch) is accepted and answered Exact, never Stale',
					(fDone) =>
					{
						let tmpIntake = _Harness.fable.RetoldFacetingChangeIntake;
						let tmpSeqs = [ tmpIntake.currentSeq(), `${FOREIGN_EPOCH}:99` ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpSeqs.length)
							{
								return fDone();
							}
							_Harness.facetQuery('Project', { Facets: [ { Facet: 'Project.Status' } ], Freshness: { Mode: 'Fast', MaxLagMS: 1000, MinSeq: tmpSeqs[pIndex] } }, _Harness.as('Lead'),
								(pError, pResponse) =>
								{
									Expect(pError).to.not.exist;
									Expect(pResponse.Status).to.equal(200);
									Expect(pResponse.Body.Stale).to.equal(false);
									let tmpFreshness = pResponse.Headers['x-retold-facet-freshness'];
									if (typeof(tmpFreshness) === 'string')
									{
										Expect(tmpFreshness).to.equal('Exact; upgraded=MinSeq');
									}
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});
			}
		);
	}
);
