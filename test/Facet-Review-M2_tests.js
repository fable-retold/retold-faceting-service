/**
 * Facet-Review-M2 (the M2 review fixes, end to end over the real pipeline): every finding of the M2
 * review that a request can observe, as a regression test on the ProjectTrack / LabTrack domains.
 *
 *   - the read-side Pre/PostOperation audit (06 §3.5): an entity whose Reads-PostOperation filters or
 *     redacts rows is Opaque for facets — the pivot of Query / Records / Count / Keys and every hop —
 *     unless the host vouches for it (Scope.TrustPostOperation) or the relation reads only
 *     Scope.PostOperationSafeColumns; Describe reports why; Records hydration shares ONE request
 *     state between Reads-QueryConfiguration and Reads-PostOperation (as the list waterfall does);
 *   - host behaviors that rewrite client operators (LIKE → NOT LIKE here): the cube flags and every
 *     PredicateFragment honor the rewrite (O1 and O5, Records/Count == Total);
 *   - path facets whose hops carry a step Where (K8, K9 bridge form) have NO bucket Clause (a join
 *     clause cannot carry the Where), while the bare paths keep theirs (O2);
 *   - client-named join entities are gated before any edge lookup (a hidden entity and a missing one
 *     are the same 403); a PathAuto FacetID over a hidden target is the same 400 as a missing path;
 *     unknown PathAuto FacetIDs are never cached;
 *   - integer clause values outside the column's range are 400s (never a database error);
 *   - the Records ETag covers the hydrated content; BindHash covers a scope referenced twice;
 *   - a TuplePivot whose Home side is declared second answers like the declared-first one;
 *   - TenantOnly over an entity whose only policy column is its personal scope is refused at load;
 *   - the statement budget of the motivating queries (one cube statement + one per label target, no
 *     cube fallback) and, on SQLite, the query plans: every correlated hop probe is an index search
 *     on the correlation column (never a scan, never the tenancy index);
 *   - hand-written SQL oracles for lowering constructs the Reference shares with Live (HavingCount
 *     EQ, Not push-down, CheckParent forcing, ExternalJoin*), independent of the FoldIR.
 *
 * SQLite always; PostgreSQL too when RFS_TEST_POSTGRES=1 (or RFS_TEST_POSTGRES_URL) is set.
 *
 * Port 19129 (internal-contracts §32.4); every harness binds an ephemeral port.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');

const PORT = 19129;

const TEST_NOW = '2026-10-08T12:00:00Z';

const POSTGRES = libProviders.available('PostgreSQL');

const PROVIDERS =
	[
		{ Provider: 'SQLite', Ready: true, Reason: null },
		{ Provider: 'PostgreSQL', Ready: POSTGRES.Available, Reason: POSTGRES.Reason }
	];

// Review definitions loaded beside the ProjectTrack domain file (Definitions.Objects).
const PROJECT_REVIEW_DEFINITIONS =
	{
		FormatVersion: 1,
		Scopes:
			{
				// A column leaf under Any with an existence node: rendered as a PredicateFragment.
				'Project.NameAOrNoIssue':
					{
						Entity: 'Project',
						Where: [ { Any: [ { Field: 'Name', Op: 'LK', Value: '%a%' }, { NotExists: { Path: [ '<Issue.IDProject' ] } } ] } ]
					},
				// K19 with '=': exactly two visible open issues.
				'Project.TwoOpenIssues':
					{
						Entity: 'Project',
						Where: [ { HavingCount: { Path: [ '<Issue.IDProject' ], Where: [ { Field: 'State', Op: 'EQ', Value: 'Open' } ], Op: 'EQ', Value: 2 } } ]
					},
				// Not push-down: Not(Any[Status = Done, Exists blocker]) → Status <> Done (NULL fails) AND NotExists.
				'Project.NotDoneNorBlocked':
					{
						Entity: 'Project',
						Where: [ { Not: { Any: [ { Field: 'Status', Op: 'EQ', Value: 'Done' }, { Exists: { Path: [ '<Issue.IDProject' ], Where: [ { Field: 'Severity', Op: 'EQ', Value: 'Blocker' } ] } } ] } } ]
					},
				// Co-reference from Task to the Documents of its project: CheckParent is forced (Project has
				// a delete column and a tenancy column), so a soft-deleted parent project hides its documents.
				'Task.ProjectHasFinalDocs':
					{
						Entity: 'Task',
						Where: [ { Exists: { Path: [ '=Document.IDProject' ], Where: [ { Field: 'Status', Op: 'EQ', Value: 'Final' } ] } } ]
					}
			},
		Facets:
			[
				{ Facet: 'Document.OpenProjectClient', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ { Step: '>Document.IDProject', Where: [ { Field: 'Status', Op: 'NE', Value: 'Done' } ] } ], Field: 'IDClient' } ] },
				{ Facet: 'Document.ProjectClient', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '>Document.IDProject' ], Field: 'IDClient' } ] },
				{ Facet: 'Project.ActiveMemberUser', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ { Step: '<ProjectMembership.IDProject', Where: [ { Field: 'Active', Op: 'EQ', Value: 1 } ] }, '>ProjectMembership.IDUser' ], KeyField: 'IDUser' } ] },
				{ Facet: 'Project.AnyMemberUser', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '<ProjectMembership.IDProject', '>ProjectMembership.IDUser' ], KeyField: 'IDUser' } ] }
			]
	};

// E3B with its tuple sides declared in the other order (the Home side second).
const LAB_REVIEW_DEFINITIONS =
	{
		FormatVersion: 1,
		Facets:
			[
				{
					Facet: 'MaterialIntake.FormsToDoSwapped',
					Version: 1,
					Home: 'MaterialIntake',
					Pivot:
						{
							Tuple:
								{
									From:
										[
											{ As: 'r', Entity: 'MaterialTypeFormRequirement', Where: [ { Field: 'Required', Op: 'EQ', Value: 1 } ] },
											{ As: 'i', Entity: 'MaterialIntake', Where: [ { Scope: 'MaterialIntake.InMyQueues' } ] }
										],
									On: [ [ 'r.IDMaterialType', 'i.IDMaterialType' ] ],
									Key: [ 'i.IDMaterialIntake', 'r.IDLabFormType' ]
								}
						},
					Where:
						[
							{ NotExists: { From: 'i', Path: [ { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'Any technician\'s completed form satisfies the requirement.' } ],
							               Where: [ { Field: 'Status', Op: 'EQ', Value: 'Complete' } ],
							               Correlate: [ [ 'r.IDLabFormType', 'IDLabFormType' ] ] } }
						],
					Dimensions: [ { Kind: 'Terms', Field: 'r.IDLabFormType' } ],
					Siblings: { ByQueue: { Kind: 'Terms', Field: 'i.IDLabQueue' } }
				}
			]
	};

/**
 * Run steps one after the other: each step is (fNext) => …; an error stops the series.
 *
 * @param {Array<(fNext: (pError?: Error) => void) => void>} pSteps
 * @param {(pError?: Error) => void} fDone
 */
