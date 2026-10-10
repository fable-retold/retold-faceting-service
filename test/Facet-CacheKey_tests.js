/**
 * Facet-CacheKey: the cache DepSet, scope probes, cacheability, key material, dependencies and Version.
 *
 * Owner: builder A (M4).  Obligations: internal-contracts §42, §49.1.  Registry port: 19132 (both
 * harnesses bind ephemeral ports; the registry port only names the run).
 *
 * The requests run the real pipeline up to Plan (Principal → Shape → Gate → Bind → Filter → Plan) on
 * the ProjectTrack and LabTrack fixtures; the CacheKey service then works on that context and plan
 * exactly as the wiring's Cache stage will (internal-contracts §44.3).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libCacheKey = require('../source/security/Retold-Faceting-CacheKey.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const PORT = 19132;
const TEST_NOW = '2026-10-08T12:00:00Z';

// ---------------------------------------------------------------------------------- request bodies

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
			Total: true,
			Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
		});
};

const e2Body = (pTraps, pRecords) =>
{
	let tmpBody = (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ pTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month' },
					{ Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 },
					{ Key: 'Status', Facet: 'Document.Status', Exclude: 'None' }
				]
		});
	if (pRecords)
	{
		tmpBody.Records = { Begin: 0, Cap: 100 };
	}
	return tmpBody;
};

// Project + Issue (the Unblocked scope's NotExists hop): the probe-mode tests act on Issue.
const unblockedBody = () =>
{
	return { Scopes: [ { Scope: 'Project.Unblocked' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] };
};

const e3aBody = () =>
{
	return (
		{
			Facets:
				[
					{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' },
					{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
				]
		});
};

const labFormBody = () =>
{
	return { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ] };
};

// ---------------------------------------------------------------------------------- helpers

/**
 * Run the real pipeline up to Plan and hand back the context and the plan.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {{ Tenant?: number, User?: number, SessionID?: string, Headers?: Record<string, string>, Now?: string, Internal?: Record<string, any> }} pWho
 * @param {(pError?: Error, pContext?: Record<string, any>, pPlan?: Record<string, any>) => void} fCallback
 */
const planned = (pHarness, pEntity, pBody, pWho, fCallback) =>
{
	let tmpService = pHarness.faceting;
	let tmpRequest = libHarness.syntheticRequest(pEntity, pWho, pBody);
	if (pWho.SessionID && tmpRequest.UserSession)
	{
		tmpRequest.UserSession.SessionID = pWho.SessionID;
	}
	if (pWho.Headers)
	{
		Object.assign(tmpRequest.headers, pWho.Headers);
	}
	let tmpInternal = Object.assign({ Now: pWho.Now || TEST_NOW }, pWho.Internal || {});
	let tmpContext = tmpService.newContext(pEntity, tmpRequest, tmpInternal, pWho.Mode);
	let tmpStart = Date.now();
	tmpService.fable.Utility.waterfall(
		[
			(fNext) => { return tmpService.stagePrincipal(tmpContext, fNext); },
			(fNext) => { return tmpService.stageShape(tmpContext, pBody, tmpStart, fNext); },
			(fNext) => { return tmpService.stageGate(tmpContext, fNext); },
			(fNext) => { return tmpService.stageBind(tmpContext, fNext); },
			(fNext) => { return tmpService.stageFilter(tmpContext, fNext); },
			(fNext) => { return tmpService.stagePlan(tmpContext, fNext); }
		],
		(pError, pPlan) =>
		{
			setImmediate(() => { return fCallback(pError || null, tmpContext, pPlan); });
		});
};

/**
 * Plan, then depSet + probes + cacheability + key (what the Cache stage computes).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} pWho
 * @param {(pError?: Error, pResult?: Record<string, any>) => void} fCallback
 */
const keyed = (pHarness, pEntity, pBody, pWho, fCallback) =>
{
	planned(pHarness, pEntity, pBody, pWho,
		(pError, pContext, pPlan) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpCacheKey = pHarness.fable.RetoldFacetingCacheKey;
			let tmpDeps = tmpCacheKey.depSet(pContext, pPlan);
			tmpCacheKey.captureScopes(pContext, tmpDeps,
				(pProbeError, pProbe) =>
				{
					Expect(pProbeError, 'a probe never calls back an error').to.equal(null);
					let tmpKey = tmpCacheKey.key(pContext, pPlan, pProbe);
					return fCallback(null,
						{
							Context: pContext,
							Plan: pPlan,
							Deps: tmpDeps,
							Probe: pProbe,
							Cacheability: tmpCacheKey.cacheability(pContext, pPlan, tmpDeps, pProbe),
							Key: tmpKey.Key,
							Short: tmpKey.Short,
							Material: tmpCacheKey.material(pContext, pPlan, pProbe),
							Dependencies: tmpCacheKey.dependencies(pContext, tmpDeps, pProbe)
						});
				});
		});
};

/**
 * Count every statement any DAL provider of the harness executes (Read / Count / Create / Update /
 * Delete / Undelete) until restore().
 *
 * @param {Record<string, any>} pHarness
 * @return {{ count: () => number, restore: () => void }}
 */
const spyStatements = (pHarness) =>
{
	let tmpCount = 0;
	let tmpRestores = [];
	let tmpSeen = new Set();
	Object.keys(pHarness.fable.MeadowEndpoints || {}).forEach(
		(pEntity) =>
		{
			let tmpProvider = pHarness.fable.MeadowEndpoints[pEntity].controller.DAL.provider;
			if (!tmpProvider || tmpSeen.has(tmpProvider))
			{
				return;
			}
			tmpSeen.add(tmpProvider);
			[ 'Read', 'Count', 'Create', 'Update', 'Delete', 'Undelete' ].forEach(
				(pMethod) =>
				{
					if (typeof(tmpProvider[pMethod]) !== 'function')
					{
						return;
					}
					let fOriginal = tmpProvider[pMethod];
					let tmpHadOwn = Object.prototype.hasOwnProperty.call(tmpProvider, pMethod);
					tmpProvider[pMethod] = function ()
					{
						tmpCount++;
						return fOriginal.apply(this, arguments);
					};
					tmpRestores.push(() => { if (tmpHadOwn) { tmpProvider[pMethod] = fOriginal; } else { delete tmpProvider[pMethod]; } });
				});
		});
	return { count: () => { return tmpCount; }, restore: () => { tmpRestores.forEach((fRestore) => { fRestore(); }); } };
};

