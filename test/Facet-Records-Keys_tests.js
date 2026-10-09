/**
 * Facet-Records-Keys (wiring; internal-contracts §28, §30.2, §34): the Records, Count and Keys
 * routes and in-process API.
 *
 *   - hydration replays the entity's list waterfall: every record equals the list's own record
 *     (shape and decorations), on a plain host (Bookstore) and on a scoped domain (ProjectTrack);
 *   - the pict-section-recordset FilterEndpointOverride shapes (POST …/Records/:Begin/:Cap and
 *     …/Records/Count with { Clauses, Experience }), the Query-body Records, the Keys route and the
 *     /Scope/:Scope/ forms (with the scope's parameters taken from the top-level Params);
 *   - ordering: multi-field Sort, NULLs last in both directions, the primary key the final tie-break;
 *   - limits and refusals: Cap / Begin / Keys Cap (400 { Field, Max }), an unknown sort field, an
 *     unknown or wrong-entity scope, bad parameters, a non-JSON body;
 *   - keys that no longer hydrate are dropped and counted (X-Retold-Facet-Records-Dropped);
 *   - Versions (ETag) per principal (BindHash) and If-None-Match 304; Keys truncation;
 *   - the in-process records / count / keys API equals the routes.
 *
 * SQLite always; PostgreSQL too when RFS_TEST_POSTGRES=1 (or RFS_TEST_POSTGRES_URL) is set.
 *
 * Port 19127 (internal-contracts §32.4); every harness binds an ephemeral port.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libPath = require('path');

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');

const PORT = 19127;

const POSTGRES = libProviders.available('PostgreSQL');

const PROVIDERS =
	[
		{ Provider: 'SQLite', Ready: true, Reason: null },
		{ Provider: 'PostgreSQL', Ready: POSTGRES.Available, Reason: POSTGRES.Reason }
	];

/**
 * Records keyed by their primary key (JSON round trip: what a client sees).
 *
 * @param {Array<Record<string, any>>} pRecords
 * @param {string} pPrimaryKey
 * @return {Map<string, Record<string, any>>}
 */
const byKey = (pRecords, pPrimaryKey) =>
{
	let tmpMap = new Map();
	(Array.isArray(pRecords) ? pRecords : []).forEach((pRecord) => { tmpMap.set(String(pRecord[pPrimaryKey]), JSON.parse(JSON.stringify(pRecord))); });
	return tmpMap;
};

/**
 * Compare two sort values for one field (NULLs last in both directions, internal-contracts §26.5).
 */
const compareField = (pA, pB, pDir) =>
{
	let tmpANull = (pA === null) || (typeof(pA) === 'undefined');
	let tmpBNull = (pB === null) || (typeof(pB) === 'undefined');
	if (tmpANull || tmpBNull)
	{
		return (tmpANull === tmpBNull) ? 0 : (tmpANull ? 1 : -1);
	}
	let tmpOrder = (pA < pB) ? -1 : ((pA > pB) ? 1 : 0);
	return (pDir === 'DESC') ? -tmpOrder : tmpOrder;
};