const series = (pSteps, fDone) =>
{
	let fNext = (pIndex) =>
	{
		if (pIndex >= pSteps.length)
		{
			return fDone();
		}
		return pSteps[pIndex]((pError) => { return pError ? fDone(pError) : fNext(pIndex + 1); });
	};
	return fNext(0);
};

/**
 * Rows of one SQL statement on the harness database (identifiers double-quoted: SQLite and PostgreSQL).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pSQL
 * @param {(pError?: Error, pRows?: Array<Record<string, any>>) => void} fCallback
 */
const sqlRows = (pHarness, pSQL, fCallback) =>
{
	if (pHarness.connection.Provider === 'PostgreSQL')
	{
		return pHarness.connection.pool.query(pSQL, [], (pError, pResult) => { setImmediate(() => { return pError ? fCallback(pError) : fCallback(null, pResult.rows); }); });
	}
	let tmpRows;
	try
	{
		tmpRows = pHarness.db.prepare(pSQL).all().map((pRow) => { return Object.assign({}, pRow); });
	}
	catch (pError)
	{
		return fCallback(pError);
	}
	return setImmediate(() => { fCallback(null, tmpRows); });
};

/**
 * The single count of a SQL count statement.
 */
const sqlCount = (pHarness, pSQL, fCallback) =>
{
	sqlRows(pHarness, pSQL, (pError, pRows) => { return pError ? fCallback(pError) : fCallback(null, Number(pRows[0].N)); });
};

/**
 * "visible to tenant t": live and in the tenant.
 */
const visible = (pAlias, pTenant) =>
{
	return `"${pAlias}"."Deleted" = 0 AND "${pAlias}"."IDCustomer" = ${pTenant}`;
};

// Restore functions of the current test (run by every suite's teardown, so a failing assertion never
// leaves a behavior or an option behind for the next test).
let _Restores = [];

/**
 * Run (and forget) every pending restore, newest first.
 */
const restoreAll = () =>
{
	let tmpRestores = _Restores.reverse();
	_Restores = [];
	tmpRestores.forEach((fRestore) => { fRestore(); });
};

/**
 * Replace (or remove) one behavior of one entity's route-bound controller; returns the restore function
 * (also registered for the suite teardown).  fBehavior is chain-wrapped AFTER the existing behavior
 * (the tenancy), exactly like installBehavior.
 */
const swapBehavior = (pHarness, pEntity, pHash, fBehavior) =>
{
	let tmpFunctions = pHarness.fable.MeadowEndpoints[pEntity].controller.BehaviorInjection._BehaviorFunctions;
	let tmpHad = Object.prototype.hasOwnProperty.call(tmpFunctions, pHash);
	let tmpOriginal = tmpFunctions[pHash];
	pHarness.installBehavior(pEntity, pHash, fBehavior);
	let tmpRestored = false;
	let fRestore = () =>
	{
		if (tmpRestored)
		{
			return;
		}
		tmpRestored = true;
		if (tmpHad)
		{
			tmpFunctions[pHash] = tmpOriginal;
		}
		else
		{
			delete tmpFunctions[pHash];
		}
	};
	_Restores.push(fRestore);
	return fRestore;
};

/**
 * Temporarily change one Scope option of the faceting service (contexts read the live options).
 */
const withScopeOption = (pHarness, pKey, pValue) =>
{
	let tmpScope = pHarness.faceting.options.Scope;
	let tmpOriginal = tmpScope[pKey];
	tmpScope[pKey] = pValue;
	let tmpRestored = false;
	let fRestore = () =>
	{
		if (!tmpRestored)
		{
			tmpRestored = true;
			tmpScope[pKey] = tmpOriginal;
		}
	};
	_Restores.push(fRestore);
	return fRestore;
};

const expect500 = (pResponse, pLabel) =>
{
	Expect(pResponse.Status, `${pLabel}: ${JSON.stringify(pResponse.Body).slice(0, 300)}`).to.equal(500);
	Expect(pResponse.Body.Error.Code, pLabel).to.equal('FACET_SCOPE_POLICY_VIOLATION');
	Expect(pResponse.Body.Error, pLabel).to.not.have.property('Detail');
};

/**
 * Capture every SQL text the SQLite provider prepares while fRun runs.
 */
const captureSQL = (pHarness, fRun, fDone) =>
{
	let tmpStatements = [];
	let tmpPrepare = pHarness.db.prepare;
	pHarness.db.prepare = function (pSQL)
	{
		tmpStatements.push(pSQL);
		return tmpPrepare.call(this, pSQL);
	};
	fRun(
		(pError) =>
		{
			pHarness.db.prepare = tmpPrepare;
			return fDone(pError, tmpStatements);
		});
};

/**
 * EXPLAIN QUERY PLAN rows (detail text) of every SELECT captured.
 */
const queryPlans = (pHarness, pStatements) =>
{
	return pStatements.filter((pSQL) => { return /^\s*SELECT/i.test(pSQL); }).map(
		(pSQL) =>
		{
			return pHarness.db.prepare(`EXPLAIN QUERY PLAN ${pSQL}`).all().map((pRow) => { return String(pRow.detail); });
		});
};