/**
 * Install (permanently) a mode-switched Reads-QueryConfiguration behavior on an entity: 'none' does
 * nothing, so it can stay installed for the whole suite.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, string>} pModes - entity → mode (read at every run)
 */
const installModeBehavior = (pHarness, pEntity, pModes) =>
{
	pHarness.installBehavior(pEntity, 'Reads-QueryConfiguration',
		function (pRequest, pRequestState, fCallback)
		{
			switch (pModes[pEntity])
			{
				case 'override':
					pRequestState.Query.parameters.queryOverride = 'SELECT <%= FieldList %> FROM <%= TableName %> <%= Where %>';
					return fCallback();
				case '401':
					return fCallback(this.ErrorHandler.getError('Not for you.', 401));
				case 'nocache':
					pRequestState.FacetCacheable = false;
					return fCallback();
				case 'append':
					pRequestState.Query.addFilter('CreatingIDUser', -1, '!=', 'AND', 'TestHideSystem');
					return fCallback();
				default:
					return fCallback();
			}
		});
};

/**
 * Temporarily add a read-side behavior to an entity's route-bound controller; returns the remover.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {string} pHash
 * @return {() => void}
 */
const addReadSideBehavior = (pHarness, pEntity, pHash) =>
{
	let tmpInjection = pHarness.fable.MeadowEndpoints[pEntity].controller.BehaviorInjection;
	tmpInjection.setBehavior(pHash, function (pRequest, pRequestState, fCallback) { return fCallback(); });
	return () => { delete tmpInjection._BehaviorFunctions[pHash]; };
};