suite
(
	'Facet-Records-Keys',
	() =>
	{
		suite
		(
			'Definitions.Path loaded at attach (internal-contracts §20.1, §30.2)',
			function ()
			{
				this.timeout(60000);

				let _FromPath = null;
				let _Without = null;

				suiteSetup((fDone) =>
				{
					// Only the directory: every *.json directly under it, sorted (C-Broken.json is invalid JSON).
					_FromPath = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Definitions: false, Faceting: { Definitions: { Path: libPath.join(__dirname, 'fixtures', 'Definitions-Dir-Fixture') } } },
						(pError) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							_Without = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Definitions: false },
								(pWithoutError) =>
								{
									return fDone(pWithoutError || undefined);
								});
						});
				});

				suiteTeardown((fDone) =>
				{
					let fStopWithout = () => { return _Without ? _Without.stop(() => { fDone(); }) : fDone(); };
					return _FromPath ? _FromPath.stop(fStopWithout) : fStopWithout();
				});

				test('the scope of a Path file answers through the routes; the broken file is disabled whole; ModelVersion covers the definitions',
					function (fDone)
					{
						let tmpRegistry = _FromPath.fable.RetoldFacetingDefinitionRegistry;
						Expect(tmpRegistry.status()).to.include({ Scopes: 1, Aliases: 1 });
						Expect(tmpRegistry.disabled().map((pEntry) => { return pEntry.Kind; })).to.deep.equal([ 'File' ]);
						let tmpLead = _FromPath.as('Lead');
						let tmpTasks = _FromPath.visibleRows('Task', tmpLead).filter((pTask) => { return (typeof(pTask.Status) === 'string') && (pTask.Status !== 'Done'); });
						let tmpExpected = _FromPath.visibleRows('Project', tmpLead).filter((pProject) => { return tmpTasks.some((pTask) => { return pTask.IDProject === pProject.IDProject; }); }).length;
						_FromPath.scopeRecordsCount('Project', 'Project.HasOpenTasks', {}, tmpLead,
							(pError, pCount) =>
							{
								Expect(pCount.Status, JSON.stringify(pCount.Body)).to.equal(200);
								Expect(pCount.Body.Count).to.equal(tmpExpected);
								_FromPath.request('GET', '/1.0/Facet/Project/Describe', null, tmpLead,
									(pDescribeError, pDescribe) =>
									{
										_Without.request('GET', '/1.0/Facet/Project/Describe', null, tmpLead,
											(pWithoutError, pWithout) =>
											{
												Expect(pDescribe.Body.Entities.Project.Scopes.map((pScope) => { return pScope.Scope; })).to.deep.equal([ 'Project.HasOpenTasks' ]);
												Expect(pWithout.Body.Entities.Project.Scopes).to.deep.equal([]);
												Expect(pDescribe.Body.ModelVersion).to.not.equal(pWithout.Body.ModelVersion);
												// Without the file the scope is unknown (400), never an unfiltered answer.
												_Without.scopeRecordsCount('Project', 'Project.HasOpenTasks', {}, tmpLead,
													(pUnknownError, pUnknown) =>
													{
														Expect(pUnknown.Status).to.equal(400);
														Expect(pUnknown.Body.Error.Code).to.equal('FACET_UNKNOWN_SCOPE');
														return fDone();
													});
											});
									});
							});
					});
			}
		);

		PROVIDERS.forEach(
			(pProvider) =>
			{
				(pProvider.Ready ? suite : suite.skip)
				(
					`${pProvider.Provider}${pProvider.Ready ? '' : ` (skipped: ${pProvider.Reason})`}`,
					function ()
					{
						this.timeout(120000);

						let _Bookstore = null;
						let _ProjectTrack = null;

						suiteSetup((fDone) =>
						{
							_Bookstore = libHarness.start({ Port: PORT, Fixture: 'Bookstore', Provider: pProvider.Provider },
								(pError) =>
								{
									if (pError)
									{
										return fDone(pError);
									}
									_ProjectTrack = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider },
										(pProjectError) =>
										{
											return fDone(pProjectError || undefined);
										});
								});
						});

						suiteTeardown((fDone) =>
						{
							let fStopProject = () => { return _ProjectTrack ? _ProjectTrack.stop(() => { fDone(); }) : fDone(); };
							return _Bookstore ? _Bookstore.stop(fStopProject) : fStopProject();
						});

						suite
						(
							'Hydration through the list waterfall',
							() =>
							{
								test('Bookstore (no policy): every record of the pict page form equals the list\'s record; plan order is the primary key; Count equals the list Count',
									function (fDone)
									{
										let tmpClauses = [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash' ], FilterKey: 'PaymentMethod' } ];
										let tmpFilter = _Bookstore.toFilterString('BookStoreSale', { Clauses: tmpClauses });
										_Bookstore.listRows('BookStoreSale', tmpFilter, {},
											(pListError, pList) =>
											{
												Expect(pListError).to.not.exist;
												let tmpList = byKey(pList, 'IDBookStoreSale');
												let tmpExpectedKeys = Array.from(tmpList.keys()).map(Number).sort((pA, pB) => { return pA - pB; });
												_Bookstore.recordsPage('BookStoreSale', 40, 25, { Clauses: tmpClauses, Experience: { ResultDestinationAddress: 'AppData.Sales' } }, {},
													(pError, pPage) =>
													{
														Expect(pPage.Status, JSON.stringify(pPage.Body)).to.equal(200);
														Expect(pPage.Headers.etag).to.match(/^W\/"fv1:[0-9a-f]{16}"$/);
														Expect(pPage.Headers['x-retold-facet-contract']).to.equal('1');
														Expect(pPage.Headers).to.not.have.property('x-retold-facet-records-dropped');
														Expect(pPage.Body.map((pRecord) => { return pRecord.IDBookStoreSale; })).to.deep.equal(tmpExpectedKeys.slice(40, 65));
														pPage.Body.forEach((pRecord) => { Expect(JSON.parse(JSON.stringify(pRecord))).to.deep.equal(tmpList.get(String(pRecord.IDBookStoreSale))); });
														_Bookstore.recordsCount('BookStoreSale', { Clauses: tmpClauses, Experience: {} }, {},
															(pCountError, pCount) =>
															{
																Expect(pCount.Status).to.equal(200);
																Expect(pCount.Body).to.deep.equal({ Count: tmpExpectedKeys.length });
																_Bookstore.listCount('BookStoreSale', tmpFilter, {},
																	(pListCountError, pListCount) =>
																	{
																		Expect(pListCount).to.equal(tmpExpectedKeys.length);
																		return fDone();
																	});
															});
													});
											});
									});

								test('ProjectTrack as Lead: every hydrated record equals the scoped list\'s record (tenancy behavior, explicit soft delete)',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										_ProjectTrack.listRows('Project', null, tmpLead,
											(pListError, pList) =>
											{
												Expect(pListError).to.not.exist;
												let tmpList = byKey(pList, 'IDProject');
												_ProjectTrack.records('Project', { Records: { Begin: 0, Cap: 500 } }, tmpLead,
													(pError, pRecords) =>
													{
														Expect(pRecords.Status).to.equal(200);
														Expect(pRecords.Body.length).to.equal(tmpList.size);
														pRecords.Body.forEach(
															(pRecord) =>
															{
																Expect(pRecord.IDCustomer).to.equal(tmpLead.Tenant);
																Expect(JSON.parse(JSON.stringify(pRecord))).to.deep.equal(tmpList.get(String(pRecord.IDProject)));
															});
														return fDone();
													});
											});
									});

								test('keys that no longer hydrate are dropped and counted (X-Retold-Facet-Records-Dropped, RecordsDropped)',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										let tmpDropping = null;
										// A Reads-PostOperation that hides one record (as a row that moved between the key
										// statement and the hydration would be): the page loses it and says so.  The host
										// vouches for it (Scope.TrustPostOperation, 06 §3.5); without that the entity is
										// Opaque (Facet-Security-M2 covers the refusal).
										let tmpFunctions = _ProjectTrack.fable.MeadowEndpoints.Project.controller.BehaviorInjection._BehaviorFunctions;
										let tmpOriginalPost = tmpFunctions['Reads-PostOperation'];
										let tmpTrust = _ProjectTrack.faceting.options.Scope.TrustPostOperation;
										_ProjectTrack.faceting.options.Scope.TrustPostOperation = [ 'Project' ];
										let fRestore = () =>
										{
											_ProjectTrack.faceting.options.Scope.TrustPostOperation = tmpTrust;
											if (typeof(tmpOriginalPost) === 'function')
											{
												tmpFunctions['Reads-PostOperation'] = tmpOriginalPost;
											}
											else
											{
												delete tmpFunctions['Reads-PostOperation'];
											}
										};
										_ProjectTrack.installBehavior('Project', 'Reads-PostOperation',
											function (pRequest, pRequestState, fCallback)
											{
												if ((tmpDropping !== null) && Array.isArray(pRequestState.Records))
												{
													pRequestState.Records = pRequestState.Records.filter((pRecord) => { return pRecord.IDProject !== tmpDropping; });
												}
												return fCallback();
											});
										_ProjectTrack.records('Project', { Records: { Begin: 0, Cap: 10 } }, tmpLead,
											(pError, pFull) =>
											{
												Expect(pFull.Status).to.equal(200);
												tmpDropping = pFull.Body[3].IDProject;
												_ProjectTrack.records('Project', { Records: { Begin: 0, Cap: 10 } }, tmpLead,
													(pDroppedError, pDropped) =>
													{
														Expect(pDropped.Status).to.equal(200);
														Expect(pDropped.Headers['x-retold-facet-records-dropped']).to.equal('1');
														Expect(pDropped.Body.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(pFull.Body.map((pRecord) => { return pRecord.IDProject; }).filter((pID) => { return pID !== tmpDropping; }));
														Expect(pDropped.Headers.etag).to.not.equal(pFull.Headers.etag);
														_ProjectTrack.facetQuery('Project', { Facets: [ { Facet: 'Project.Status' } ], Records: { Begin: 0, Cap: 10 } }, tmpLead,
															(pQueryError, pQuery) =>
															{
																tmpDropping = null;
																fRestore();
																Expect(pQuery.Status).to.equal(200);
																Expect(pQuery.Body.RecordsDropped).to.equal(1);
																Expect(pQuery.Body.Records.length).to.equal(9);
																return fDone();
															});
													});
											});
									});
							}
						);

						suite
						(
							'Ordering, the Query body and Keys',
							() =>
							{
								test('multi-field Sort: NULLs last in both directions, the primary key last; the Query-body Records equal the Records route',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										let tmpSort = [ { Field: 'Status', Dir: 'DESC' }, { Field: 'StartDate', Dir: 'ASC' } ];
										_ProjectTrack.records('Project', { Records: { Begin: 0, Cap: 500, Sort: tmpSort } }, tmpLead,
											(pError, pRecords) =>
											{
												Expect(pRecords.Status).to.equal(200);
												let tmpRows = _ProjectTrack.visibleRows('Project', tmpLead).slice();
												tmpRows.sort(
													(pA, pB) =>
													{
														return compareField(pA.Status, pB.Status, 'DESC') || compareField(pA.StartDate, pB.StartDate, 'ASC') || (pA.IDProject - pB.IDProject);
													});
												Expect(pRecords.Body.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(tmpRows.map((pRow) => { return pRow.IDProject; }));
												_ProjectTrack.facetQuery('Project', { Facets: [ { Facet: 'Project.Status' } ], Records: { Begin: 5, Cap: 12, Sort: tmpSort } }, tmpLead,
													(pQueryError, pQuery) =>
													{
														Expect(pQuery.Status).to.equal(200);
														Expect(pQuery.Body.RecordShape).to.equal('Entity');
														Expect(pQuery.Body.Records.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(tmpRows.slice(5, 17).map((pRow) => { return pRow.IDProject; }));
														return fDone();
													});
											});
									});

								test('Keys: ordered by the key, Count of the full filter, Truncated past Cap; the in-process API equals the routes',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										let tmpBody = { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk', 'OnHold' ] } ] };
										let tmpExpected = _ProjectTrack.visibleRows('Project', tmpLead).filter((pRow) => { return [ 'Active', 'AtRisk', 'OnHold' ].indexOf(pRow.Status) >= 0; }).map((pRow) => { return pRow.IDProject; }).sort((pA, pB) => { return pA - pB; });
										_ProjectTrack.keys('Project', Object.assign({ Cap: 3 }, tmpBody), tmpLead,
											(pError, pKeys) =>
											{
												Expect(pKeys.Status).to.equal(200);
												Expect(pKeys.Body).to.deep.include({ Entity: 'Project', Keys: tmpExpected.slice(0, 3), Count: tmpExpected.length, Truncated: true });
												Expect(pKeys.Headers.etag).to.equal(`W/"${pKeys.Body.Version}"`);
												let tmpRequest = libHarness.syntheticRequest('Project', tmpLead, tmpBody);
												_ProjectTrack.faceting.keys('Project', tmpBody, tmpRequest,
													(pInProcessError, pInProcess) =>
													{
														Expect(pInProcessError).to.not.exist;
														Expect(pInProcess).to.include({ Entity: 'Project', Count: tmpExpected.length, Truncated: false });
														Expect(pInProcess.Keys).to.deep.equal(tmpExpected);
														_ProjectTrack.faceting.count('Project', tmpBody, tmpRequest,
															(pCountError, pCount, pCountMeta) =>
															{
																Expect(pCount).to.deep.equal({ Count: tmpExpected.length });
																Expect(pCountMeta.Version).to.match(/^fv1:/);
																_ProjectTrack.faceting.records('Project', Object.assign({ Records: { Begin: 0, Cap: 4 } }, tmpBody), tmpRequest,
																	(pRecordsError, pRecords, pRecordsMeta) =>
																	{
																		Expect(pRecordsError).to.not.exist;
																		Expect(pRecords.map((pRecord) => { return pRecord.IDProject; })).to.deep.equal(tmpExpected.slice(0, 4));
																		Expect(pRecordsMeta).to.include({ Dropped: 0 });
																		Expect(pRecordsMeta.Keys).to.deep.equal(tmpExpected.slice(0, 4));
																		return fDone();
																	});
															});
													});
											});
									});

								test('ETags: stable for one principal, different across principals of one tenant (BindHash), If-None-Match 304',
									function (fDone)
									{
										let tmpBody = { Clauses: [], Experience: {} };
										_ProjectTrack.scopeRecordsCount('Project', 'Project.MyProjects', tmpBody, _ProjectTrack.as('Lead'),
											(pError, pLead) =>
											{
												_ProjectTrack.scopeRecordsCount('Project', 'Project.MyProjects', tmpBody, _ProjectTrack.as('Member'),
													(pMemberError, pMember) =>
													{
														Expect(pLead.Status).to.equal(200);
														Expect(pMember.Status).to.equal(200);
														Expect(pLead.Headers.etag).to.not.equal(pMember.Headers.etag);
														_ProjectTrack.request('POST', '/1.0/Facet/Project/Scope/Project.MyProjects/Records/0/20', tmpBody, Object.assign({ Headers: { 'If-None-Match': 'W/"fv1:0000000000000000"' } }, _ProjectTrack.as('Lead')),
															(pPageError, pPage) =>
															{
																Expect(pPage.Status).to.equal(200);
																_ProjectTrack.request('POST', '/1.0/Facet/Project/Scope/Project.MyProjects/Records/0/20', tmpBody, Object.assign({ Headers: { 'If-None-Match': pPage.Headers.etag } }, _ProjectTrack.as('Lead')),
																	(pAgainError, pAgain) =>
																	{
																		Expect(pAgain.Status).to.equal(304);
																		return fDone();
																	});
															});
													});
											});
									});
							}
						);

						suite
						(
							'Named-scope route forms',
							() =>
							{
								test('/Scope/:Scope/ takes the scope\'s parameters from the top-level Params; the default applies without them',
									function (fDone)
									{
										let tmpMember = _ProjectTrack.as('Member');
										let tmpRows = _ProjectTrack.visibleRows('Project', tmpMember);
										let tmpMemberships = _ProjectTrack.visibleRows('ProjectMembership', tmpMember);
										let fMine = (pRoles) =>
										{
											return tmpRows.filter(
												(pProject) =>
												{
													return (pProject.OwnerIDUser === tmpMember.User) || tmpMemberships.some((pMembership) => { return (pMembership.IDProject === pProject.IDProject) && (pMembership.IDUser === tmpMember.User) && (pMembership.Active === 1) && (pRoles.indexOf(pMembership.Role) >= 0); });
												}).length;
										};
										_ProjectTrack.scopeRecordsCount('Project', 'Project.MyProjects', { Params: { Roles: [ 'Reviewer' ] } }, tmpMember,
											(pError, pReviewer) =>
											{
												Expect(pReviewer.Status, JSON.stringify(pReviewer.Body)).to.equal(200);
												Expect(pReviewer.Body.Count).to.equal(fMine([ 'Reviewer' ]));
												_ProjectTrack.scopeRecordsCount('Project', 'Project.MyProjects', {}, tmpMember,
													(pDefaultError, pDefault) =>
													{
														Expect(pDefault.Status).to.equal(200);
														Expect(pDefault.Body.Count).to.equal(fMine([ 'Owner', 'Lead', 'Member' ]));
														Expect(pDefault.Body.Count).to.not.equal(pReviewer.Body.Count);
														// The same scope as a NamedScope clause through the plain Records route.
														_ProjectTrack.recordsCount('Project', { Clauses: [ { Type: 'NamedScope', Scope: 'Project.MyProjects', Params: { Roles: [ 'Reviewer' ] } } ] }, tmpMember,
															(pClauseError, pClause) =>
															{
																Expect(pClause.Status).to.equal(200);
																Expect(pClause.Body.Count).to.equal(pReviewer.Body.Count);
																return fDone();
															});
													});
											});
									});

								test('refusals: unknown or wrong-entity scope 400, a bad parameter 400 (never its value), an undeclared parameter 400',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										_ProjectTrack.scopeRecordsCount('Project', 'Project.NoSuchScope', {}, tmpLead,
											(pError, pUnknown) =>
											{
												Expect(pUnknown.Status).to.equal(400);
												Expect(pUnknown.Body.Error.Code).to.equal('FACET_UNKNOWN_SCOPE');
												_ProjectTrack.scopeRecordsCount('Document', 'Project.MyProjects', {}, tmpLead,
													(pWrongError, pWrong) =>
													{
														Expect(pWrong.Status).to.equal(400);
														Expect(pWrong.Body.Error.Code).to.equal('FACET_UNKNOWN_SCOPE');
														_ProjectTrack.scopeRecordsCount('Project', 'Project.MyProjects', { Params: { Roles: [ 'Overlord' ] } }, tmpLead,
															(pParamError, pParam) =>
															{
																Expect(pParam.Status).to.equal(400);
																Expect(pParam.Body.Error.Code).to.equal('FACET_PARAM_INVALID');
																Expect(pParam.Body.Error.Detail).to.include({ Scope: 'Project.MyProjects', Param: 'Roles', Reason: 'NotAllowed' });
																Expect(JSON.stringify(pParam.Body)).to.not.include('Overlord');
																_ProjectTrack.scopeRecordsCount('Project', 'Project.Unblocked', { Params: { Roles: [ 'Owner' ] } }, tmpLead,
																	(pUndeclaredError, pUndeclared) =>
																	{
																		Expect(pUndeclared.Status).to.equal(400);
																		Expect(pUndeclared.Body.Error.Code).to.equal('FACET_PARAM_INVALID');
																		Expect(pUndeclared.Body.Error.Detail).to.include({ Param: 'Roles', Reason: 'Unknown' });
																		return fDone();
																	});
															});
													});
											});
									});
							}
						);

						suite
						(
							'Limits and refusals',
							() =>
							{
								test('page and Keys limits are 400 { Field, Max }; an unknown sort field is 400; the body must be JSON',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										let tmpCases =
											[
												[ 'POST', '/1.0/Facet/Project/Records/0/501', {}, 400, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 500 } ],
												[ 'POST', '/1.0/Facet/Project/Records/10001/10', {}, 400, 'FACET_REQUEST_INVALID', { Field: 'Begin', Max: 10000 } ],
												[ 'POST', '/1.0/Facet/Project/Records/x/10', {}, 400, 'FACET_REQUEST_INVALID', { Field: 'Begin' } ],
												[ 'POST', '/1.0/Facet/Project/Records/0/0', {}, 400, 'FACET_REQUEST_INVALID', { Field: 'Cap' } ],
												[ 'POST', '/1.0/Facet/Project/Records', { Records: { Cap: 10, Sort: [ { Field: 'NoSuchColumn' } ] } }, 400, 'FACET_UNKNOWN_FIELD', { Field: 'NoSuchColumn' } ],
												[ 'POST', '/1.0/Facet/Project/Records', { Records: { Sort: [ { Field: 'Status', Dir: 'Sideways' } ] } }, 400, 'FACET_REQUEST_INVALID', { Field: 'Sort' } ],
												[ 'POST', '/1.0/Facet/Project/Keys', { Cap: 50001 }, 400, 'FACET_REQUEST_INVALID', { Field: 'Cap', Max: 50000 } ],
												[ 'POST', '/1.0/Facet/NoSuchEntity/Records/0/10', {}, 404, 'FACET_UNKNOWN_ENTITY', null ],
												[ 'POST', '/1.0/Facet/Project/Records', { Selections: [ { Facet: 'Project.Status', Keys: [ 'Active' ] } ] }, 422, 'FACET_FOLD_UNSUPPORTED', { Feature: 'Selections', Milestone: 2 } ]
											];
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpCases.length)
											{
												// A non-JSON body is refused before it is read (the route-local reader of M1).
												let tmpHeaders = { 'content-type': 'text/plain' };
												tmpHeaders[libHarness.TENANT_HEADER] = String(tmpLead.Tenant);
												tmpHeaders[libHarness.USER_HEADER] = String(tmpLead.User);
												return fetch(`${_ProjectTrack.baseURL}/1.0/Facet/Project/Records/0/10`, { method: 'POST', headers: tmpHeaders, body: 'Clauses=' })
													.then((pResponse) => { return pResponse.json().then((pBody) => { return { Status: pResponse.status, Body: pBody }; }); })
													.then(
														(pResponse) =>
														{
															setImmediate(
																() =>
																{
																	Expect(pResponse.Status).to.equal(400);
																	Expect(pResponse.Body.Error.Detail).to.deep.equal({ Reason: 'UnsupportedContentType' });
																	return fDone();
																});
														},
														(pError) =>
														{
															setImmediate(() => { fDone(pError); });
														});
											}
											let tmpCase = tmpCases[pIndex];
											_ProjectTrack.request(tmpCase[0], tmpCase[1], tmpCase[2], tmpLead,
												(pError, pResponse) =>
												{
													Expect(pResponse.Status, `${tmpCase[1]} ${JSON.stringify(tmpCase[2])}`).to.equal(tmpCase[3]);
													Expect(pResponse.Body.Error.Code, tmpCase[1]).to.equal(tmpCase[4]);
													if (tmpCase[5])
													{
														Expect(pResponse.Body.Error.Detail, tmpCase[1]).to.include(tmpCase[5]);
													}
													return fNext(pIndex + 1);
												});
										};
										return fNext(0);
									});

								test('anonymous on a policy host is 401 on every Records / Count / Keys route, whatever the entity',
									function (fDone)
									{
										let tmpPaths = [ '/1.0/Facet/Project/Records/0/10', '/1.0/Facet/Project/Records/Count', '/1.0/Facet/Project/Keys', '/1.0/Facet/NoSuchEntity/Records', '/1.0/Facet/Project/Scope/Project.MyProjects/Records/Count' ];
										let tmpBodies = [];
										let fNext = (pIndex) =>
										{
											if (pIndex >= tmpPaths.length)
											{
												tmpBodies.forEach((pBody) => { Expect(pBody).to.deep.equal(tmpBodies[0]); });
												return fDone();
											}
											_ProjectTrack.request('POST', tmpPaths[pIndex], {}, {},
												(pError, pResponse) =>
												{
													Expect(pResponse.Status, tmpPaths[pIndex]).to.equal(401);
													tmpBodies.push(pResponse.Body);
													return fNext(pIndex + 1);
												});
										};
										return fNext(0);
									});
							}
						);
					}
				);
			});
	}
);