suite
(
	'Facet-Review-M2',
	() =>
	{
		PROVIDERS.forEach(
			(pProvider) =>
			{
				(pProvider.Ready ? suite : suite.skip)
				(
					`${pProvider.Provider}${pProvider.Ready ? '' : ` (skipped: ${pProvider.Reason})`}`,
					function ()
					{
						this.timeout(120000);

						// ======================================================== ProjectTrack
						suite
						(
							'ProjectTrack',
							() =>
							{
								let _H = null;
								suiteSetup((fDone) =>
								{
									_H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider, Faceting: { Definitions: { Objects: [ PROJECT_REVIEW_DEFINITIONS ] } } },
										(pError) =>
										{
											if (pError)
											{
												return fDone(pError);
											}
											// Every review definition loads (a disabled one would fail every test below).
											Expect(_H.fable.RetoldFacetingDefinitionRegistry.disabled()).to.deep.equal([]);
											return fDone();
										});
								});
								suiteTeardown((fDone) => { return _H ? _H.stop(() => { fDone(); }) : fDone(); });
								teardown(restoreAll);

								test('PostOperation on a HOP: a Reads-PostOperation that hides rows makes the hop Opaque (500), never a count of hidden rows',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fRestore = swapBehavior(_H, 'Issue', 'Reads-PostOperation',
											function (pRequest, pState, fCallback)
											{
												pState.Records = (pState.Records || []).filter((pRecord) => { return pRecord.Severity !== 'Blocker'; });
												return fCallback();
											});
										let tmpBody = { Scopes: [ { Scope: 'Project.Unblocked' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] };
										series(
											[
												(fNext) => { _H.facetQuery('Project', tmpBody, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Query'); return fNext(pError); }); },
												(fNext) => { _H.recordsCount('Project', { Scopes: tmpBody.Scopes }, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Records/Count'); return fNext(pError); }); },
												(fNext) => { _H.keys('Project', { Scopes: tmpBody.Scopes }, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Keys'); return fNext(pError); }); },
												(fNext) =>
												{
													// Without the scope the Issue hop is not read: the request answers.
													_H.facetQuery('Project', { Facets: tmpBody.Facets }, tmpLead, (pError, pResponse) => { Expect(pResponse.Status).to.equal(200); return fNext(pError); });
												}
											],
											(pError) => { fRestore(); return fDone(pError); });
									});

								test('PostOperation on the PIVOT: Query, Records (no Dropped header), Count and Keys are refused; Describe says why',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fRestore = swapBehavior(_H, 'Project', 'Reads-PostOperation',
											function (pRequest, pState, fCallback)
											{
												pState.Records = (pState.Records || []).filter((pRecord) => { return pRecord.Status !== 'AtRisk'; });
												return fCallback();
											});
										series(
											[
												(fNext) => { _H.facetQuery('Project', { Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] }, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Query'); return fNext(pError); }); },
												(fNext) =>
												{
													_H.records('Project', { Records: { Begin: 0, Cap: 50 } }, tmpLead,
														(pError, pResponse) =>
														{
															expect500(pResponse, 'Records');
															Expect(pResponse.Headers).to.not.have.property('x-retold-facet-records-dropped');
															return fNext(pError);
														});
												},
												(fNext) => { _H.recordsCount('Project', {}, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Records/Count'); return fNext(pError); }); },
												(fNext) => { _H.keys('Project', {}, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Keys'); return fNext(pError); }); },
												(fNext) =>
												{
													_H.request('GET', '/1.0/Facet/Describe', null, tmpLead,
														(pError, pResponse) =>
														{
															Expect(pResponse.Status).to.equal(200);
															Expect(pResponse.Body.Entities.Project.Opaque).to.deep.equal({ Reason: 'PostOperation', SafeColumns: null });
															Expect(pResponse.Body.Entities.Task).to.be.an('object');
															Expect(pResponse.Body.Entities.Task).to.not.have.property('Opaque');
															return fNext(pError);
														});
												}
											],
											(pError) => { fRestore(); return fDone(pError); });
									});

								test('TrustPostOperation: a decorating PostOperation is vouched for — Live == Reference, and Records carry the decoration',
									function (fDone)
									{
										let tmpLead = Object.assign({ Now: TEST_NOW }, _H.as('Lead'));
										let fRestore = swapBehavior(_H, 'Project', 'Reads-PostOperation',
											function (pRequest, pState, fCallback)
											{
												(pState.Records || []).forEach((pRecord) => { pRecord.FacetReviewDecoration = 'decorated'; });
												return fCallback();
											});
										let fRestoreTrust = withScopeOption(_H, 'TrustPostOperation', [ 'Project' ]);
										let tmpBody = { Scopes: [ { Scope: 'Project.Unblocked' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient' } ] };
										series(
											[
												(fNext) =>
												{
													_H.compareInProcess('Project', tmpBody, tmpLead,
														(pError, pResult) =>
														{
															Expect(pError).to.not.exist;
															Expect(pResult.Live.Errors).to.deep.equal({});
															Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
															return fNext();
														});
												},
												(fNext) =>
												{
													_H.records('Project', { Scopes: tmpBody.Scopes, Records: { Begin: 0, Cap: 20 } }, tmpLead,
														(pError, pResponse) =>
														{
															Expect(pResponse.Status).to.equal(200);
															Expect(pResponse.Body.length).to.be.above(0);
															pResponse.Body.forEach((pRecord) => { Expect(pRecord.FacetReviewDecoration).to.equal('decorated'); });
															return fNext(pError);
														});
												}
											],
											(pError) => { fRestoreTrust(); fRestore(); return fDone(pError); });
									});

								test('PostOperationSafeColumns: a facet reading only listed columns answers; one reading an unlisted column is refused',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fRestore = swapBehavior(_H, 'Project', 'Reads-PostOperation',
											function (pRequest, pState, fCallback)
											{
												// Redacts Name only (the host lists the columns it never touches).
												(pState.Records || []).forEach((pRecord) => { pRecord.Name = null; });
												return fCallback();
											});
										let fRestoreSafe = withScopeOption(_H, 'PostOperationSafeColumns', { Project: [ 'IDProject', 'Status' ] });
										series(
											[
												(fNext) =>
												{
													_H.facetQuery('Project', { Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] }, tmpLead,
														(pError, pResponse) =>
														{
															Expect(pResponse.Status, JSON.stringify(pResponse.Body).slice(0, 300)).to.equal(200);
															Expect(pResponse.Body.Total).to.be.above(0);
															return fNext(pError);
														});
												},
												// The pivot relation of a Name facet reads Name: the whole request is refused (the pivot is the request's).
												(fNext) => { _H.facetQuery('Project', { Facets: [ { Key: 'Name', Facet: 'Project.Name', Fold: 'Terms' } ] }, tmpLead, (pError, pResponse) => { expect500(pResponse, 'Name facet'); return fNext(pError); }); },
												(fNext) =>
												{
													_H.request('GET', '/1.0/Facet/Project/Describe', null, tmpLead,
														(pError, pResponse) =>
														{
															Expect(pResponse.Body.Entities.Project.Opaque).to.deep.equal({ Reason: 'PostOperation', SafeColumns: [ 'IDProject', 'Status' ] });
															return fNext(pError);
														});
												}
											],
											(pError) => { fRestoreSafe(); fRestore(); return fDone(pError); });
									});

								test('Records hydration shares ONE request state between Reads-QueryConfiguration and Reads-PostOperation (as the list)',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fRestoreQuery = swapBehavior(_H, 'Project', 'Reads-QueryConfiguration',
											function (pRequest, pState, fCallback)
											{
												pState.FacetReviewMarker = 'shared';
												return fCallback();
											});
										let fRestorePost = swapBehavior(_H, 'Project', 'Reads-PostOperation',
											function (pRequest, pState, fCallback)
											{
												(pState.Records || []).forEach((pRecord) => { pRecord.FacetReviewMarker = pState.FacetReviewMarker || 'missing'; });
												return fCallback();
											});
										let fRestoreTrust = withScopeOption(_H, 'TrustPostOperation', [ 'Project' ]);
										_H.listRows('Project', null, tmpLead,
											(pListError, pList) =>
											{
												Expect(pListError).to.not.exist;
												_H.records('Project', { Records: { Begin: 0, Cap: 500 } }, tmpLead,
													(pError, pResponse) =>
													{
														fRestoreTrust();
														fRestorePost();
														fRestoreQuery();
														Expect(pResponse.Status).to.equal(200);
														Expect(pResponse.Body.length).to.equal(pList.length);
														pResponse.Body.forEach((pRecord) => { Expect(pRecord.FacetReviewMarker).to.equal('shared'); });
														Expect(pList.every((pRecord) => { return pRecord.FacetReviewMarker === 'shared'; })).to.equal(true);
														return fDone(pError);
													});
											});
									});

								test('a behavior that rewrites client operators (LIKE → NOT LIKE): the cube falls back, every plan form equals the Reference, Total == Records/Count',
									function (fDone)
									{
										let fTransform = function (pRequest, pState, fCallback)
										{
											pState.Query.parameters.filter.forEach((pEntry) => { if (pEntry.Operator === 'LIKE') { pEntry.Operator = 'NOT LIKE'; } });
											return fCallback();
										};
										let fRestoreReads = swapBehavior(_H, 'Project', 'Reads-QueryConfiguration', fTransform);
										let fRestoreCount = swapBehavior(_H, 'Project', 'Count-QueryConfiguration', fTransform);
										let tmpLead = _H.as('Lead');
										let tmpBody = { FilterString: 'FBV~Name~LK~%25a%25', Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Name', Facet: 'Project.Name', Fold: 'Terms', Top: 100 } ], Total: true };
										let tmpTotals = [];
										let fForm = (pForm) =>
										{
											return (fNext) =>
											{
												_H.compareInProcess('Project', tmpBody, Object.assign({ Now: TEST_NOW, PlanForm: { Cube: pForm } }, tmpLead),
													(pError, pResult) =>
													{
														Expect(pError).to.not.exist;
														Expect(pResult.Live.Errors, pForm).to.deep.equal({});
														Expect(pResult.LiveNormalized, `${pForm}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
														if (pForm !== 'Never')
														{
															Expect(pResult.LiveMeta.CubeFallbacks, `${pForm}: the transformed flag makes the cube fall back`).to.deep.equal([ 'cube0' ]);
														}
														tmpTotals.push(pResult.Live.Total);
														return fNext();
													});
											};
										};
										series(
											[
												fForm('Never'), fForm('Auto'), fForm('Always'),
												(fNext) =>
												{
													_H.recordsCount('Project', { FilterString: tmpBody.FilterString }, tmpLead,
														(pError, pResponse) =>
														{
															Expect(pResponse.Body).to.deep.equal({ Count: tmpTotals[0] });
															Expect(tmpTotals).to.deep.equal([ tmpTotals[0], tmpTotals[0], tmpTotals[0] ]);
															return fNext(pError);
														});
												},
												(fNext) =>
												{
													// A scope's column leaf under Any is a PredicateFragment: it honors the rewrite too.
													_H.compareInProcess('Project', { Scopes: [ { Scope: 'Project.NameAOrNoIssue' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] }, Object.assign({ Now: TEST_NOW }, tmpLead),
														(pError, pResult) =>
														{
															Expect(pError).to.not.exist;
															Expect(pResult.Live.Errors).to.deep.equal({});
															Expect(pResult.LiveNormalized, 'scope Any column leaf: Live == Reference').to.deep.equal(pResult.ReferenceNormalized);
															return fNext();
														});
												}
											],
											(pError) => { fRestoreCount(); fRestoreReads(); return fDone(pError); });
									});

								test('path facets: a step Where (K8) or a bridge step Where (K9) leaves the bucket without a Clause; the bare paths keep theirs (O1, O2)',
									function (fDone)
									{
										let tmpLead = Object.assign({ Now: TEST_NOW }, _H.as('Lead'));
										let fCheck = (pEntity, pBody, fChecks) =>
										{
											return (fNext) =>
											{
												_H.compareInProcess(pEntity, pBody, tmpLead,
													(pError, pResult) =>
													{
														Expect(pError).to.not.exist;
														Expect(pResult.Live.Errors).to.deep.equal({});
														Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
														fChecks(pResult.Live);
														_H.assertSelectionRoundTrip(pEntity, pBody, pResult.Live, tmpLead,
															(pRoundTripError, pReport) =>
															{
																Expect(pRoundTripError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
																return fNext();
															});
													});
											};
										};
										series(
											[
												fCheck('Document', { Facets: [ { Key: 'Open', Facet: 'Document.OpenProjectClient' }, { Key: 'Bare', Facet: 'Document.ProjectClient' } ] },
													(pEnvelope) =>
													{
														let tmpOpen = pEnvelope.Facets.Open.Buckets.filter((pBucket) => { return pBucket.Key !== null; });
														Expect(tmpOpen.length).to.be.above(0);
														tmpOpen.forEach((pBucket) => { Expect(pBucket.Clause, `Open ${pBucket.Key}`).to.equal(null); });
														Expect(pEnvelope.Facets.Bare.Buckets.filter((pBucket) => { return pBucket.Clause && (pBucket.Clause.Type === 'InternalJoinMatch'); }).length).to.be.above(0);
													}),
												fCheck('Project', { Facets: [ { Key: 'Active', Facet: 'Project.ActiveMemberUser' }, { Key: 'Any', Facet: 'Project.AnyMemberUser' } ] },
													(pEnvelope) =>
													{
														Expect(pEnvelope.Facets.Active.Buckets.length).to.be.above(0);
														pEnvelope.Facets.Active.Buckets.forEach((pBucket) => { Expect(pBucket.Clause, `Active ${pBucket.Key}`).to.equal(null); });
														Expect(pEnvelope.Facets.Any.Buckets.filter((pBucket) => { return pBucket.Clause && (pBucket.Clause.Type === 'ExternalJoinSelectedValueList'); }).length).to.be.above(0);
													})
											],
											fDone);
									});

								test('integer clause values outside the column range are 400 FACET_FILTER_INVALID on every dialect (never a statement error)',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fBad = (pFilterString) =>
										{
											return (fNext) =>
											{
												_H.recordsCount('Project', { FilterString: pFilterString }, tmpLead,
													(pError, pResponse) =>
													{
														Expect(pResponse.Status, `${pFilterString}: ${JSON.stringify(pResponse.Body)}`).to.equal(400);
														Expect(pResponse.Body.Error).to.include({ Code: 'FACET_FILTER_INVALID' });
														Expect(pResponse.Body.Error.Detail).to.include({ Reason: 'InvalidNumber' });
														return fNext(pError);
													});
											};
										};
										series(
											[
												fBad('FBV~IDClient~EQ~1e300'),
												fBad('FBV~IDClient~EQ~99999999999999999999'),
												fBad('FBV~IDClient~GT~2147483648'),
												(fNext) =>
												{
													_H.recordsCount('Project', { FilterString: 'FBV~IDClient~LT~2147483647' }, tmpLead,
														(pError, pResponse) => { Expect(pResponse.Status).to.equal(200); return fNext(pError); });
												}
											],
											fDone);
									});

								test('the Records ETag covers the hydrated records: a changed record with the same keys gets a new ETag',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let tmpBody = { Records: { Begin: 0, Cap: 5 } };
										_H.records('Project', tmpBody, tmpLead,
											(pError, pFirst) =>
											{
												Expect(pFirst.Status).to.equal(200);
												let tmpTarget = pFirst.Body[0];
												let tmpName = tmpTarget.Name;
												let fSetName = (pName, fNext) =>
												{
													let tmpLiteral = (pName === null) ? 'NULL' : `'${String(pName).replace(/'/g, '\'\'')}'`;
													sqlRows(_H, `UPDATE "Project" SET "Name" = ${tmpLiteral} WHERE "IDProject" = ${Number(tmpTarget.IDProject)}`, fNext);
												};
												fSetName('Renamed by the review test',
													(pUpdateError) =>
													{
														Expect(pUpdateError).to.not.exist;
														_H.records('Project', tmpBody, tmpLead,
															(pSecondError, pSecond) =>
															{
																fSetName(tmpName,
																	() =>
																	{
																		Expect(pSecond.Body.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(pFirst.Body.map((pRecord) => { return pRecord.IDProject; }));
																		Expect(pSecond.Body[0].Name).to.equal('Renamed by the review test');
																		Expect(pSecond.Headers.etag).to.not.equal(pFirst.Headers.etag);
																		return fDone(pSecondError);
																	});
															});
													});
											});
									});

								test('BindHash covers every value of a scope referenced twice with different Params',
									function (fDone)
									{
										let tmpLead = Object.assign({ Now: TEST_NOW }, _H.as('Lead'));
										let fBody = (pFirst, pSecond) =>
										{
											return { Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ pFirst ] } }, { Scope: 'Project.MyProjects', Params: { Roles: [ pSecond ] } } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] };
										};
										_H.query('Project', fBody('Owner', 'Lead'), tmpLead,
											(pError, pEnvelope, pMeta) =>
											{
												Expect(pError).to.not.exist;
												_H.query('Project', fBody('Member', 'Lead'), tmpLead,
													(pOtherError, pOtherEnvelope, pOtherMeta) =>
													{
														Expect(pOtherError).to.not.exist;
														Expect(pOtherMeta.BindHash).to.not.equal(pMeta.BindHash);
														_H.query('Project', fBody('Owner', 'Lead'), tmpLead,
															(pAgainError, pAgainEnvelope, pAgainMeta) =>
															{
																Expect(pAgainMeta.BindHash).to.equal(pMeta.BindHash);
																return fDone(pAgainError);
															});
													});
											});
									});

								test('unknown PathAuto FacetIDs are refused alike and never cached (bounded memory)',
									function (fDone)
									{
										let tmpRegistry = _H.fable.RetoldFacetingDefinitionRegistry;
										let tmpLead = _H.as('Lead');
										let tmpBefore = tmpRegistry._PathAuto.size;
										let tmpRequests = [];
										for (let i = 0; i < 50; i++)
										{
											let tmpFacets = [];
											for (let j = 0; j < 20; j++)
											{
												tmpFacets.push({ Key: `F${j}`, Facet: `Project.IDClient>Client.Bogus${i}x${j}` });
											}
											tmpRequests.push(tmpFacets);
										}
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpRequests.length)
											{
												Expect(tmpRegistry._PathAuto.size).to.equal(tmpBefore);
												// A real one is cached once.
												return _H.query('Project', { Facets: [ { Key: 'Real', Facet: 'Project.IDClient>Client.Name' } ] }, tmpLead,
													(pError, pEnvelope) =>
													{
														Expect(pEnvelope.Errors).to.deep.equal({});
														Expect(tmpRegistry._PathAuto.size).to.equal(tmpBefore + 1);
														return fDone(pError);
													});
											}
											_H.query('Project', { Facets: tmpRequests[pIndex], Total: true }, tmpLead,
												(pError, pEnvelope) =>
												{
													Expect(pError).to.not.exist;
													Expect(pEnvelope.Errors.F0).to.include({ Code: 'FACET_UNKNOWN_FACET', Status: 400 });
													return fNext(pIndex + 1);
												});
										};
										return fNext(0);
									});

								test('statement budget: E1 and E2 each run one cube statement plus one label read, with no cube fallback; hop probes use the correlation index',
									function (fDone)
									{
										let tmpBody =
											{
												Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
												Clauses:
													[
														{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
														{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: _H.traps.E1ClientIDs.slice(), FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' }
													],
												Facets:
													[
														{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
														{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
														{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
													],
												Total: true
											};
										let fRun = (fRunDone) =>
										{
											_H.query('Project', tmpBody, Object.assign({ Now: TEST_NOW }, _H.as('Lead')),
												(pError, pEnvelope, pMeta) =>
												{
													Expect(pError).to.not.exist;
													Expect(pEnvelope.Errors).to.deep.equal({});
													Expect(pMeta.CubeFallbacks).to.deep.equal([]);
													Expect(pMeta.Cubes).to.equal(1);
													Expect(pMeta.Labels).to.equal(1);
													Expect(pMeta.Statements, 'one cube statement + one Client label read').to.equal(2);
													return fRunDone();
												});
										};
										let fRunE2 = (fRunDone) =>
										{
											let tmpE2 =
												{
													Clauses:
														[
															{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ _H.traps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
															{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
														],
													Facets: [ { Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month' }, { Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 }, { Key: 'Status', Facet: 'Document.Status', Exclude: 'None' } ],
													Total: true
												};
											_H.query('Document', tmpE2, Object.assign({ Now: TEST_NOW }, _H.as('Lead')),
												(pError, pEnvelope, pMeta) =>
												{
													Expect(pError).to.not.exist;
													Expect(pEnvelope.Errors).to.deep.equal({});
													Expect(pMeta.CubeFallbacks).to.deep.equal([]);
													Expect(pMeta.Labels, 'the FormType label read').to.equal(1);
													Expect(pMeta.Statements, 'E2: one cube statement + one label read').to.equal(2);
													return fRunDone();
												});
										};
										if (pProvider.Provider !== 'SQLite')
										{
											return fRun(() => { return fRunE2(fDone); });
										}
										captureSQL(_H, (fCaptured) => { fRun(() => { return fRunE2(fCaptured); }); },
											(pError, pStatements) =>
											{
												// Every correlated hop probe searches the correlation index, never a scan nor the tenancy index.
												queryPlans(_H, pStatements).forEach(
													(pPlan) =>
													{
														pPlan.forEach(
															(pDetail) =>
															{
																Expect(pDetail, pDetail).to.not.match(/^SCAN (ProjectMembership|Task|Issue|Client)\b/);
																Expect(pDetail, pDetail).to.not.match(/SEARCH (ProjectMembership|Task|Issue) USING INDEX IX_\w+_IDCustomer/);
															});
													});
												return fDone(pError);
											});
									});

								test('O-hand SQL: HavingCount EQ, Not push-down and CheckParent forcing equal hand-written SQL (Live and Reference)',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let T = tmpLead.Tenant;
										let fCase = (pEntity, pScope, pSQL) =>
										{
											return (fNext) =>
											{
												sqlCount(_H, pSQL,
													(pSQLError, pExpected) =>
													{
														Expect(pSQLError).to.not.exist;
														_H.recordsCount(pEntity, { Scopes: [ { Scope: pScope } ] }, tmpLead,
															(pError, pResponse) =>
															{
																Expect(pResponse.Status, JSON.stringify(pResponse.Body)).to.equal(200);
																Expect(pResponse.Body.Count, `${pScope} Live`).to.equal(pExpected);
																_H.reference(pEntity, { Scopes: [ { Scope: pScope } ], Facets: [ { Key: 'Total', Facet: `${pEntity}.IDCustomer`, Fold: 'Missing' } ], Total: true }, Object.assign({ Now: TEST_NOW }, tmpLead),
																	(pReferenceError, pEnvelope) =>
																	{
																		Expect(pReferenceError).to.not.exist;
																		Expect(pEnvelope.Total, `${pScope} Reference`).to.equal(pExpected);
																		return fNext();
																	});
															});
													});
											};
										};
										series(
											[
												fCase('Project', 'Project.TwoOpenIssues',
													`SELECT count(*) AS "N" FROM "Project" "p" WHERE ${visible('p', T)}`
													+ ` AND (SELECT count(*) FROM "Issue" "i" WHERE ${visible('i', T)} AND "i"."IDProject" = "p"."IDProject" AND "i"."State" = 'Open') = 2`),
												fCase('Project', 'Project.NotDoneNorBlocked',
													`SELECT count(*) AS "N" FROM "Project" "p" WHERE ${visible('p', T)} AND "p"."Status" <> 'Done'`
													+ ` AND NOT EXISTS (SELECT 1 FROM "Issue" "i" WHERE ${visible('i', T)} AND "i"."IDProject" = "p"."IDProject" AND "i"."Severity" = 'Blocker')`),
												fCase('Task', 'Task.ProjectHasFinalDocs',
													`SELECT count(*) AS "N" FROM "Task" "t" WHERE ${visible('t', T)}`
													+ ` AND EXISTS (SELECT 1 FROM "Document" "d" WHERE ${visible('d', T)} AND "d"."IDProject" = "t"."IDProject" AND "d"."Status" = 'Final'`
													+ ` AND EXISTS (SELECT 1 FROM "Project" "pr" WHERE ${visible('pr', T)} AND "pr"."IDProject" = "d"."IDProject"))`)
											],
											fDone);
									});

								test('O-hand SQL: an ExternalJoinSelectedValueList clause equals hand-written SQL (both hops scoped)',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let T = tmpLead.Tenant;
										let tmpUsers = [ tmpLead.User, 2, 3 ];
										let tmpClause = { Type: 'ExternalJoinSelectedValueList', JoinTable: 'ProjectMembership', JoinTableCoreConnectionColumn: 'IDProject', JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User', Values: tmpUsers };
										sqlCount(_H, `SELECT count(*) AS "N" FROM "Project" "p" WHERE ${visible('p', T)}`
											+ ` AND EXISTS (SELECT 1 FROM "ProjectMembership" "m" WHERE ${visible('m', T)} AND "m"."IDProject" = "p"."IDProject"`
											+ ` AND EXISTS (SELECT 1 FROM "User" "u" WHERE ${visible('u', T)} AND "u"."IDUser" = "m"."IDUser" AND "u"."IDUser" IN (${tmpUsers.join(', ')})))`,
											(pSQLError, pExpected) =>
											{
												Expect(pSQLError).to.not.exist;
												Expect(pExpected).to.be.above(0);
												_H.recordsCount('Project', { Clauses: [ tmpClause ] }, tmpLead,
													(pError, pResponse) =>
													{
														Expect(pResponse.Status, JSON.stringify(pResponse.Body)).to.equal(200);
														Expect(pResponse.Body.Count).to.equal(pExpected);
														return fDone(pError);
													});
											});
									});
							}
						);

						// ======================================================== hidden join entities
						suite
						(
							'ProjectTrack with hidden entities (Catalog.NeverFacet)',
							() =>
							{
								let _H = null;
								suiteSetup((fDone) => { _H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider, Faceting: { Catalog: { NeverFacet: [ 'ProjectMembership', 'Client' ] } } }, fDone); });
								suiteTeardown((fDone) => { return _H ? _H.stop(() => { fDone(); }) : fDone(); });
								teardown(restoreAll);

								test('a hidden join table and a nonexistent one get the same 403 (no Detail) before any edge lookup',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										let fExternal = (pJoinTable, pColumn) =>
										{
											return { Clauses: [ { Type: 'ExternalJoinSelectedValueList', JoinTable: pJoinTable, JoinTableCoreConnectionColumn: pColumn, JoinTableExternalConnectionColumn: 'IDUser', ExternalFilterByTable: 'User', Values: [ 1 ] } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] };
										};
										let tmpBodies = [ fExternal('ProjectMembership', 'IDProject'), fExternal('NoSuchTable', 'IDProject'), fExternal('ProjectMembership', 'IDBogus'),
											{ Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', Values: [ 1 ] } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] },
											{ Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Nope', JoinInternalConnectionColumn: 'IDClient', Values: [ 1 ] } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' } ] } ];
										let tmpAnswers = [];
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpBodies.length)
											{
												tmpAnswers.forEach((pAnswer) => { Expect(pAnswer).to.deep.equal({ Status: 403, Body: tmpAnswers[0].Body }); });
												Expect(tmpAnswers[0].Body.Error).to.deep.equal({ Code: 'FACET_FORBIDDEN', Status: 403, Message: 'Forbidden.' });
												return fDone();
											}
											_H.facetQuery('Project', tmpBodies[pIndex], tmpLead,
												(pError, pResponse) =>
												{
													Expect(pError).to.not.exist;
													tmpAnswers.push({ Status: pResponse.Status, Body: pResponse.Body });
													return fNext(pIndex + 1);
												});
										};
										return fNext(0);
									});

								test('a PathAuto FacetID over a hidden target is the same 400 FACET_UNKNOWN_FACET as a path that does not exist',
									function (fDone)
									{
										let tmpLead = _H.as('Lead');
										_H.facetQuery('Project', { Facets: [ { Key: 'Hidden', Facet: 'Project.IDClient>Client.Name' }, { Key: 'Missing', Facet: 'Project.IDClient>Client.Nope' }, { Key: 'NoEdge', Facet: 'Project.Name>Client.Name' } ] }, tmpLead,
											(pError, pResponse) =>
											{
												Expect(pResponse.Status).to.equal(200);
												let tmpErrors = pResponse.Body.Errors;
												[ 'Hidden', 'Missing', 'NoEdge' ].forEach((pKey) => { Expect(tmpErrors[pKey], pKey).to.include({ Code: 'FACET_UNKNOWN_FACET', Status: 400 }); });
												Expect(Object.keys(tmpErrors.Hidden).sort()).to.deep.equal(Object.keys(tmpErrors.Missing).sort());
												return fDone(pError);
											});
									});
							}
						);

						// ======================================================== LabTrack
						suite
						(
							'LabTrack',
							() =>
							{
								let _H = null;
								suiteSetup((fDone) =>
								{
									_H = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Provider: pProvider.Provider, Faceting: { Definitions: { Objects: [ LAB_REVIEW_DEFINITIONS ] } } },
										(pError) =>
										{
											if (pError)
											{
												return fDone(pError);
											}
											Expect(_H.fable.RetoldFacetingDefinitionRegistry.disabled()).to.deep.equal([]);
											return fDone();
										});
								});
								suiteTeardown((fDone) => { return _H ? _H.stop(() => { fDone(); }) : fDone(); });
								teardown(restoreAll);

								test('a TuplePivot whose Home side is declared second answers exactly like E3B (Live == Reference)',
									function (fDone)
									{
										let fNext = (pNames, pIndex) =>
										{
											if (pIndex >= pNames.length)
											{
												return fDone();
											}
											let tmpPrincipal = Object.assign({ Now: TEST_NOW }, _H.as(pNames[pIndex]));
											let tmpBody = { Facets: [ { Key: 'Swapped', Facet: 'MaterialIntake.FormsToDoSwapped' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDoSwapped/ByQueue' }, { Key: 'E3B', Facet: 'MaterialIntake.FormsToDo' } ] };
											_H.compareInProcess('MaterialIntake', tmpBody, tmpPrincipal,
												(pError, pResult) =>
												{
													Expect(pError).to.not.exist;
													Expect(pResult.Live.Errors, pNames[pIndex]).to.deep.equal({});
													Expect(pResult.LiveNormalized, `${pNames[pIndex]}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
													let fCounts = (pFacet) => { return pFacet.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }); };
													Expect(fCounts(pResult.Live.Facets.Swapped)).to.deep.equal(fCounts(pResult.Live.Facets.E3B));
													Expect(pResult.Live.Facets.Swapped.Total).to.equal(pResult.Live.Facets.E3B.Total);
													Expect(pResult.Live.Facets.Swapped.CountMode).to.equal('KeyDistinct');
													return fNext(pNames, pIndex + 1);
												});
										};
										return fNext([ 'Tech', 'Colleague', 'OtherTech' ], 0);
									});

								test('statement budget and plans: E3A is one cube statement plus its label reads; LabForm probes use the correlation index',
									function (fDone)
									{
										let tmpBody =
											{
												Facets:
													[
														{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
														{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
														{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
													]
											};
										let fRun = (fRunDone) =>
										{
											_H.query('MaterialIntakeRequirement', tmpBody, Object.assign({ Now: TEST_NOW }, _H.as('Tech')),
												(pError, pEnvelope, pMeta) =>
												{
													Expect(pError).to.not.exist;
													Expect(pEnvelope.Errors).to.deep.equal({});
													Expect(pMeta.CubeFallbacks).to.deep.equal([]);
													Expect(pMeta.Cubes).to.equal(1);
													Expect(pMeta.Labels, 'LabFormType and LabQueue labels').to.equal(2);
													Expect(pMeta.Statements, 'one cube statement + the label reads').to.equal(1 + pMeta.Labels);
													return fRunDone();
												});
										};
										if (pProvider.Provider !== 'SQLite')
										{
											return fRun(fDone);
										}
										captureSQL(_H, fRun,
											(pError, pStatements) =>
											{
												let tmpPlans = queryPlans(_H, pStatements);
												let tmpLabForm = [];
												tmpPlans.forEach((pPlan) => { pPlan.forEach((pDetail) => { if (/LabForm\b/.test(pDetail)) { tmpLabForm.push(pDetail); } }); });
												Expect(tmpLabForm.length).to.be.above(0);
												tmpLabForm.forEach(
													(pDetail) =>
													{
														Expect(pDetail, pDetail).to.not.match(/^SCAN LabForm\b/);
														Expect(pDetail, pDetail).to.not.match(/USING INDEX IX_LabForm_IDCustomer/);
													});
												return fDone(pError);
											});
									});
							}
						);

						// ======================================================== the production DDL (PostgreSQL only)
						if (pProvider.Provider === 'PostgreSQL')
						{
							suite
							(
								'ProjectTrack and LabTrack on the production meadow DDL (BOOLEAN, NOT NULL defaults, ICU en-US collation)',
								() =>
								{
									let _Project = null;
									let _Lab = null;
									suiteSetup((fDone) =>
									{
										_Project = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider, PostgresSchema: 'Meadow' },
											(pError) =>
											{
												if (pError)
												{
													return fDone(pError);
												}
												_Lab = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Provider: pProvider.Provider, PostgresSchema: 'Meadow' }, fDone);
											});
									});
									suiteTeardown((fDone) =>
									{
										let fStopLab = () => { return _Lab ? _Lab.stop(() => { fDone(); }) : fDone(); };
										return _Project ? _Project.stop(fStopLab) : fStopLab();
									});
									teardown(restoreAll);

									let fConform = (pHarness, pEntity, pBody, pNames, fCheck, fDone) =>
									{
										let fNext = (pIndex) =>
										{
											if (pIndex >= pNames.length)
											{
												return fDone();
											}
											let tmpPrincipal = Object.assign({ Now: TEST_NOW }, pHarness.as(pNames[pIndex]));
											pHarness.compareInProcess(pEntity, pBody, tmpPrincipal,
												(pError, pResult) =>
												{
													Expect(pError, pNames[pIndex]).to.not.exist;
													Expect(pResult.Live.Errors, pNames[pIndex]).to.deep.equal({});
													Expect(pResult.LiveNormalized, `${pNames[pIndex]}: Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
													if (fCheck)
													{
														fCheck(pResult.Live);
													}
													pHarness.assertSelectionRoundTrip(pEntity, pBody, pResult.Live, tmpPrincipal,
														(pRoundTripError, pReport) =>
														{
															Expect(pRoundTripError, `${pNames[pIndex]} O2 ${JSON.stringify(pReport && pReport.Mismatches)}`).to.not.exist;
															return fNext(pIndex + 1);
														});
												});
										};
										return fNext(0);
									};

									test('the tables are the production DDL: BOOLEAN NOT NULL, NOT NULL defaults, ICU collation',
										function (fDone)
										{
											Expect(_Project.connection.Schema).to.equal('Meadow');
											sqlRows(_Project, 'SELECT "c"."table_name" AS "T", "c"."column_name" AS "C", "c"."data_type" AS "D", "c"."is_nullable" AS "N" FROM information_schema.columns "c" WHERE "c"."table_name" = \'ProjectMembership\'',
												(pError, pRows) =>
												{
													let tmpColumns = {};
													pRows.forEach((pRow) => { tmpColumns[pRow.C] = { Type: pRow.D, Nullable: pRow.N }; });
													Expect(tmpColumns.Deleted).to.deep.equal({ Type: 'boolean', Nullable: 'NO' });
													Expect(tmpColumns.Active).to.deep.equal({ Type: 'boolean', Nullable: 'NO' });
													Expect(tmpColumns.IDProject).to.deep.equal({ Type: 'integer', Nullable: 'NO' });
													Expect(tmpColumns.Role).to.deep.equal({ Type: 'character varying', Nullable: 'NO' });
													return fDone(pError);
												});
										});

									test('E1 and the coverage facets: O1 + O2 as Lead and OtherLead; Boolean Terms keys are the numbers 1 / 0',
										function (fDone)
										{
											let tmpE1 =
												{
													Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
													Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' } ],
													Facets:
														[
															{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
															{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
															{ Key: 'Members', Facet: 'Project.ByMember' }, { Key: 'Open', Facet: 'Project.HasOpenIssues' }
														],
													Total: true
												};
											let tmpMemberships = { FilterString: 'FBL~Role~INN~Owner,Lead', Facets: [ { Key: 'Active', Facet: 'ProjectMembership.Active' }, { Key: 'Role', Facet: 'ProjectMembership.Role' } ] };
											series(
												[
													(fNext) => { fConform(_Project, 'Project', tmpE1, [ 'Lead', 'OtherLead' ], null, fNext); },
													(fNext) =>
													{
														fConform(_Project, 'ProjectMembership', tmpMemberships, [ 'Lead' ],
															(pEnvelope) =>
															{
																let tmpKeys = pEnvelope.Facets.Active.Buckets.map((pBucket) => { return pBucket.Key; }).sort();
																Expect(tmpKeys).to.deep.equal([ 0, 1 ]);
															}, fNext);
													}
												],
												fDone);
										});

									test('E3A and E3B: O1 + O2 as Tech and OtherTech',
										function (fDone)
										{
											let tmpE3A = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' } ] };
											let tmpE3B = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Required', Facet: 'MaterialIntake.ByRequiredForm' } ] };
											series(
												[
													(fNext) => { fConform(_Lab, 'MaterialIntakeRequirement', tmpE3A, [ 'Tech', 'OtherTech' ], null, fNext); },
													(fNext) => { fConform(_Lab, 'MaterialIntake', tmpE3B, [ 'Tech', 'OtherTech' ], null, fNext); }
												],
												fDone);
										});

									test('Records sorted by a string column follow the database collation exactly like the list (ICU, not byte order)',
										function (fDone)
										{
											let tmpLead = _Project.as('Lead');
											// Mixed case and punctuation make the ICU order differ from byte order.
											sqlRows(_Project, 'UPDATE "Project" SET "Name" = CASE WHEN "IDProject" % 3 = 0 THEN lower("Name") WHEN "IDProject" % 3 = 1 THEN \'_\' || "Name" ELSE "Name" END',
												(pUpdateError) =>
												{
													Expect(pUpdateError).to.not.exist;
													_Project.listRows('Project', 'FSF~Name~ASC~0', tmpLead,
														(pListError, pList) =>
														{
															Expect(pListError).to.not.exist;
															_Project.records('Project', { Records: { Begin: 0, Cap: 500, Sort: [ { Field: 'Name', Dir: 'ASC' } ] } }, tmpLead,
																(pError, pResponse) =>
																{
																	Expect(pResponse.Status).to.equal(200);
																	let tmpNames = pResponse.Body.map((pRecord) => { return pRecord.Name; });
																	Expect(tmpNames).to.deep.equal(pList.map((pRecord) => { return pRecord.Name; }));
																	let tmpByteOrder = tmpNames.slice().sort((pA, pB) => { return (pA < pB) ? -1 : ((pA > pB) ? 1 : 0); });
																	Expect(tmpNames, 'the collation is not byte order').to.not.deep.equal(tmpByteOrder);
																	return fDone(pError);
																});
														});
												});
										});
								}
							);
						}

						// ======================================================== a personal-only LabForm
						suite
						(
							'LabTrack with LabForm excluded from the tenancy policy (its only policy column is the owner)',
							() =>
							{
								let _H = null;
								suiteSetup((fDone) =>
								{
									let tmpEntities = [ 'Customer', 'User', 'LabQueue', 'LabQueueMember', 'MaterialType', 'MaterialIntake', 'MaterialIntakeRequirement', 'MaterialTypeFormRequirement' ];
									_H = libHarness.start(
										{
											Port: PORT, Fixture: 'LabTrack', Provider: pProvider.Provider, TenancyEntities: tmpEntities,
											Faceting: { Scope: { Policy: { Exclude: [ 'LabFormType', 'LabForm' ] } } }
										}, fDone);
								});
								suiteTeardown((fDone) => { return _H ? _H.stop(() => { fDone(); }) : fDone(); });
								teardown(restoreAll);

								test('a TenantOnly step over it would read every tenant: the definitions using it are disabled at load (TenantOnlyNeedsTenant)',
									function (fDone)
									{
										let tmpRegistry = _H.fable.RetoldFacetingDefinitionRegistry;
										let tmpDisabled = tmpRegistry.disabled();
										let tmpReason = (pName) =>
										{
											let tmpEntry = tmpDisabled.find((pEntry) => { return pEntry.Name === pName; });
											return tmpEntry ? tmpEntry.Errors[0].Reason : null;
										};
										Expect(tmpReason('MaterialIntakeRequirement.ToDoForMe')).to.equal('TenantOnlyNeedsTenant');
										Expect(tmpReason('MaterialIntake.FormsToDo')).to.equal('TenantOnlyNeedsTenant');
										Expect(tmpReason('MaterialIntakeRequirement.MyFormsToDo')).to.equal('DependsOnDisabled');
										let tmpTech = _H.as('Tech');
										_H.scopeRecordsCount('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', {}, tmpTech,
											(pError, pResponse) =>
											{
												Expect(pResponse.Status).to.equal(400);
												Expect(pResponse.Body.Error.Code).to.equal('FACET_UNKNOWN_SCOPE');
												return fDone(pError);
											});
									});
							}
						);
					}
				);
			});
	}
);