suite
(
	'Facet-CacheKey',
	() =>
	{
		test('the Version has the M1 shape and depends on the key and the vector',
			() =>
			{
				let tmpCacheKey = new libCacheKey(libBuilders.newFable('RetoldFacetingCacheKeyTest'));
				Expect(tmpCacheKey.version('ck:a', 'g:b')).to.match(/^fv1:[0-9a-f]{16}$/);
				Expect(tmpCacheKey.version('ck:a', 'g:b')).to.equal(tmpCacheKey.version('ck:a', 'g:b'));
				Expect(tmpCacheKey.version('ck:a', 'g:c')).to.not.equal(tmpCacheKey.version('ck:a', 'g:b'));
				Expect(tmpCacheKey.version('ck:b', 'g:b')).to.not.equal(tmpCacheKey.version('ck:a', 'g:b'));
				Expect(libCacheKey.KEY_VERSION).to.equal(1);
				Expect(libCacheKey.UNCACHEABLE_REASONS).to.deep.equal([ 'Mode', 'ForceEngine', 'PlanErrors', 'NoChangeSource', 'ModelReload', 'TooManyEntities', 'ProbeError', 'Opaque', 'RecordsPostOperation', 'NotCacheable', 'Errors', 'Staged', 'ScopeChanged', 'TooLarge', 'Store' ]);
			});

		test('without a Generations service, dependencies fall back to the keys every write moves',
			() =>
			{
				let tmpCacheKey = new libCacheKey(libBuilders.newFable('RetoldFacetingCacheKeyBare'));
				let tmpDependencies = tmpCacheKey.dependencies({}, { DepSet: { Project: [ 'IDProject', 'Status', '#cols' ] }, TenantOnly: [] }, { Captures: {} });
				Expect(tmpDependencies).to.deep.equal([ { Entity: 'Project', TenantKeys: [ '#any', '*' ], Columns: [ '#all', '#cols', '#row', 'IDProject', 'Status' ] } ]);
				// Without a probe nothing is cacheable (fail closed), whatever the pre-checks say.
				Expect(tmpCacheKey.cacheability({ Mode: 'Query' }, { Errors: {} }, { Entities: [] }, null)).to.deep.equal({ Cacheable: false, Reason: 'ProbeError' });
				Expect(tmpCacheKey.precheck({ Mode: 'Query' }, { Errors: {} })).to.deep.equal({ Cacheable: true, Reason: null });
			});

		suite
		(
			'ProjectTrack (tenant policy, a global lookup)',
			() =>
			{
				let _Harness = null;
				let _Modes = { Issue: 'none' };

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { Scope: { TrustPostOperation: [ 'Document' ], TrustedOpaque: [ 'Issue' ] } } },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							installModeBehavior(_Harness, 'Issue', _Modes);
							return fDone();
						});
				});

				suiteTeardown((fDone) =>
				{
					if (!_Harness)
					{
						return fDone();
					}
					_Harness.stop(fDone);
				});

				teardown(() =>
				{
					_Modes.Issue = 'none';
				});

				suite
				(
					'depSet (internal-contracts §42.1)',
					() =>
					{
						test('E1: every hop entity, the readable label target, #cols on the pivot for Records; sorted; no TenantOnly',
							(fDone) =>
							{
								keyed(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										let tmpDeps = pResult.Deps;
										Expect(tmpDeps.Entities).to.include.members([ 'Client', 'Issue', 'Project', 'ProjectMembership', 'Task' ]);
										Expect(tmpDeps.Entities).to.deep.equal(Object.keys(tmpDeps.DepSet));
										Expect(tmpDeps.Entities).to.deep.equal(tmpDeps.Entities.slice().sort());
										Expect(tmpDeps.LabelTargets).to.deep.equal([ 'Client' ]);
										Expect(tmpDeps.DepSet.Client).to.include.members([ 'IDClient', 'Name', 'IDCustomer', 'Deleted' ]);
										Expect(tmpDeps.DepSet.Project).to.include.members([ '#cols', 'IDProject', 'Status', 'StartDate', 'IDClient', 'IDCustomer', 'Deleted' ]);
										Expect(tmpDeps.DepSet.Issue).to.include.members([ 'IDProject', 'Severity', 'State' ]);
										Expect(tmpDeps.DepSet.Issue).to.not.include('#cols');
										Expect(tmpDeps.Records).to.equal(true);
										Expect(tmpDeps.TenantOnly).to.deep.equal([]);
										Object.keys(tmpDeps.DepSet).forEach((pEntity) => { Expect(tmpDeps.DepSet[pEntity]).to.deep.equal(tmpDeps.DepSet[pEntity].slice().sort()); });
										// The plan DepSet is a subset: the cache DepSet only adds.
										Object.keys(pResult.Plan.DepSet).forEach((pEntity) => { Expect(tmpDeps.DepSet[pEntity]).to.include.members(pResult.Plan.DepSet[pEntity]); });
										return fDone();
									});
							});

						test('E2 without Records: no #cols; the global lookup is a hop and a label target',
							(fDone) =>
							{
								keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Deps.Entities).to.deep.equal([ 'Document', 'FormType' ]);
										Expect(pResult.Deps.Records).to.equal(false);
										Expect(pResult.Deps.LabelTargets).to.deep.equal([ 'FormType' ]);
										Expect(pResult.Deps.DepSet.FormType).to.include.members([ 'IDFormType', 'Name' ]);
										Expect(pResult.Deps.DepSet.Document).to.not.include('#cols');
										Expect(pResult.Deps.DepSet.Document).to.include.members([ 'DocumentDate', 'IDFormType', 'Status' ]);
										return fDone();
									});
							});

						test('label targets are gated: a target the principal cannot facet contributes no dependency',
							(fDone) =>
							{
								planned(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('Lead'),
									(pError, pContext, pPlan) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										let tmpPlan = { DepSet: { Document: [ 'IDDocument', 'IDFormType' ] }, Aggs: [ { Key: 'ByForm', LabelLookup: { Entity: 'FormType', KeyColumn: 'IDFormType', LabelColumn: 'Name' } } ], Variants: {} };
										Expect(tmpCacheKey.depSet(pContext, tmpPlan).LabelTargets).to.deep.equal([ 'FormType' ]);
										// An anonymous principal under the policy can facet nothing.
										let tmpAnonymous = Object.assign({}, pContext, { Principal: Object.assign({}, pContext.Principal, { Kind: 'Anonymous' }) });
										let tmpGated = tmpCacheKey.depSet(tmpAnonymous, tmpPlan);
										Expect(tmpGated.LabelTargets).to.deep.equal([]);
										Expect(tmpGated.Entities).to.deep.equal([ 'Document' ]);
										// A target that is not facetable at all.
										let tmpUnknown = { DepSet: { Document: [ 'IDDocument' ] }, Aggs: [ { LabelLookup: { Entity: 'NoSuchEntity', KeyColumn: 'ID', LabelColumn: 'Name' } }, { LabelLookup: null }, null ], Variants: {} };
										Expect(tmpCacheKey.depSet(pContext, tmpUnknown).Entities).to.deep.equal([ 'Document' ]);
										return fDone();
									});
							});

						test('Records: every entity a filter conjunct reads is a dependency, even when no planned Variant keeps it',
							(fDone) =>
							{
								planned(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
									(pError, pContext) =>
									{
										Expect(pError).to.equal(null);
										// A plan whose facets kept nothing of the Client join clause.
										let tmpDeps = _Harness.fable.RetoldFacetingCacheKey.depSet(pContext, { DepSet: { Project: [ 'IDProject', 'Status' ] }, Aggs: [], Variants: {} });
										Expect(pContext.FilterAST.Entities).to.include('Client');
										Expect(tmpDeps.DepSet.Client).to.include('#cols');
										Expect(tmpDeps.DepSet.Project).to.include.members([ '#cols', 'IDCustomer', 'Deleted' ]);
										// Without Records, nothing is added.
										let tmpNoRecords = Object.assign({}, pContext, { NormalizedRequest: Object.assign({}, pContext.NormalizedRequest, { Records: null }) });
										Expect(_Harness.fable.RetoldFacetingCacheKey.depSet(tmpNoRecords, { DepSet: { Project: [ 'IDProject' ] } }).Entities).to.deep.equal([ 'Project' ]);
										Expect(_Harness.fable.RetoldFacetingCacheKey.depSet(null, null)).to.deep.equal({ DepSet: {}, Entities: [], TenantOnly: [], LabelTargets: [], Records: false });
										return fDone();
									});
							});
					}
				);

				suite
				(
					'Scope probes (internal-contracts §42.2)',
					() =>
					{
						test('one capture per entity on a scratch context: no SQL, the request\'s memo and counters untouched',
							(fDone) =>
							{
								planned(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
									(pError, pContext, pPlan) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										let tmpDeps = tmpCacheKey.depSet(pContext, pPlan);
										let tmpCounters = JSON.stringify(pContext.Counters);
										let tmpMemoCaptures = Object.keys(pContext.Memo.Captures).length;
										let tmpSpy = spyStatements(_Harness);
										tmpCacheKey.captureScopes(pContext, tmpDeps,
											(pProbeError, pProbe) =>
											{
												tmpSpy.restore();
												Expect(pProbeError).to.equal(null);
												Expect(tmpSpy.count(), 'probes run no SQL').to.equal(0);
												Expect(JSON.stringify(pContext.Counters)).to.equal(tmpCounters);
												Expect(Object.keys(pContext.Memo.Captures).length).to.equal(tmpMemoCaptures);
												Expect(Object.keys(pProbe.Captures).sort()).to.deep.equal(tmpDeps.Entities);
												Expect(pProbe.Uncacheable).to.deep.equal([]);
												Expect(pProbe.ProbeRuns).to.equal(tmpDeps.Entities.length);
												Expect(pProbe.ScopeRepaired).to.equal(false);
												tmpDeps.Entities.forEach(
													(pEntity) =>
													{
														let tmpCapture = pProbe.Captures[pEntity];
														Expect(tmpCapture.Fingerprint, pEntity).to.match(/^sf:[0-9a-f]{12}$/);
														Expect(tmpCapture.Opaque, pEntity).to.equal(false);
														Expect(tmpCapture.ScopeMode).to.equal('Inherit');
													});
												// The tenant entities' probes carry the policy predicate the behavior appended.
												Expect(pProbe.Captures.Project.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Value ]; })).to.deep.include([ 'IDCustomer', 1 ]);
												Expect(tmpCacheKey.cacheability(pContext, pPlan, tmpDeps, pProbe)).to.deep.equal({ Cacheable: true, Reason: null });
												// The spy does see SQL: the same request executed runs statements.
												let tmpExecutionSpy = spyStatements(_Harness);
												_Harness.query('Project', e1Body(_Harness.traps), Object.assign({ Now: TEST_NOW }, _Harness.as('Lead')),
													(pQueryError, pEnvelope) =>
													{
														tmpExecutionSpy.restore();
														Expect(pQueryError).to.equal(null);
														Expect(pEnvelope.Total).to.be.a('number');
														Expect(tmpExecutionSpy.count()).to.be.above(0);
														return fDone();
													});
											});
									});
							});

						test('an Opaque capture of a TrustedOpaque entity (a behavior that replaces the query) → Bypass Opaque, never an error',
							(fDone) =>
							{
								_Modes.Issue = 'override';
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Probe.Captures.Issue).to.deep.include({ Opaque: true, Trusted: true });
										Expect(pResult.Probe.Uncacheable).to.deep.equal([ { Entity: 'Issue', Reason: 'Opaque' } ]);
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'Opaque' });
										return fDone();
									});
							});

						test('a behavior 401 on a hop → Bypass ProbeError (the execution produces the real error)',
							(fDone) =>
							{
								_Modes.Issue = '401';
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Probe.Uncacheable).to.deep.equal([ { Entity: 'Issue', Reason: 'ProbeError' } ]);
										Expect(pResult.Probe.Captures).to.have.property('Project');
										Expect(pResult.Probe.Captures).to.not.have.property('Issue');
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'ProbeError' });
										return fDone();
									});
							});

						test('FacetCacheable === false on the request state (the determinism escape) → Bypass NotCacheable',
							(fDone) =>
							{
								_Modes.Issue = 'nocache';
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Probe.Uncacheable).to.deep.equal([ { Entity: 'Issue', Reason: 'NotCacheable' } ]);
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'NotCacheable' });
										return fDone();
									});
							});

						test('an untrusted read-side PostOperation makes the probe Opaque (the guard refuses it) → Bypass Opaque',
							(fDone) =>
							{
								let fRemove = addReadSideBehavior(_Harness, 'Issue', 'Reads-PostOperation');
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										fRemove();
										Expect(pError).to.equal(null);
										Expect(pResult.Probe.Captures, 'a refused capture is not a capture').to.not.have.property('Issue');
										Expect(pResult.Probe.Uncacheable).to.deep.equal([ { Entity: 'Issue', Reason: 'Opaque' } ]);
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'Opaque' });
										return fDone();
									});
							});

						test('a trusted PostOperation on the pivot: cacheable without Records, Bypass RecordsPostOperation with them',
							(fDone) =>
							{
								let fRemove = addReadSideBehavior(_Harness, 'Document', 'Reads-PostOperation');
								keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Probe.Captures.Document.PostOperation).to.deep.include({ Trusted: true, Opaque: false });
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: true, Reason: null });
										keyed(_Harness, 'Document', e2Body(_Harness.traps, true), _Harness.as('Lead'),
											(pRecordsError, pRecords) =>
											{
												fRemove();
												Expect(pRecordsError).to.equal(null);
												Expect(pRecords.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'RecordsPostOperation' });
												return fDone();
											});
									});
							});

						test('a controller-less or unknown entity → Bypass ProbeError',
							(fDone) =>
							{
								planned(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pContext, pPlan) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										let tmpHost = _Harness.faceting.Host;
										let fOriginal = tmpHost.getRouteBoundController;
										tmpHost.getRouteBoundController = function (pEntity) { return (pEntity === 'Issue') ? null : fOriginal.call(this, pEntity); };
										let tmpDeps = tmpCacheKey.depSet(pContext, pPlan);
										tmpCacheKey.captureScopes(pContext, tmpDeps,
											(pProbeError, pProbe) =>
											{
												tmpHost.getRouteBoundController = fOriginal;
												Expect(pProbeError).to.equal(null);
												Expect(pProbe.Uncacheable).to.deep.include({ Entity: 'Issue', Reason: 'ProbeError' });
												Expect(tmpCacheKey.cacheability(pContext, pPlan, tmpDeps, pProbe).Reason).to.equal('ProbeError');
												tmpCacheKey.captureScopes(pContext, { Entities: [ 'NoSuchEntity' ], DepSet: { NoSuchEntity: [] } },
													(pUnknownError, pUnknown) =>
													{
														Expect(pUnknownError).to.equal(null);
														Expect(pUnknown.Uncacheable).to.deep.equal([ { Entity: 'NoSuchEntity', Reason: 'ProbeError' } ]);
														tmpCacheKey.captureScopes({}, null,
															(pEmptyError, pEmpty) =>
															{
																Expect(pEmptyError).to.equal(null);
																Expect(pEmpty).to.deep.equal({ Captures: {}, Uncacheable: [], ProbeRuns: 0, ScopeRepaired: false });
																return fDone();
															});
													});
											});
									});
							});

						test('more DepSet entities than Limits.MaxRelationsPerRequest → no probes, Bypass TooManyEntities',
							(fDone) =>
							{
								planned(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
									(pError, pContext, pPlan) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										let tmpTight = Object.assign({}, pContext, { Options: libOptions.deepMerge(pContext.Options, { Limits: { MaxRelationsPerRequest: 2 } }) });
										let tmpDeps = tmpCacheKey.depSet(tmpTight, pPlan);
										tmpCacheKey.captureScopes(tmpTight, tmpDeps,
											(pProbeError, pProbe) =>
											{
												Expect(pProbeError).to.equal(null);
												Expect(pProbe).to.deep.equal({ Captures: {}, Uncacheable: [ { Entity: 'Project', Reason: 'TooManyEntities' } ], ProbeRuns: 0, ScopeRepaired: false });
												Expect(tmpCacheKey.cacheability(tmpTight, pPlan, tmpDeps, pProbe)).to.deep.equal({ Cacheable: false, Reason: 'TooManyEntities' });
												return fDone();
											});
									});
							});
					}
				);

				suite
				(
					'Cacheability (internal-contracts §42.3)',
					() =>
					{
						test('the pre-execution table, first reason wins: Mode, ForceEngine, PlanErrors before any probe reason',
							(fDone) =>
							{
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										let tmpContext = pResult.Context;
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: true, Reason: null });
										let tmpOpaqueProbe = Object.assign({}, pResult.Probe, { Uncacheable: [ { Entity: 'Issue', Reason: 'Opaque' } ] });
										let fReason = (pContext, pPlan, pProbe) => { return tmpCacheKey.cacheability(pContext, pPlan, pResult.Deps, pProbe).Reason; };
										Expect(fReason(Object.assign({}, tmpContext, { Mode: 'Records' }), pResult.Plan, tmpOpaqueProbe)).to.equal('Mode');
										Expect(fReason(Object.assign({}, tmpContext, { Mode: 'Count' }), pResult.Plan, pResult.Probe)).to.equal('Mode');
										Expect(fReason(Object.assign({}, tmpContext, { ForceEngine: 'Reference' }), pResult.Plan, tmpOpaqueProbe)).to.equal('ForceEngine');
										Expect(fReason(tmpContext, Object.assign({}, pResult.Plan, { Errors: { Bad: { Status: 403 } } }), tmpOpaqueProbe)).to.equal('PlanErrors');
										Expect(fReason(tmpContext, pResult.Plan, tmpOpaqueProbe)).to.equal('Opaque');
										Expect(fReason(tmpContext, pResult.Plan, Object.assign({}, pResult.Probe, { Uncacheable: [ { Entity: 'Issue', Reason: 'Opaque' }, { Entity: 'Project', Reason: 'ProbeError' } ] }))).to.equal('ProbeError');
										Expect(fReason(tmpContext, pResult.Plan, Object.assign({}, pResult.Probe, { Uncacheable: [ { Entity: 'Issue', Reason: 'NotCacheable' }, { Entity: 'Project', Reason: 'Opaque' } ] }))).to.equal('Opaque');
										// Fail closed: a probe that lacks a DepSet entity's capture, or no probe at all.
										let tmpPartial = { Captures: { Project: pResult.Probe.Captures.Project }, Uncacheable: [] };
										Expect(fReason(tmpContext, pResult.Plan, tmpPartial)).to.equal('ProbeError');
										Expect(fReason(tmpContext, pResult.Plan, null)).to.equal('ProbeError');
										Expect(tmpCacheKey.cacheability(tmpContext, pResult.Plan, null, pResult.Probe).Reason).to.equal('ProbeError');
										Expect(tmpCacheKey.precheck(tmpContext, pResult.Plan)).to.deep.equal({ Cacheable: true, Reason: null });
										Expect(tmpCacheKey.precheck(Object.assign({}, tmpContext, { ForceEngine: 'Reference' }), pResult.Plan)).to.deep.equal({ Cacheable: false, Reason: 'ForceEngine' });
										return fDone();
									});
							});

						test('a real per-facet planning error → PlanErrors',
							(fDone) =>
							{
								let tmpBody = unblockedBody();
								tmpBody.Facets.push({ Key: 'Nope', Facet: 'Project.NoSuchColumn' });
								keyed(_Harness, 'Project', tmpBody, _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(Object.keys(pResult.Plan.Errors)).to.deep.equal([ 'Nope' ]);
										Expect(pResult.Cacheability).to.deep.equal({ Cacheable: false, Reason: 'PlanErrors' });
										return fDone();
									});
							});
					}
				);

				suite
				(
					'Key material (internal-contracts §42.4)',
					() =>
					{
						test('shape: ck: + 64 hex, Short, ph: plan hash; deterministic; carries model, boot epoch, bind hash and every probe fingerprint',
							(fDone) =>
							{
								keyed(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
										Expect(pResult.Key).to.match(/^ck:[0-9a-f]{64}$/);
										Expect(pResult.Short).to.equal(pResult.Key.slice(0, 15));
										Expect(tmpCacheKey.planHash(pResult.Context)).to.match(/^ph:[0-9a-f]{16}$/);
										Expect(tmpCacheKey.key(pResult.Context, pResult.Plan, pResult.Probe).Key).to.equal(pResult.Key);
										let tmpMaterial = pResult.Material;
										Expect(tmpMaterial).to.include({ v: 1, Instance: 'main', EngineClass: 'Live', Entity: 'Project', Mode: 'Query', Gate: '' });
										Expect(tmpMaterial.Boot).to.equal(_Harness.fable.RetoldFacetingGenerations.BootEpoch);
										Expect(tmpMaterial.Model).to.equal(_Harness.fable.RetoldFacetingCatalog.modelVersion());
										Expect(tmpMaterial.Bind).to.equal(pResult.Plan.BindHash);
										Expect(tmpMaterial.Scope.map((pEntry) => { return pEntry[0]; })).to.deep.equal(pResult.Deps.Entities);
										tmpMaterial.Scope.forEach((pEntry) => { Expect(pEntry[1]).to.equal(pResult.Probe.Captures[pEntry[0]].Fingerprint); });
										Expect(tmpMaterial.Request).to.have.all.keys('Facets', 'Total', 'Scopes', 'Params', 'Records', 'Warnings');
										Expect(tmpMaterial.Client.length).to.equal(pResult.Context.FilterAST.Conjuncts.length);
										Expect(tmpMaterial.Client[0]).to.have.all.keys('Id', 'Origin', 'Shape', 'NeverExclude', 'Pred');
										Expect(tmpMaterial.PlanForm).to.deep.equal(pResult.Context.PlanForm);
										return fDone();
									});
							});

						test('never a SessionID or a request header: two sessions of one principal share the key',
							(fDone) =>
							{
								let tmpLead = _Harness.as('Lead');
								let tmpFirst = Object.assign({}, tmpLead, { SessionID: 'session-AAAA-1111', Headers: { cookie: 'SessionID=cookie-AAAA', authorization: 'Bearer token-AAAA', 'x-forwarded-for': '10.0.0.1' } });
								let tmpSecond = Object.assign({}, tmpLead, { SessionID: 'session-BBBB-2222', Headers: { cookie: 'SessionID=cookie-BBBB', authorization: 'Bearer token-BBBB', 'user-agent': 'other' } });
								keyed(_Harness, 'Document', e2Body(_Harness.traps, true), tmpFirst,
									(pError, pA) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Document', e2Body(_Harness.traps, true), tmpSecond,
											(pSecondError, pB) =>
											{
												Expect(pSecondError).to.equal(null);
												Expect(pB.Key).to.equal(pA.Key);
												let tmpText = JSON.stringify(pA.Material);
												[ 'session-AAAA', 'cookie-AAAA', 'token-AAAA', '10.0.0.1', 'SessionID', 'test-1-1' ].forEach((pSecret) => { Expect(tmpText, pSecret).to.not.include(pSecret); });
												return fDone();
											});
									});
							});

						test('same-tenant users share answers over tenant-only entities; a $CurrentUser binding splits them',
							(fDone) =>
							{
								keyed(_Harness, 'Document', e2Body(_Harness.traps, true), _Harness.as('Lead'),
									(pError, pLead) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Document', e2Body(_Harness.traps, true), _Harness.as('Member'),
											(pMemberError, pMember) =>
											{
												Expect(pMemberError).to.equal(null);
												Expect(pMember.Key, 'E2 binds nothing to the user').to.equal(pLead.Key);
												keyed(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Lead'),
													(pE1Error, pE1Lead) =>
													{
														Expect(pE1Error).to.equal(null);
														keyed(_Harness, 'Project', e1Body(_Harness.traps), _Harness.as('Member'),
															(pE1MemberError, pE1Member) =>
															{
																Expect(pE1MemberError).to.equal(null);
																Expect(pE1Member.Key, 'E1 binds $CurrentUser.IDUser').to.not.equal(pE1Lead.Key);
																Expect(pE1Member.Material.Bind).to.not.equal(pE1Lead.Material.Bind);
																return fDone();
															});
													});
											});
									});
							});

						test('a tenant switch under one session splits the key; so does another tenant',
							(fDone) =>
							{
								let tmpLead = _Harness.as('Lead');
								keyed(_Harness, 'Document', e2Body(_Harness.traps, false), Object.assign({}, tmpLead, { SessionID: 'one-session' }),
									(pError, pTenant1) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Document', e2Body(_Harness.traps, false), { Tenant: 2, User: tmpLead.User, SessionID: 'one-session' },
											(pSwitchError, pTenant2) =>
											{
												Expect(pSwitchError).to.equal(null);
												Expect(pTenant2.Key).to.not.equal(pTenant1.Key);
												keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('OtherLead'),
													(pOtherError, pOther) =>
													{
														Expect(pOtherError).to.equal(null);
														Expect(pOther.Key).to.not.equal(pTenant1.Key);
														// What splits them is the captured scope (the appended tenant value), not ScopeValues.
														Expect(pOther.Material.Scope).to.not.deep.equal(pTenant1.Material.Scope);
														Expect(JSON.stringify(pOther.Material)).to.not.include('ScopeValues');
														return fDone();
													});
											});
									});
							});

						test('clause Hashes, request facets and pinned buckets split the key; Freshness, TimeoutMS and extra body fields do not',
							(fDone) =>
							{
								let tmpLead = _Harness.as('Lead');
								let tmpBase = e2Body(_Harness.traps, false);
								let tmpHash = e2Body(_Harness.traps, false);
								tmpHash.Clauses[0].Hash = 'IDFormType-IJ-2';
								let tmpTop = e2Body(_Harness.traps, false);
								tmpTop.Facets[1].Top = 5;
								let tmpExtras = Object.assign(e2Body(_Harness.traps, false), { Freshness: { Mode: 'Exact' }, TimeoutMS: 5000, Experience: { ResultDestinationAddress: 'AppData.X' } });
								keyed(_Harness, 'Document', tmpBase, tmpLead,
									(pError, pBase) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Document', tmpHash, tmpLead,
											(pHashError, pHashed) =>
											{
												Expect(pHashError).to.equal(null);
												Expect(pHashed.Key, 'clause Hash').to.not.equal(pBase.Key);
												keyed(_Harness, 'Document', tmpTop, tmpLead,
													(pTopError, pTopped) =>
													{
														Expect(pTopError).to.equal(null);
														Expect(pTopped.Key, 'facet Top').to.not.equal(pBase.Key);
														keyed(_Harness, 'Document', tmpExtras, tmpLead,
															(pExtrasError, pExtra) =>
															{
																Expect(pExtrasError).to.equal(null);
																Expect(pExtra.Key, 'Freshness / TimeoutMS / Experience').to.equal(pBase.Key);
																return fDone();
															});
													});
											});
									});
							});

						test('$Now binds floored to Cache.NowBucketMS: another bucket splits E1',
							(fDone) =>
							{
								let tmpLead = _Harness.as('Lead');
								keyed(_Harness, 'Project', e1Body(_Harness.traps), Object.assign({}, tmpLead, { Now: '2026-10-08T12:00:00Z' }),
									(pError, pNoon) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Project', e1Body(_Harness.traps), Object.assign({}, tmpLead, { Now: '2026-10-08T12:05:00Z' }),
											(pLaterError, pLater) =>
											{
												Expect(pLaterError).to.equal(null);
												Expect(pLater.Material.Bind).to.not.equal(pNoon.Material.Bind);
												Expect(pLater.Key).to.not.equal(pNoon.Key);
												return fDone();
											});
									});
							});
					}
				);

				suite
				(
					'Dependencies and Version (internal-contracts §42.5, §42.6, §41.4)',
					() =>
					{
						test('per kind: the tenant entity reads its tenant and "*", the global lookup "*"; columns minus row columns plus #row / #all (#cols with Records)',
							(fDone) =>
							{
								keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										let tmpByEntity = {};
										pResult.Dependencies.forEach((pDependency) => { tmpByEntity[pDependency.Entity] = pDependency; });
										Expect(pResult.Dependencies.map((pDependency) => { return pDependency.Entity; })).to.deep.equal([ 'Document', 'FormType' ]);
										Expect(tmpByEntity.Document.TenantKeys).to.deep.equal([ '*', '1' ]);
										Expect(tmpByEntity.FormType.TenantKeys).to.deep.equal([ '*' ]);
										let tmpRowColumns = _Harness.faceting.Host.entityScopeColumns('Document').RowColumns;
										Expect(tmpRowColumns).to.include.members([ 'Deleted', 'IDCustomer', 'IDDocument' ]);
										let tmpExpected = pResult.Deps.DepSet.Document.filter((pColumn) => { return tmpRowColumns.indexOf(pColumn) < 0; }).concat([ '#row', '#all' ]).sort();
										Expect(tmpByEntity.Document.Columns).to.deep.equal(tmpExpected);
										Expect(tmpByEntity.Document.Columns).to.include.members([ 'DocumentDate', 'IDFormType', 'Status', '#row', '#all' ]);
										Expect(tmpByEntity.Document.Columns).to.not.include.members([ 'IDCustomer', 'Deleted', 'IDDocument', '#cols' ]);
										Expect(tmpByEntity.FormType.Columns).to.include.members([ 'Name', '#row', '#all' ]);
										keyed(_Harness, 'Document', e2Body(_Harness.traps, true), _Harness.as('Lead'),
											(pRecordsError, pRecords) =>
											{
												Expect(pRecordsError).to.equal(null);
												Expect(pRecords.Dependencies[0].Columns).to.include('#cols');
												// Granularity Entity: only #row and #all.
												let tmpEntity = Object.assign({}, pRecords.Context, { Options: libOptions.deepMerge(pRecords.Context.Options, { Cache: { GenerationGranularity: 'Entity' } }) });
												_Harness.fable.RetoldFacetingCacheKey.dependencies(tmpEntity, pRecords.Deps, pRecords.Probe).forEach(
													(pDependency) => { Expect(pDependency.Columns).to.deep.equal([ '#all', '#row' ]); });
												return fDone();
											});
									});
							});

						test('the columns a probe\'s behavior appended are dependencies too',
							(fDone) =>
							{
								_Modes.Issue = 'append';
								keyed(_Harness, 'Project', unblockedBody(), _Harness.as('Lead'),
									(pError, pResult) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResult.Cacheability.Cacheable).to.equal(true);
										Expect(pResult.Deps.DepSet.Issue).to.not.include('CreatingIDUser');
										let tmpIssue = pResult.Dependencies.filter((pDependency) => { return pDependency.Entity === 'Issue'; })[0];
										Expect(tmpIssue.Columns).to.include('CreatingIDUser');
										Expect(tmpIssue.Columns, 'the policy column is a row column').to.not.include('IDCustomer');
										return fDone();
									});
							});

						test('end to end with the generations: column precision, tenant isolation, a global lookup invalidates every tenant; Version follows the vector',
							(fDone) =>
							{
								let tmpGenerations = _Harness.fable.RetoldFacetingGenerations;
								let tmpCacheKey = _Harness.fable.RetoldFacetingCacheKey;
								keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('Lead'),
									(pError, pLead) =>
									{
										Expect(pError).to.equal(null);
										keyed(_Harness, 'Document', e2Body(_Harness.traps, false), _Harness.as('OtherLead'),
											(pOtherError, pOther) =>
											{
												Expect(pOtherError).to.equal(null);
												let fHashes = () => { return [ tmpGenerations.vector(pLead.Dependencies).Hash, tmpGenerations.vector(pOther.Dependencies).Hash ]; };
												let tmpHashes = fHashes();
												let tmpVersion = tmpCacheKey.version(pLead.Key, tmpHashes[0]);
												Expect(tmpVersion).to.match(/^fv1:[0-9a-f]{16}$/);
												let fApply = (pEvent) => { tmpGenerations.applyChange(Object.assign({ Source: 'Notify', IDs: [], Owners: null, KeyImages: {}, Seq: null }, pEvent)); };

												fApply({ Entity: 'Document', Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Title', 'Summary' ] });
												Expect(fHashes(), 'a Title edit invalidates no Status / date / form facet').to.deep.equal(tmpHashes);
												fApply({ Entity: 'Project', Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Status' ] });
												Expect(fHashes(), 'an entity outside the DepSet').to.deep.equal(tmpHashes);

												fApply({ Entity: 'Document', Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate' ] });
												let tmpAfterStatus = fHashes();
												Expect(tmpAfterStatus[0], 'tenant 1 Status edit: tenant 1').to.not.equal(tmpHashes[0]);
												Expect(tmpAfterStatus[1], 'tenant 1 Status edit: never tenant 2').to.equal(tmpHashes[1]);
												Expect(tmpCacheKey.version(pLead.Key, tmpAfterStatus[0])).to.not.equal(tmpVersion);

												fApply({ Entity: 'Document', Operation: 'Create', Tenants: [ 2 ] });
												let tmpAfterCreate = fHashes();
												Expect(tmpAfterCreate[0], 'tenant 2 create: never tenant 1').to.equal(tmpAfterStatus[0]);
												Expect(tmpAfterCreate[1]).to.not.equal(tmpAfterStatus[1]);

												fApply({ Entity: 'FormType', Operation: 'Update', Tenants: [ '*' ], ChangedColumns: [ 'Name' ] });
												let tmpAfterLabel = fHashes();
												Expect(tmpAfterLabel[0], 'a global lookup label edit: tenant 1').to.not.equal(tmpAfterCreate[0]);
												Expect(tmpAfterLabel[1], 'a global lookup label edit: tenant 2').to.not.equal(tmpAfterCreate[1]);

												// Stable otherwise.
												Expect(fHashes()).to.deep.equal(tmpAfterLabel);
												Expect(tmpCacheKey.version(pLead.Key, fHashes()[0])).to.equal(tmpCacheKey.version(pLead.Key, tmpAfterLabel[0]));
												return fDone();
											});
									});
							});
					}
				);
			}
		);

		suite
		(
			'LabTrack (personal scopes, TenantOnly)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'LabTrack' }, fDone);
				});

				suiteTeardown((fDone) =>
				{
					if (!_Harness)
					{
						return fDone();
					}
					_Harness.stop(fDone);
				});

				test('an owner-scoped entity splits the key between colleagues; its fold reads owner-qualified keys',
					(fDone) =>
					{
						keyed(_Harness, 'LabForm', labFormBody(), _Harness.as('Tech'),
							(pError, pTech) =>
							{
								Expect(pError).to.equal(null);
								Expect(pTech.Cacheability).to.deep.equal({ Cacheable: true, Reason: null });
								keyed(_Harness, 'LabForm', labFormBody(), _Harness.as('Colleague'),
									(pColleagueError, pColleague) =>
									{
										Expect(pColleagueError).to.equal(null);
										Expect(pColleague.Key).to.not.equal(pTech.Key);
										let tmpTech = _Harness.as('Tech');
										Expect(pTech.Dependencies[0]).to.deep.include({ Entity: 'LabForm', TenantKeys: [ '*', `${tmpTech.Tenant}/*`, `${tmpTech.Tenant}/${tmpTech.User}` ] });
										Expect(pTech.Dependencies[0].Columns, 'the owner column is a row column').to.not.include('OwnerIDUser');
										// A colleague's write never moves Tech's vector; Tech's own does.
										let tmpGenerations = _Harness.fable.RetoldFacetingGenerations;
										let tmpHash = tmpGenerations.vector(pTech.Dependencies).Hash;
										tmpGenerations.applyChange({ Entity: 'LabForm', Operation: 'Update', Tenants: [ tmpTech.Tenant ], Owners: [ { Tenant: tmpTech.Tenant, Owner: _Harness.as('Colleague').User } ], ChangedColumns: [ 'Status' ] });
										Expect(tmpGenerations.vector(pTech.Dependencies).Hash).to.equal(tmpHash);
										tmpGenerations.applyChange({ Entity: 'LabForm', Operation: 'Update', Tenants: [ tmpTech.Tenant ], Owners: [ { Tenant: tmpTech.Tenant, Owner: tmpTech.User } ], ChangedColumns: [ 'Status' ] });
										Expect(tmpGenerations.vector(pTech.Dependencies).Hash).to.not.equal(tmpHash);
										return fDone();
									});
							});
					});

				test('E3: a TenantOnly hop is reported, and that entity is read tenant-wide (a colleague\'s completion invalidates it)',
					(fDone) =>
					{
						keyed(_Harness, 'MaterialIntakeRequirement', e3aBody(), _Harness.as('Tech'),
							(pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.Deps.TenantOnly).to.deep.equal([ 'LabForm' ]);
								Expect(pResult.Deps.Entities).to.include.members([ 'LabForm', 'LabFormType', 'MaterialIntake', 'MaterialIntakeRequirement' ]);
								Expect(pResult.Cacheability).to.deep.equal({ Cacheable: true, Reason: null });
								let tmpTech = _Harness.as('Tech');
								let tmpLabForm = pResult.Dependencies.filter((pDependency) => { return pDependency.Entity === 'LabForm'; })[0];
								Expect(tmpLabForm.TenantKeys).to.deep.equal([ '*', String(tmpTech.Tenant) ]);
								let tmpGenerations = _Harness.fable.RetoldFacetingGenerations;
								let tmpHash = tmpGenerations.vector(pResult.Dependencies).Hash;
								tmpGenerations.applyChange({ Entity: 'LabForm', Operation: 'Update', Tenants: [ tmpTech.Tenant ], Owners: [ { Tenant: tmpTech.Tenant, Owner: _Harness.as('Colleague').User } ], ChangedColumns: [ 'Status', 'CompletedDate' ] });
								Expect(tmpGenerations.vector(pResult.Dependencies).Hash).to.not.equal(tmpHash);
								tmpHash = tmpGenerations.vector(pResult.Dependencies).Hash;
								tmpGenerations.applyChange({ Entity: 'LabForm', Operation: 'Update', Tenants: [ _Harness.as('OtherTech').Tenant ], Owners: [ { Tenant: _Harness.as('OtherTech').Tenant, Owner: _Harness.as('OtherTech').User } ], ChangedColumns: [ 'Status' ] });
								Expect(tmpGenerations.vector(pResult.Dependencies).Hash, 'another tenant never').to.equal(tmpHash);
								return fDone();
							});
					});
			}
		);
	}
);
